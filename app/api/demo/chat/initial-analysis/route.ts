import { NextRequest } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import connectDB from '@/lib/mongoose';
import mongoose from 'mongoose';
import Agent from '@/models/Agent';
import ChatSession from '@/models/ChatSession';
import { trackUsage, TokenUsageData } from '@/lib/tokenTracking';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || '',
});

/**
 * POST /api/demo/chat/initial-analysis
 * Generates the first agent message by analyzing user positions + matched traders.
 * Called automatically when the chat page loads (replaces hardcoded greeting).
 * Streams the response so the user sees it typing out.
 *
 * Body: { wallet: string }
 */
export async function POST(request: NextRequest) {
  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      return new Response(
        JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const { wallet } = await request.json();
    if (!wallet) {
      return new Response(
        JSON.stringify({ error: 'Wallet address required' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const walletLower = wallet.toLowerCase();
    console.log(`[initial-analysis] Starting for wallet: ${walletLower}`);

    await connectDB();
    const db = mongoose.connection.db;
    if (!db) {
      return new Response(
        JSON.stringify({ error: 'DB not connected' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Fetch agent and positions in parallel
    const [agent, positions] = await Promise.all([
      Agent.findOne({ ownerWallet: walletLower }),
      db.collection('positions').find({ walletAddress: walletLower }).toArray(),
    ]);

    const agentName = agent?.name || 'YieldrAgent';
    const followedTraders = agent?.followedTraders || [];
    const portfolioSummary = agent?.portfolioSummary || {};

    // Use cached tokens from agent (fetched once during onboarding)
    const tokenList = agent?.cachedTokenBalances || [];
    const tokensTotalUsd = agent?.cachedTokensTotalUsd || 0;

    const perpPositions = positions.filter(p => p.type === 'PERP');
    const pmPositions = positions.filter(p => p.type === 'PREDICTION');

    console.log(`[initial-analysis] Context: ${perpPositions.length} perps, ${pmPositions.length} PM, ${tokenList.length} tokens, ${followedTraders.length} traders`);

    // If user has no positions at all, return a simple welcome (no LLM call needed)
    if (perpPositions.length === 0 && pmPositions.length === 0 && tokenList.length === 0) {
      console.log(`[initial-analysis] No positions found, streaming static welcome`);
      const emptyWalletMessage = `👋 Hey — I'm ${agentName}, your AI trading agent powered by Yieldr.

No positions found in this wallet, but if you're trading from another wallet or on exchanges like Coinbase or Binance, just tell me what you're holding — I'll analyze your positions against what the top traders are doing right now.

Here's what I can do for you:

🔍 **Discover Alpha**
I track top traders on Hyperliquid, Avantis, and Polymarket in real-time — their entries, exits, win rates, and what's driving their edge. Want to see what the top PnL whales are doing with BTC? Or which sports bettors are crushing it with 90%+ win rates?

📈 **Trade Perps with Your Agent**
I can execute and monitor perpetual futures strategies on Avantis directly on your behalf. Tell me your risk appetite and I'll run strategies like trend-following, momentum breakouts, mean reversion, or build a fully custom strategy you define. Your agent watches the market 24/7, manages entries and exits, and keeps you updated — no manual execution needed.

💼 **Invest & Manage**
Tell me a budget and I'll find the best traders across perps and prediction markets, design an allocation, and execute, monitor, and rebalance your portfolio on-chain automatically.

📊 **Get Smarter Over Time**
The agent learns from your trades and top performer patterns to give you sharper insights, better entries, and stronger risk management with every interaction. (coming in V1 launch)

Whether you trade crypto, sports, or macro — start here:
→ "I'm long BTC at $78K, what are top traders doing?"
→ "Run a BTC momentum strategy on Avantis with $500"
→ "Find the best Polymarket sports bettors"
→ "Build me a $10K portfolio from top performers"`;

      // Stream the message with typewriter effect
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          // Split message into chunks (by words for natural typing feel)
          const words = emptyWalletMessage.split(/(\s+)/);
          for (const word of words) {
            const chunk = JSON.stringify({ type: 'text', text: word }) + '\n';
            controller.enqueue(encoder.encode(chunk));
            // Small delay between words for typewriter effect
            await new Promise(resolve => setTimeout(resolve, 15));
          }

          // Save as the first message in a new chat session
          try {
            await connectDB();
            const session = await ChatSession.create({
              walletAddress: walletLower,
              title: 'Welcome',
              messages: [
                { role: 'agent', content: emptyWalletMessage, timestamp: new Date() },
              ],
            });
            controller.enqueue(encoder.encode(
              JSON.stringify({ type: 'session', sessionId: session._id.toString() }) + '\n'
            ));
            console.log(`[initial-analysis] Saved empty wallet session: ${session._id}`);
          } catch (err) {
            console.error('[initial-analysis] Failed to save session:', err);
          }

          controller.close();
        },
      });

      return new Response(stream, {
        headers: { 'Content-Type': 'application/x-ndjson' },
      });
    }

    // Build the position context for the prompt
    const positionContext = [
      ...perpPositions.map(p =>
        `- ${p.pair} ${p.direction} ${p.leverage}x on ${p.platform} | Size: $${p.positionSize} | Entry: $${p.entryPrice} | Current: $${p.currentPrice} | PnL: $${p.pnl} (${p.roi}%)`
      ),
      ...pmPositions.map(p =>
        `- PM: ${p.market} | ${p.outcome} | Size: ${p.size} shares @ avg ${p.avgPrice} | Value: $${p.currentValue} | PnL: $${p.pnl}`
      ),
    ].join('\n');

    const traderContext = followedTraders.length > 0
      ? followedTraders.map((t: any) => {
          const wr = t.winRate <= 1 ? (t.winRate * 100).toFixed(0) : t.winRate.toFixed(0);
          return `- ${t.username || t.wallet?.slice(0, 10)} (${t.platform}) | 30d PnL: $${t.pnl30d?.toLocaleString()} | Win Rate: ${wr}% | Why matched: ${t.matchReason || 'Top trader'}`;
        }).join('\n')
      : 'No traders matched yet.';

    const tokenContext = tokenList.length > 0
      ? tokenList.map((t: any) => `- ${t.symbol} on ${t.chain}: ${t.balance} ($${t.usdValue?.toFixed(2) || '?'})`).join('\n')
      : '';

    const totalValue = (portfolioSummary?.totalValue || 0) + tokensTotalUsd +
      perpPositions.reduce((s: number, p: any) => s + (p.margin || p.positionSize || 0), 0) +
      pmPositions.reduce((s: number, p: any) => s + (p.currentValue || 0), 0);

    const systemPrompt = `You are ${agentName}, an AI trading and investment agent on Yieldr. This is the FIRST message the user sees. Hook them with immediate value from their real data.

---

## 📊 User's Portfolio (Total: ~$${totalValue.toFixed(2)})

### Positions
${positionContext}

${tokenContext ? `### Token Holdings\n${tokenContext}\n` : ''}### Matched Traders (auto-followed based on position overlap)
${traderContext}

---

## 🎯 What To Do

1. One-line greeting mentioning you scanned their wallet

2. For each position:
   • Quick assessment (profit/loss, risk level)
   • If a matched trader trades the same asset, note what they do differently
   • One specific observation (not a directive — frame as "the data shows..." or "one thing to consider...")

3. End with 2-3 questions to continue. Mix options across: top trader intel (e.g., "Want me to pull up what the top ETH traders are doing right now?"), perp strategy execution on Avantis (e.g., "Want me to run a momentum strategy on BTC for you?"), and prediction markets (e.g., "I can find NBA specialists on Polymarket — interested?")

---

## ✍️ Formatting Rules

1. Use emoji status indicators: 🟢 profit | 🔴 loss | ⚪ flat | ⚠️ risk
2. Use • for bullets, never - or *
3. Use --- between sections
4. Bold only for tickers and dollar amounts
5. Never use **text** for emphasis in prose
6. Under 300 words total

---

## 🤖 Agent Capabilities (mention where relevant)

• **Discover Alpha** — real-time tracking of top traders on Hyperliquid, Avantis, and Polymarket
• **Trade Perps on Avantis** — agent can execute and monitor perp strategies on behalf of the user: trend-following, momentum breakouts, mean reversion, or fully custom strategies the user defines. Agent manages entries, exits, stop-losses, and sends updates.
• **Invest & Manage** — find top traders, design allocations, execute and rebalance on-chain automatically
• **Get Smarter Over Time** — agent learns from trades and top performer patterns (V1)

---

## 🗣️ Style

• Lead with key insight, then data
• Use $ and % throughout
• Keep it scannable — short paragraphs, clear spacing
• Say "one approach to consider..." not "you should immediately..."
• Never judgmental ("you're violating..." / "your strategy is wrong")
• Frame as analysis, not financial advice`;

    const userPrompt = 'Analyze my portfolio and give me insights based on my positions and the top traders you matched me with.';

    // ═══ TOKEN BREAKDOWN LOGGING ═══
    const estimateTokens = (text: string) => text ? Math.ceil(text.length / 4) : 0;
    const systemPromptTokens = estimateTokens(systemPrompt);
    const userPromptTokens = estimateTokens(userPrompt);
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║     TOKEN BREAKDOWN — INITIAL ANALYSIS           ║');
    console.log('╠══════════════════════════════════════════════════╣');
    console.log(`║ System prompt:      ${String(systemPromptTokens).padStart(6)} tokens (${systemPrompt.length} chars)`);
    console.log(`║ User prompt:        ${String(userPromptTokens).padStart(6)} tokens (${userPrompt.length} chars)`);
    console.log(`║ ESTIMATED TOTAL:    ${String(systemPromptTokens + userPromptTokens).padStart(6)} tokens`);
    console.log('╚══════════════════════════════════════════════════╝\n');

    console.log(`[initial-analysis] Calling Claude Sonnet 4.5...`);

    // Stream the response
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        let fullResponse = '';
        const startTime = Date.now();
        let totalInputTokens = 0;
        let totalOutputTokens = 0;
        const modelUsed = 'claude-sonnet-4-5-20250929';
        try {
          const response = await anthropic.messages.create({
            model: 'claude-sonnet-4-5-20250929',
            max_tokens: 2048,
            system: systemPrompt,
            messages: [{ role: 'user', content: userPrompt }],
            stream: true,
          });

          for await (const event of response) {
            if (event.type === 'message_start' && (event as any).message?.usage) {
              totalInputTokens += (event as any).message.usage.input_tokens || 0;
              console.log(`[TOKENS][initial] Actual input_tokens: ${totalInputTokens} (estimated was: ${systemPromptTokens + userPromptTokens}, overhead: ${totalInputTokens - systemPromptTokens - userPromptTokens})`);
            } else if (event.type === 'message_delta' && (event as any).usage) {
              totalOutputTokens += (event as any).usage.output_tokens || 0;
              console.log(`[TOKENS][initial] Actual output_tokens: ${totalOutputTokens}`);
            } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
              fullResponse += event.delta.text;
              const chunk = JSON.stringify({ type: 'text', text: event.delta.text }) + '\n';
              controller.enqueue(encoder.encode(chunk));
            }
          }

          console.log(`[initial-analysis] Response complete: ${fullResponse.length} chars`);

          // Save as the first message in a new chat session
          if (fullResponse) {
            try {
              await connectDB();
              const session = await ChatSession.create({
                walletAddress: walletLower,
                title: 'Portfolio Analysis',
                messages: [
                  { role: 'agent', content: fullResponse, timestamp: new Date() },
                ],
              });
              controller.enqueue(encoder.encode(
                JSON.stringify({ type: 'session', sessionId: session._id.toString() }) + '\n'
              ));
              console.log(`[initial-analysis] Saved session: ${session._id}`);

              // Track token usage
              if (totalInputTokens > 0 || totalOutputTokens > 0) {
                const usageData: TokenUsageData = {
                  inputTokens: totalInputTokens,
                  outputTokens: totalOutputTokens,
                  model: modelUsed,
                  latencyMs: Date.now() - startTime,
                };
                trackUsage({
                  sessionId: session._id.toString(),
                  walletAddress: walletLower,
                  usage: usageData,
                  endpoint: 'initial-analysis',
                }).catch(err => console.error('[initial-analysis] Token tracking error:', err));
              }
            } catch (saveErr) {
              console.error('[initial-analysis] Failed to save session:', saveErr);
            }
          }

          controller.enqueue(encoder.encode(JSON.stringify({ type: 'done' }) + '\n'));
          controller.close();
        } catch (err: any) {
          console.error('[initial-analysis] Stream error:', err.message);
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
    console.error('[initial-analysis] Error:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
