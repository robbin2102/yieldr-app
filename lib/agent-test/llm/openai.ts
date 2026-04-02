import OpenAI from 'openai';
import { SYSTEM_PROMPT } from '../prompt';
import { LLMMessage, StreamCallbacks } from './claude';

export const OPENAI_MODEL = 'gpt-4.5-mini';

export async function streamOpenAI(
  messages: LLMMessage[],
  callbacks: StreamCallbacks
): Promise<void> {
  const start = Date.now();
  let fullContent = '';
  let promptTokens = 0;
  let completionTokens = 0;

  // Instantiate at call time so env vars are guaranteed to be loaded
  const openaiClient = new OpenAI({ apiKey: process.env.GPT_API_KEY });

  try {
    const stream = await openaiClient.chat.completions.create({
      model: OPENAI_MODEL,
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
      model: OPENAI_MODEL,
    });
  } catch (err) {
    callbacks.onError(err instanceof Error ? err : new Error(String(err)));
  }
}
