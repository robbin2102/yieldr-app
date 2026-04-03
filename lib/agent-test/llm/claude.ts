import Anthropic from '@anthropic-ai/sdk';
import { SYSTEM_PROMPT } from '../prompt';

export const CLAUDE_MODEL = 'claude-sonnet-4-6';

export interface LLMMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface StreamCallbacks {
  onChunk: (chunk: string) => void;
  onDone: (result: { content: string; input_tokens: number; output_tokens: number; response_time_ms: number; model: string }) => void;
  onError: (error: Error) => void;
}

export async function streamClaude(
  messages: LLMMessage[],
  callbacks: StreamCallbacks
): Promise<void> {
  const start = Date.now();
  let fullContent = '';

  // Instantiate at call time so env vars are guaranteed to be loaded
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  try {
    const stream = anthropic.messages.stream({
      model: CLAUDE_MODEL,
      max_tokens: 250,
      system: SYSTEM_PROMPT,
      messages,
    });

    stream.on('text', (text) => {
      fullContent += text;
      callbacks.onChunk(text);
    });

    const finalMessage = await stream.finalMessage();
    callbacks.onDone({
      content: fullContent,
      input_tokens: finalMessage.usage.input_tokens,
      output_tokens: finalMessage.usage.output_tokens,
      response_time_ms: Date.now() - start,
      model: CLAUDE_MODEL,
    });
  } catch (err) {
    callbacks.onError(err instanceof Error ? err : new Error(String(err)));
  }
}
