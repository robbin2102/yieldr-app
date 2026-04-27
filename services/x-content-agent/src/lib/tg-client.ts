/**
 * Telegram Bot API Client
 *
 * Posts content to the @yieldr_alpha channel via Bot API.
 * Uses raw HTTP (axios) — no extra dependencies needed.
 *
 * Setup:
 *   1. Create bot via @BotFather → get TELEGRAM_BOT_TOKEN
 *   2. Create channel (e.g. @yieldr_alpha)
 *   3. Add bot as admin with "Post Messages" permission
 *   4. Set TELEGRAM_CHANNEL_ID to "@yieldr_alpha" or numeric "-100xxx" ID
 */

import axios, { AxiosInstance } from 'axios';

let botClient: AxiosInstance | null = null;

// Convert **bold** markdown to Telegram HTML — more robust than MarkdownV2
// which requires escaping dozens of special characters
function toHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
    // Ensure CTA always points to /vaults regardless of what LLM writes
    .replace(/yieldr\.org(?!\/vaults)(?=\s|$|<)/g, 'yieldr.org/vaults');
}

function getBotClient(): AxiosInstance {
  if (!botClient) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) throw new Error('TELEGRAM_BOT_TOKEN not set');

    botClient = axios.create({
      baseURL: `https://api.telegram.org/bot${token}`,
      timeout: 15000,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return botClient;
}

function getChannelId(): string {
  let id = process.env.TELEGRAM_CHANNEL_ID;
  if (!id) throw new Error('TELEGRAM_CHANNEL_ID not set');
  // Auto-prefix @ for username-style IDs (not numeric -100xxx)
  if (!id.startsWith('@') && !id.startsWith('-')) {
    id = `@${id}`;
  }
  return id;
}

interface TgMessageResult {
  message_id: number;
  chat: { id: number; title?: string };
}

/**
 * Send a text message to the Yieldr channel
 * Uses Markdown parse mode to render **bold**, _italic_, etc.
 */
export async function sendChannelMessage(text: string): Promise<TgMessageResult> {
  const client = getBotClient();
  const channelId = getChannelId();

  const response = await client.post('/sendMessage', {
    chat_id: channelId,
    text: toHtml(text),
    parse_mode: 'HTML',
    disable_web_page_preview: false,
  });

  const result = response.data.result;
  console.log(`[TG] Sent to channel: message_id=${result.message_id}`);
  return result;
}

/**
 * Send a message with an inline button (e.g. "Track live → yieldr.org")
 */
export async function sendChannelMessageWithButton(
  text: string,
  buttonText: string,
  buttonUrl: string,
): Promise<TgMessageResult> {
  const client = getBotClient();
  const channelId = getChannelId();

  const response = await client.post('/sendMessage', {
    chat_id: channelId,
    text: toHtml(text),
    parse_mode: 'HTML',
    disable_web_page_preview: false,
    reply_markup: {
      inline_keyboard: [[{ text: buttonText, url: buttonUrl }]],
    },
  });

  const result = response.data.result;
  console.log(`[TG] Sent to channel with button: message_id=${result.message_id}`);
  return result;
}

/**
 * Verify the bot can access the channel
 */
export async function verifyBotAccess(): Promise<{ ok: boolean; chatTitle?: string; error?: string }> {
  try {
    const client = getBotClient();
    const channelId = getChannelId();

    const response = await client.post('/getChat', { chat_id: channelId });
    const chat = response.data.result;
    console.log(`[TG] Bot has access to channel: "${chat.title}" (${chat.id})`);
    return { ok: true, chatTitle: chat.title };
  } catch (error: any) {
    const msg = error.response?.data?.description || error.message;
    console.error(`[TG] Bot access check failed: ${msg}`);
    return { ok: false, error: msg };
  }
}
