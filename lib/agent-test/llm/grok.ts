import OpenAI from 'openai';
import { SYSTEM_PROMPT } from '../prompt';
import { LLMMessage, StreamCallbacks } from './claude';

export const GROK_MODEL = 'grok-4-1-fast-reasoning';

export async function streamGrok(
  messages: LLMMessage[],
  callbacks: StreamCallbacks
): Promise<void> {
  const start = Date.now();
  let fullContent = '';
  let promptTokens = 0;
  let completionTokens = 0;

  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    callbacks.onError(new Error('XAI_API_KEY is not set in .env.local'));
    return;
  }
  const grokClient = new OpenAI({
    apiKey,
    baseURL: 'https://api.x.ai/v1',
  });

  try {
    const stream = await grokClient.chat.completions.create({
      model: GROK_MODEL,
      max_tokens: 500,
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        ...messages.map((m) => ({ role: m.role, content: m.content })),
      ],
    });

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        fullContent += delta;
        callbacks.onChunk(delta);
      }
      if (chunk.usage) {
        promptTokens = chunk.usage.prompt_tokens ?? 0;
        completionTokens = chunk.usage.completion_tokens ?? 0;
      }
    }

    callbacks.onDone({
      content: fullContent,
      input_tokens: promptTokens,
      output_tokens: completionTokens,
      response_time_ms: Date.now() - start,
      model: GROK_MODEL,
    });
  } catch (err) {
    callbacks.onError(err instanceof Error ? err : new Error(String(err)));
  }
}
