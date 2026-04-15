/**
 * Content Calendar & Scheduler
 *
 * Manages the daily posting schedule optimized for US/EU traffic.
 * IST times mapped to EDT for prime engagement windows.
 */

import * as cron from 'node-cron';
import { CONFIG } from '../config';
import {
  generateTraderAlpha,
  generateMarketsAlpha,
  generateHighConvictionAlert,
  generateVaultPerformance,
  generateBasePost,
  GeneratedPost,
} from '../content/generator';
import { postTweet, quoteTweet } from '../lib/x-client';
import { getDB, COLLECTIONS } from '../lib/db';

// Track daily post counts
const dailyCounts: Record<string, number> = {};
let lastResetDate = '';

function resetDailyCounts(): void {
  const today = new Date().toISOString().split('T')[0];
  if (today !== lastResetDate) {
    Object.keys(CONFIG.DAILY_LIMITS).forEach(key => {
      dailyCounts[key] = 0;
    });
    lastResetDate = today;
  }
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
 * Publish a generated post to X and log it
 */
async function publishPost(post: GeneratedPost): Promise<void> {
  try {
    let tweetData;

    if (post.type === 'quote' && post.target_post_id) {
      tweetData = await quoteTweet(post.content, post.target_post_id);
    } else {
      tweetData = await postTweet(post.content);
    }

    // Log to MongoDB
    const db = await getDB();
    await db.collection(COLLECTIONS.X_POSTS).insertOne({
      tweetId: tweetData.id,
      type: post.type,
      content: post.content,
      category: post.category,
      metadata: post.metadata,
      postedAt: new Date(),
    });

    dailyCounts[post.category] = (dailyCounts[post.category] || 0) + 1;

    console.log(`[Calendar] Published ${post.category}: "${post.content.substring(0, 60)}..."`);
  } catch (error: any) {
    console.error(`[Calendar] Failed to publish ${post.category}:`, error.message);
  }
}

/**
 * Execute a content window - generate and post scheduled content
 */
async function executeWindow(contentTypes: string[]): Promise<void> {
  for (const type of contentTypes) {
    if (!canPost(type)) {
      console.log(`[Calendar] Daily limit reached for ${type}, skipping`);
      continue;
    }

    try {
      let post: GeneratedPost;

      switch (type) {
        case 'TRADER_PROFILE':
          post = await generateTraderAlpha();
          break;
        case 'MARKETS_ALPHA':
          post = await generateMarketsAlpha();
          break;
        case 'HIGH_CONVICTION':
          post = await generateHighConvictionAlert();
          break;
        case 'VAULT_PERFORMANCE':
          post = await generateVaultPerformance();
          break;
        case 'BASE_POSTING':
          post = await generateBasePost();
          break;
        default:
          console.warn(`[Calendar] Unknown content type: ${type}`);
          continue;
      }

      await publishPost(post);

      // Random delay between posts in same window (30s - 2min)
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

  // Window 1: 7:30 PM IST / 6 AM EDT — HC + Trader Profile
  cron.schedule('30 19 * * *', () => {
    setTimeout(() => executeWindow(['HIGH_CONVICTION', 'TRADER_PROFILE']), randomJitter());
  }, { timezone: 'Asia/Kolkata' });

  // Window 2: 9:30 PM IST / 8 AM EDT — Markets Alpha + Vault Performance
  cron.schedule('30 21 * * *', () => {
    setTimeout(() => executeWindow(['MARKETS_ALPHA', 'VAULT_PERFORMANCE']), randomJitter());
  }, { timezone: 'Asia/Kolkata' });

  // Window 3: 11:30 PM IST / 10 AM EDT — Trader Profile + Base Post
  cron.schedule('30 23 * * *', () => {
    setTimeout(() => executeWindow(['TRADER_PROFILE', 'BASE_POSTING']), randomJitter());
  }, { timezone: 'Asia/Kolkata' });

  // Window 4: 2:00 AM IST / 1 PM EDT — HC + Markets Alpha
  cron.schedule('0 2 * * *', () => {
    setTimeout(() => executeWindow(['HIGH_CONVICTION', 'MARKETS_ALPHA']), randomJitter());
  }, { timezone: 'Asia/Kolkata' });

  // Window 5: 5:30 AM IST / 4 PM EDT — HC + Trader Profile
  cron.schedule('30 5 * * *', () => {
    setTimeout(() => executeWindow(['HIGH_CONVICTION', 'TRADER_PROFILE']), randomJitter());
  }, { timezone: 'Asia/Kolkata' });

  // Window 6: 8:30 AM IST / 7 PM EDT — Vault + Markets Alpha
  cron.schedule('30 8 * * *', () => {
    setTimeout(() => executeWindow(['VAULT_PERFORMANCE', 'MARKETS_ALPHA']), randomJitter());
  }, { timezone: 'Asia/Kolkata' });

  // Window 7: 11:00 AM IST / 9:30 PM EDT — Trader + HC + Vault + Base
  cron.schedule('0 11 * * *', () => {
    setTimeout(() => executeWindow(['TRADER_PROFILE', 'HIGH_CONVICTION', 'VAULT_PERFORMANCE', 'BASE_POSTING']), randomJitter());
  }, { timezone: 'Asia/Kolkata' });

  console.log('[Calendar] 7 posting windows scheduled (IST timezone)');
}
