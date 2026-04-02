import { NextRequest } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import connectAgentDB from '@/lib/agent-test/db';
import { getChatSessionModel } from '@/lib/agent-test/models/ChatSession';
import { streamClaude, LLMMessage } from '@/lib/agent-test/llm/claude';
import { streamOpenAI } from '@/lib/agent-test/llm/openai';
import { streamGrok } from '@/lib/agent-test/llm/grok';
import { summarizeExchanges } from '@/lib/agent-test/llm/summarize';
import { buildStateInjection, updateState } from '@/lib/agent-test/state';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Show exactly which API-related keys Next.js can see
const visibleApiKeys = Object.keys(process.env).filter(
  (k) => k.includes('API') || k.includes('KEY') || k.includes('SECRET')
);
console.log('[agent-test] visible API-related env keys:', visibleApiKeys.sort().join(', '));
console.log('[agent-test] env check:', {
  ANTHROPIC: !!process.env.ANTHROPIC_API_KEY,
  GPT: !!(process.env.GPT_API_KEY || process.env.OPENAI_API_KEY),
  XAI: !!process.env.XAI_API_KEY,
  MONGODB: !!process.env.MONGODB_URI,
});

export async function POST(req: NextRequest) {
  const { session_id, message, test_label } = await req.json();

  if (!message?.trim()) {
    return new Response(JSON.stringify({ error: 'Message required' }), { status: 400 });
  }

  const conn = await connectAgentDB();
  const ChatSession = getChatSessionModel(conn);

  // Get or create session
  let session = session_id ? await ChatSession.findOne({ session_id }) : null;

  if (!session) {
    session = await ChatSession.create({
      session_id: uuidv4(),
      test_label: test_label || '',
      status: 'active',
      exchanges: [],
      state: {
        exchange_count: 0,
        topics_covered: [],
        offer_presented: false,
        nudge_used: false,
        community_mentioned: false,
        objections_raised: [],
      },
      summary_history: [],
    });
  }

  // Build message history from DB
  const exchanges = session.exchanges;
  let summaryContext = '';

  // Compress older exchanges into summary if we have 4+
  if (exchanges.length >= 4) {
    const olderExchanges = exchanges.slice(0, exchanges.length - 2);
    const expectedSummaries = Math.floor(olderExchanges.length / 4);
    if (session.summary_history.length < expectedSummaries) {
      try {
        const summary = await summarizeExchanges(olderExchanges);
        session.summary_history.push(summary);
        summaryContext = summary;
      } catch {
        // Summarization failure is non-fatal
      }
    } else {
      summaryContext = session.summary_history[session.summary_history.length - 1] || '';
    }
  }

  // Build messages from last 2 exchanges + state + new message
  const recentExchanges = exchanges.slice(-2);
  const stateInjection = buildStateInjection(session.state);
  const messages: LLMMessage[] = [];

  if (summaryContext) {
    messages.push({ role: 'user', content: `[Context from earlier: ${summaryContext}]` });
    messages.push({ role: 'assistant', content: 'Understood, I have context from earlier.' });
  }

  for (const ex of recentExchanges) {
    messages.push({ role: 'user', content: ex.user_message });
    const agentContent =
      ex.responses.claude?.content ||
      ex.responses.openai?.content ||
      ex.responses.grok?.content ||
      '';
    if (agentContent) {
      messages.push({ role: 'assistant', content: agentContent });
    }
  }

  messages.push({ role: 'user', content: `${stateInjection}\n${message}` });

  const encoder = new TextEncoder();
  const exchangeNumber = exchanges.length + 1;
  const currentSessionId = session.session_id;
  const currentState = session.state;
  const currentSummaryHistory = [...session.summary_history];

  type LLMResult = {
    content: string;
    input_tokens: number;
    output_tokens: number;
    response_time_ms: number;
    model: string;
  };

  const results: { claude?: LLMResult; openai?: LLMResult; grok?: LLMResult } = {};

  const responseStream = new ReadableStream({
    async start(controller) {
      function send(data: object) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      }

      send({ type: 'session', session_id: currentSessionId });

      await Promise.all([
        streamClaude(messages, {
          onChunk: (chunk) => send({ type: 'chunk', model: 'claude', chunk }),
          onDone: (result) => {
            results.claude = result;
            send({ type: 'done', ...result, model: 'claude' });
          },
          onError: (err) => send({ type: 'error', model: 'claude', error: err.message }),
        }),
        streamOpenAI(messages, {
          onChunk: (chunk) => send({ type: 'chunk', model: 'openai', chunk }),
          onDone: (result) => {
            results.openai = result;
            send({ type: 'done', ...result, model: 'openai' });
          },
          onError: (err) => send({ type: 'error', model: 'openai', error: err.message }),
        }),
        streamGrok(messages, {
          onChunk: (chunk) => send({ type: 'chunk', model: 'grok', chunk }),
          onDone: (result) => {
            results.grok = result;
            send({ type: 'done', ...result, model: 'grok' });
          },
          onError: (err) => send({ type: 'error', model: 'grok', error: err.message }),
        }),
      ]);

      // Persist exchange to MongoDB after all 3 finish
      try {
        const bestResponse =
          results.claude?.content || results.openai?.content || results.grok?.content || '';
        const stateUpdate = updateState(currentState, message, bestResponse);

        const dbConn = await connectAgentDB();
        const CS = getChatSessionModel(dbConn);

        await CS.findOneAndUpdate(
          { session_id: currentSessionId },
          {
            $push: {
              exchanges: {
                exchange_number: exchangeNumber,
                timestamp: new Date(),
                user_message: message,
                responses: {
                  claude: results.claude,
                  openai: results.openai,
                  grok: results.grok,
                },
              },
            },
            $set: {
              updated_at: new Date(),
              'state.exchange_count': stateUpdate.exchange_count,
              'state.topics_covered': stateUpdate.topics_covered,
              'state.vault_interest': stateUpdate.vault_interest,
              'state.objections_raised': stateUpdate.objections_raised,
              'state.offer_presented': stateUpdate.offer_presented,
              'state.nudge_used': stateUpdate.nudge_used,
              'state.community_mentioned': stateUpdate.community_mentioned,
              summary_history: currentSummaryHistory,
            },
          }
        );
      } catch (dbErr) {
        console.error('DB write error after stream:', dbErr);
      }

      send({ type: 'complete' });
      controller.close();
    },
  });

  return new Response(responseStream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
