import { NextRequest } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import connectDB from '@/lib/mongoose';
import mongoose from 'mongoose';
import Agent from '@/models/Agent';
import ChatSession from '@/models/ChatSession';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || '',
});

function buildSystemPrompt(context: {
  agentName: string;
  positions: any[];
  followedTraders: any[];
  portfolioSummary: any;
  tokens: any[];
  tokensTotalUsd: number;
}) {
  const { agentName, positions, followedTraders, portfolioSummary, tokens, tokensTotalUsd } = context;

  const positionSummary = positions.length > 0
    ? positions.map(p => {
        if (p.type === 'PERP') {
          return `- ${p.pair} ${p.direction} ${p.leverage}x on ${p.platform} | Size: $${p.positionSize} | PnL: $${p.pnl} (${p.roi}%)`;
        }
        if (p.type === 'PREDICTION') {
          return `- PM: ${p.market} | ${p.outcome} | Size: ${p.size} shares | Value: $${p.currentValue}`;
        }
        return `- ${p.pair || p.market || 'Unknown'} on ${p.platform}`;
      }).join('\n')
    : 'No open positions detected.';

  const traderSummary = followedTraders.length > 0
    ? followedTraders.map(t => {
        const wr = t.winRate <= 1 ? (t.winRate * 100).toFixed(0) : t.winRate.toFixed(0);
        const reason = t.matchReason ? ` | Why: ${t.matchReason}` : '';
        return `- ${t.username || t.wallet.slice(0, 10)} (${t.platform}) | 30d PnL: $${t.pnl30d.toLocaleString()} | Win Rate: ${wr}%${reason}`;
      }).join('\n')
    : 'No traders followed yet.';

  const tokenSummary = tokens.length > 0
    ? tokens.map(t => `- ${t.symbol} on ${t.chain}: ${t.balance} ($${t.usdValue?.toFixed(2) || '?'})`).join('\n')
    : 'No tokens detected.';

  const totalPortfolioValue = (portfolioSummary?.totalValue || 0) + tokensTotalUsd;

  return `You are ${agentName}, an AI trading agent on the Yieldr platform. You help users analyze their positions, track top traders, and understand market conditions.

## Your Capabilities
- Analyze the user's open positions and provide insights
- Track followed traders and explain their strategies
- Discuss market conditions, trading strategies, and risk management
- Provide educational content about DeFi, perpetuals, and prediction markets
- Alert about position risks (high leverage, concentrated positions, etc.)
- Analyze token holdings across multiple chains

## User's Portfolio
Total Value: $${totalPortfolioValue.toFixed(2)}
Position Count: ${portfolioSummary?.positionCount || 0}
Token Holdings: $${tokensTotalUsd.toFixed(2)} across ${tokens.length} tokens

### Open Positions
${positionSummary}

### Token Holdings
${tokenSummary}

### Followed Traders
${traderSummary}

## Guidelines
- Be concise and direct. Use short paragraphs.
- Use numbers and data when available.
- If asked about real-time prices or news you don't have, say you'll need web search integration (coming soon).
- Never give financial advice. Frame insights as analysis, not recommendations.
- Use $ for USD amounts. Use % for percentages.
- When discussing risk, be specific about what the risk is and why.
- You can reference the user's actual positions and traders shown above.
- Keep responses under 200 words unless the user asks for detailed analysis.`;
}

export async function POST(request: NextRequest) {
  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      return new Response(
        JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const { messages, wallet, sessionId } = await request.json();

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return new Response(
        JSON.stringify({ error: 'Messages array required' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Fetch user context from DB
    await connectDB();
    const db = mongoose.connection.db;
    let positions: any[] = [];
    let followedTraders: any[] = [];
    let portfolioSummary: any = {};
    let agentName = 'YieldrAgent';
    let tokens: any[] = [];
    let tokensTotalUsd = 0;

    if (db && wallet) {
      const [agent, positionDocs] = await Promise.all([
        Agent.findOne({ ownerWallet: wallet.toLowerCase() }),
        db.collection('positions').find({ walletAddress: wallet.toLowerCase() }).toArray(),
      ]);

      if (agent) {
        agentName = agent.name || agentName;
        followedTraders = agent.followedTraders || [];
        portfolioSummary = agent.portfolioSummary || {};
      }

      // Fetch token balances
      try {
        const tokenApiUrl = `${process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'}/api/demo/tokens?address=${wallet}`;
        const tokenRes = await fetch(tokenApiUrl);
        if (tokenRes.ok) {
          const tokenData = await tokenRes.json();
          if (tokenData.success && tokenData.data) {
            tokens = tokenData.data.tokens || [];
            tokensTotalUsd = tokenData.data.totalUsdValue || 0;
          }
        }
      } catch (e) {
        console.log('[chat] Token fetch for context failed:', (e as Error).message);
      }
      positions = positionDocs || [];
    }

    const systemPrompt = buildSystemPrompt({
      agentName,
      positions,
      followedTraders,
      portfolioSummary,
      tokens,
      tokensTotalUsd,
    });

    // Convert messages to Anthropic format
    const anthropicMessages = messages.map((m: { role: string; content: string }) => ({
      role: m.role === 'agent' ? 'assistant' as const : 'user' as const,
      content: m.content,
    }));

    // Get the last user message for saving
    const lastUserMessage = messages[messages.length - 1];

    // Stream response
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        let fullResponse = '';
        try {
          const response = await anthropic.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 1024,
            system: systemPrompt,
            messages: anthropicMessages,
            stream: true,
          });

          for await (const event of response) {
            if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
              fullResponse += event.delta.text;
              const chunk = JSON.stringify({ type: 'text', text: event.delta.text }) + '\n';
              controller.enqueue(encoder.encode(chunk));
            }
          }

          // Save messages to chat session
          if (wallet && fullResponse) {
            try {
              await connectDB();
              const newMessages = [
                { role: 'user' as const, content: lastUserMessage.content, timestamp: new Date() },
                { role: 'agent' as const, content: fullResponse, timestamp: new Date() },
              ];

              if (sessionId) {
                // Append to existing session
                await ChatSession.findByIdAndUpdate(sessionId, {
                  $push: { messages: { $each: newMessages } },
                  $set: { updatedAt: new Date() },
                });
              } else {
                // Create new session with title from first user message
                const title = lastUserMessage.content.slice(0, 100);
                const session = await ChatSession.create({
                  walletAddress: wallet.toLowerCase(),
                  title,
                  messages: newMessages,
                });
                // Send session ID back to client
                controller.enqueue(encoder.encode(
                  JSON.stringify({ type: 'session', sessionId: session._id.toString() }) + '\n'
                ));
              }
            } catch (saveErr) {
              console.error('[chat] Failed to save chat session:', saveErr);
            }
          }

          controller.enqueue(encoder.encode(JSON.stringify({ type: 'done' }) + '\n'));
          controller.close();
        } catch (err: any) {
          const errorMsg = JSON.stringify({ type: 'error', error: err.message }) + '\n';
          controller.enqueue(encoder.encode(errorMsg));
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Transfer-Encoding': 'chunked',
      },
    });
  } catch (error: any) {
    console.error('Chat API error:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
