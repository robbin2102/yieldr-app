import { NextRequest } from 'next/server';
import { analyzeWallet, type AnalysisStage } from '@/lib/edge/analyze';

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const { wallet } = await req.json();

  if (!wallet || typeof wallet !== 'string') {
    return new Response(JSON.stringify({ error: 'wallet address is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (type: AnalysisStage, data: unknown) => {
        controller.enqueue(encoder.encode(JSON.stringify({ type, data }) + '\n'));
      };

      try {
        await analyzeWallet(wallet, emit);
      } catch (err: any) {
        controller.enqueue(
          encoder.encode(JSON.stringify({ type: 'error', data: { message: err?.message ?? 'analysis failed' } }) + '\n')
        );
      } finally {
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
}
