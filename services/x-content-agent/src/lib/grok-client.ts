/**
 * xAI Grok Client
 *
 * Uses the OpenAI-compatible API from xAI for content generation.
 * Model: grok-4-1-fast-reasoning
 */

import OpenAI from 'openai';
import { CONFIG } from '../config';

let grokClient: OpenAI | null = null;

export function getGrokClient(): OpenAI {
  if (!grokClient) {
    grokClient = new OpenAI({
      apiKey: process.env.XAI_API_KEY || CONFIG.XAI_API_KEY,
      baseURL: CONFIG.XAI_BASE_URL,
    });
  }
  return grokClient;
}

/**
 * Generate content using Grok
 */
export async function generateContent(
  systemPrompt: string,
  userPrompt: string,
  options?: {
    maxTokens?: number;
    temperature?: number;
  }
): Promise<string> {
  const client = getGrokClient();

  const response = await client.chat.completions.create({
    model: CONFIG.XAI_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    max_tokens: options?.maxTokens || 500,
    temperature: options?.temperature || 0.8,
  });

  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error('Empty response from Grok');

  return content;
}

/**
 * Generate structured JSON content using Grok
 */
export async function generateStructuredContent(
  systemPrompt: string,
  userPrompt: string,
  options?: {
    maxTokens?: number;
    temperature?: number;
  }
): Promise<any> {
  const content = await generateContent(
    systemPrompt + '\n\nYou MUST respond with valid JSON only. No markdown, no code blocks, just raw JSON.',
    userPrompt,
    options
  );

  // Strip markdown code blocks if present
  let cleaned = content.trim();
  if (cleaned.startsWith('```json')) cleaned = cleaned.slice(7);
  if (cleaned.startsWith('```')) cleaned = cleaned.slice(3);
  if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);
  cleaned = cleaned.trim();

  return JSON.parse(cleaned);
}
