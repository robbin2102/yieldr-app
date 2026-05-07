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
import * as fs from 'fs';
import * as path from 'path';
import FormData from 'form-data';

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
 * Send a photo with caption and inline button to the channel.
 * TG photo captions max at 1024 chars — if longer, sends photo first
 * then text as a reply.
 */
export async function sendPhotoWithButton(
  imagePath: string,
  caption: string,
  buttonText: string,
  buttonUrl: string,
): Promise<TgMessageResult> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN not set');
  const channelId = getChannelId();
  const htmlCaption = toHtml(caption);

  const replyMarkup = JSON.stringify({
    inline_keyboard: [[{ text: buttonText, url: buttonUrl }]],
  });

  // Caption fits in photo message (1024 char limit)
  if (htmlCaption.length <= 1024) {
    const form = new FormData();
    form.append('chat_id', channelId);
    form.append('photo', fs.createReadStream(imagePath), path.basename(imagePath));
    form.append('caption', htmlCaption);
    form.append('parse_mode', 'HTML');
    form.append('reply_markup', replyMarkup);

    const response = await axios.post(
      `https://api.telegram.org/bot${token}/sendPhoto`,
      form,
      { headers: form.getHeaders(), timeout: 30000 },
    );

    const result = response.data.result;
    console.log(`[TG] Sent photo to channel: message_id=${result.message_id}`);
    return result;
  }

  // Caption too long — send photo first, then text as reply
  const photoForm = new FormData();
  photoForm.append('chat_id', channelId);
  photoForm.append('photo', fs.createReadStream(imagePath), path.basename(imagePath));

  const photoResponse = await axios.post(
    `https://api.telegram.org/bot${token}/sendPhoto`,
    photoForm,
    { headers: photoForm.getHeaders(), timeout: 30000 },
  );

  const photoResult = photoResponse.data.result;
  console.log(`[TG] Sent photo to channel: message_id=${photoResult.message_id}`);

  const client = getBotClient();
  const textResponse = await client.post('/sendMessage', {
    chat_id: channelId,
    text: htmlCaption,
    parse_mode: 'HTML',
    reply_to_message_id: photoResult.message_id,
    reply_markup: { inline_keyboard: [[{ text: buttonText, url: buttonUrl }]] },
  });

  const textResult = textResponse.data.result;
  console.log(`[TG] Sent caption reply: message_id=${textResult.message_id}`);
  return textResult;
}

/**
 * Send a native poll to the channel
 */
export async function sendPoll(
  question: string,
  options: string[],
  contextText?: string,
): Promise<TgMessageResult> {
  const client = getBotClient();
  const channelId = getChannelId();

  if (contextText) {
    await client.post('/sendMessage', {
      chat_id: channelId,
      text: toHtml(contextText),
      parse_mode: 'HTML',
    });
  }

  const response = await client.post('/sendPoll', {
    chat_id: channelId,
    question,
    options: JSON.stringify(options.slice(0, 10)),
    is_anonymous: true,
  });

  const result = response.data.result;
  console.log(`[TG] Sent poll to channel: message_id=${result.message_id}`);
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
