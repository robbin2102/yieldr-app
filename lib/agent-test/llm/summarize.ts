import Anthropic from '@anthropic-ai/sdk';
import { IExchange } from '../models/ChatSession';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function summarizeExchanges(exchanges: IExchange[]): Promise<string> {
  const conversationText = exchanges
    .map(
      (ex) =>
        `User: ${ex.user_message}\nAgent: ${ex.responses.claude?.content || ex.responses.openai?.content || ex.responses.grok?.content || '[no response]'}`
    )
    .join('\n\n');

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 150,
    messages: [
      {
        role: 'user',
        content: `Summarize this sales conversation in 1 line for context injection. Include: what user asked, what was explained, user's interest level, objections raised. Max 50 words.\n\n${conversationText}`,
      },
    ],
  });

  const block = response.content[0];
  return block.type === 'text' ? block.text : '';
}
