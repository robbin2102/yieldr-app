/**
 * Content Calendar & Scheduler
 *
 * Manages the daily posting schedule optimized for US/EU traffic.
 * IST times mapped to EDT for prime engagement windows.
 *
 * Active content types: TRADER_PROFILE, HIGH_CONVICTION, VAULT_PERFORMANCE
 * Disabled: MARKETS_ALPHA, BASE_POSTING
 */

import * as cron from 'node-cron';
import { CONFIG } from '../config';
import {
  generateTraderAlpha,
  generateHighConvictionAlert,
  generateVaultPerformance,
  GeneratedPost,
} from '../content/generator';
import { postTweet, quoteTweet } from '../lib/x-client';
import { sendChannelMessageWithButton, sendPhotoWithButton } from '../lib/tg-client';
import { getCategoryImage } from '../lib/category-images';
import { getDB, COLLECTIONS } from '../lib/db';

// Track daily post counts
const dailyCounts: Record<string, number> = {};
let lastResetDate = '';
let traderRotation = 0;
// HC category cycles through specialties across windows
const HC_CATEGORIES = ['NBA', 'Soccer', 'Politics'];
let hcRotation = 0;
// Vault rotation — one per vault per day: NBA → Soccer → Geopolitics
const VAULT_ROTATION = ['NBA Edge Vault', 'Soccer Alpha Vault', 'Geopolitics Vault'];
let vaultRotation = 0;

function resetDailyCounts(): void {
  const today = new Date().toISOString().split('T')[0];
  if (today !== lastResetDate) {
    Object.keys(CONFIG.DAILY_LIMITS).forEach(key => {
      dailyCounts[key] = 0;
    });
    traderRotation = 0;
    hcRotation = 0;
    vaultRotation = 0;
    lastResetDate = today;
  }
}

function nextHcCategory(): string {
  const category = HC_CATEGORIES[hcRotation % HC_CATEGORIES.length];
  hcRotation++;
  return category;
}

function nextVault(): string {
  const vault = VAULT_ROTATION[vaultRotation % VAULT_ROTATION.length];
  vaultRotation++;
  return vault;
}

function canPost(category: string): boolean {
  resetDailyCounts();
  const limit = (CONFIG.DAILY_LIMITS as any)[category] || 999;
  return (dailyCounts[category] || 0) < limit;
}

function randomJitter(): number {
  return CONFIG.JITTER_MIN_MS + Math.random() * (CONFIG.JITTER_MAX_MS - CONFIG.JITTER_MIN_MS);
}

/**
 * Publish a generated post to X + Telegram channel and log it
 */
async function publishPost(post: GeneratedPost, channels: { x: boolean; tg: boolean } = { x: true, tg: true }): Promise<void> {
  let tweetId: string | null = null;
  let tgMessageId: number | null = null;

  const isVaultLoss = post.category === 'VAULT_PERFORMANCE'
    && !!post.tweet && /rough|loss|down|smoked|negative|red/i.test(post.tweet);
  const imagePath = getCategoryImage(post.category, isVaultLoss);
  const useImageOnX = imagePath && post.category === 'VAULT_PERFORMANCE';

  // 1. Post to X
  if (channels.x) {
    try {
      const tweetText = post.tweet;
      let tweetData;

      if (post.type === 'quote' && post.target_post_id) {
        tweetData = await quoteTweet(tweetText, post.target_post_id);
      } else {
        tweetData = await postTweet(tweetText, useImageOnX ? imagePath : undefined);
      }

      tweetId = tweetData.id;
      console.log(`[Calendar] Published to X: ${post.category} (${tweetId})${useImageOnX ? ' [with image]' : ''}`);
    } catch (error: any) {
      const detail = error.data?.detail || error.data?.errors?.[0]?.message || '';
      console.error(`[Calendar] X post failed for ${post.category}: ${error.message}${detail ? ' — ' + detail : ''}`);
      if (error.code === 403 || error.message?.includes('403')) {
        console.error(`[Calendar] 403 likely cause: duplicate content or tweet too long (${post.tweet?.length} chars)`);
      }
    }
  }

  // 2. Post to Telegram
  if (channels.tg && post.telegram) {
    try {
      let tgResult;
      if (imagePath) {
        tgResult = await sendPhotoWithButton(
          imagePath,
          post.telegram,
          'Track live →',
          'https://yieldr.org/vaults',
        );
      } else {
        tgResult = await sendChannelMessageWithButton(
          post.telegram,
          'Track live →',
          'https://yieldr.org/vaults',
        );
      }
      tgMessageId = tgResult.message_id;
      console.log(`[Calendar] Published to TG: ${post.category} (msg ${tgMessageId})${imagePath ? ' [with photo]' : ''}`);
    } catch (error: any) {
      console.error(`[Calendar] TG post failed for ${post.category}:`, error.message);
    }
  }

  // 3. Log to MongoDB
  try {
    const db = await getDB();
    await db.collection(COLLECTIONS.X_POSTS).insertOne({
      tweetId,
      tgMessageId,
      type: post.type,
      tweet: post.tweet,
      telegram: post.telegram,
      category: post.category,
      metadata: post.metadata,
      publishedTo: { x: channels.x, tg: channels.tg },
      postedAt: new Date(),
    });
  } catch (error: any) {
    console.error(`[Calendar] DB log failed:`, error.message);
  }

  dailyCounts[post.category] = (dailyCounts[post.category] || 0) + 1;
}

/**
 * Execute a content window - generate and post scheduled content
 * publishTo controls which channels get each post type
 */
async function executeWindow(
  contentTypes: { type: string; x: boolean; tg: boolean }[],
  windowOpts?: { hcCategory?: string },
): Promise<void> {
  for (const { type, x, tg } of contentTypes) {
    if (!canPost(type)) {
      console.log(`[Calendar] Daily limit reached for ${type}, skipping`);
      continue;
    }

    try {
      let post: GeneratedPost;

      switch (type) {
        case 'TRADER_PROFILE':
          traderRotation++;
          post = await generateTraderAlpha({ rotation: traderRotation, totalTraders: 3 });
          break;
        case 'HIGH_CONVICTION': {
          const category = windowOpts?.hcCategory || nextHcCategory();
          console.log(`[Calendar] HC category: ${category}`);
          post = await generateHighConvictionAlert(category);
          break;
        }
        case 'VAULT_PERFORMANCE':
          post = await generateVaultPerformance(nextVault());
          break;
        default:
          console.warn(`[Calendar] Skipping disabled/unknown content type: ${type}`);
          continue;
      }

      await publishPost(post, { x, tg });

      const delay = 30000 + Math.random() * 90000;
      await new Promise(r => setTimeout(r, delay));

    } catch (error: any) {
      console.error(`[Calendar] Error generating ${type}:`, error.message);
    }
  }
}

/**
 * Start the posting scheduler
 * Uses cron jobs aligned to the IST posting windows
 */
export function startScheduler(): void {
  console.log('[Calendar] Starting content scheduler...');

  // Window 1: 7:30 PM IST / 10:00 AM EDT / 4:00 PM CEST
  // X: HC + Trader (2 posts) | TG: HC only (1 post)
  cron.schedule('30 19 * * *', () => {
    setTimeout(() => executeWindow([
      { type: 'HIGH_CONVICTION', x: true, tg: true },
      { type: 'TRADER_PROFILE', x: true, tg: false },
    ]), randomJitter());
  }, { timezone: 'Asia/Kolkata' });

  // Window 2: 9:30 PM IST / 12:00 PM EDT / 6:00 PM CEST
  // X: Vault Soccer (1 post) | TG: Vault Soccer (1 post)
  cron.schedule('30 21 * * *', () => {
    setTimeout(() => executeWindow([
      { type: 'VAULT_PERFORMANCE', x: true, tg: true },
    ]), randomJitter());
  }, { timezone: 'Asia/Kolkata' });

  // Window 3: 2:00 AM IST / 4:30 PM EDT / 10:30 PM CEST
  // X: HC + Trader (2 posts) | TG: Trader only (1 post)
  cron.schedule('0 2 * * *', () => {
    setTimeout(() => executeWindow([
      { type: 'HIGH_CONVICTION', x: true, tg: false },
      { type: 'TRADER_PROFILE', x: true, tg: true },
    ]), randomJitter());
  }, { timezone: 'Asia/Kolkata' });

  // Window 4: 5:30 AM IST / 8:00 PM EDT — US prime evening
  // X: Vault NBA + HC + Trader (3 posts) | TG: Vault NBA only (1 post)
  cron.schedule('30 5 * * *', () => {
    setTimeout(() => executeWindow([
      { type: 'VAULT_PERFORMANCE', x: true, tg: true },
      { type: 'HIGH_CONVICTION', x: true, tg: false },
      { type: 'TRADER_PROFILE', x: true, tg: false },
    ]), randomJitter());
  }, { timezone: 'Asia/Kolkata' });

  // Window 5: 8:30 AM IST / 11:00 PM EDT
  // X: Vault Geopolitics (1 post) | TG: Vault Geopolitics (1 post)
  cron.schedule('30 8 * * *', () => {
    setTimeout(() => executeWindow([
      { type: 'VAULT_PERFORMANCE', x: true, tg: true },
    ]), randomJitter());
  }, { timezone: 'Asia/Kolkata' });

  console.log('[Calendar] 5 posting windows scheduled (IST timezone)');
  console.log('[Calendar] Daily: X=9 (3 HC + 3 Trader + 3 Vault) | TG=5 (1 HC + 1 Trader + 3 Vault)');
}
