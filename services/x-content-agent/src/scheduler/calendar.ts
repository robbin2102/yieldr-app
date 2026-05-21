/**
 * Content Calendar & Scheduler
 *
 * 5 posts/day on X, 3 posts/day on TG.
 * TG gets community-facing content; X gets everything.
 *
 * Schedule (IST → EDT):
 *   1. 7:30 PM / 10:00 AM — Project Primer        (X + TG)
 *   2. 10:00 PM / 12:30 PM — Vault Performance     (X + TG) — rotates daily: NBA → Soccer → Geo
 *   3. 12:00 AM / 2:30 PM — Community Prompt/Poll  (X + TG)
 *   4. 3:00 AM / 5:30 PM — High Conviction          (X only)
 *   5. 6:00 AM / 8:30 PM — Trader Profile            (X only)
 */

import * as cron from 'node-cron';
import { CONFIG } from '../config';
import {
  generateTraderAlpha,
  generateHighConvictionAlert,
  generateVaultPerformance,
  generateProjectPrimer,
  generateCommunityPrompt,
  GeneratedPost,
} from '../content/generator';
import { postTweet, postPoll, quoteTweet } from '../lib/x-client';
import { sendChannelMessageWithButton, sendPhotoWithButton, sendPoll } from '../lib/tg-client';
import { getCategoryImage } from '../lib/category-images';
import { getDB, COLLECTIONS } from '../lib/db';

type Channel = 'x' | 'tg';

const VAULT_ROTATION = ['NBA Edge Vault', 'Soccer Alpha Vault', 'Geopolitics Vault'];

const dailyCounts: Record<string, number> = {};
let lastResetDate = '';

const HC_CATEGORIES = ['NBA', 'Soccer', 'Politics'];
let hcRotation = 0;

function resetDailyCounts(): void {
  const today = new Date().toISOString().split('T')[0];
  if (today !== lastResetDate) {
    Object.keys(CONFIG.DAILY_LIMITS).forEach(key => {
      dailyCounts[key] = 0;
    });
    hcRotation = 0;
    lastResetDate = today;
  }
}

function nextHcCategory(): string {
  const category = HC_CATEGORIES[hcRotation % HC_CATEGORIES.length];
  hcRotation++;
  return category;
}

function todaysVault(): string {
  const dayOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0).getTime()) / 86400000);
  return VAULT_ROTATION[dayOfYear % VAULT_ROTATION.length];
}

function canPost(category: string): boolean {
  resetDailyCounts();
  const limit = (CONFIG.DAILY_LIMITS as any)[category] || 999;
  return (dailyCounts[category] || 0) < limit;
}

function randomJitter(): number {
  return CONFIG.JITTER_MIN_MS + Math.random() * (CONFIG.JITTER_MAX_MS - CONFIG.JITTER_MIN_MS);
}

async function publishPost(post: GeneratedPost, channels: Channel[]): Promise<void> {
  let tweetId: string | null = null;
  let tgMessageId: number | null = null;

  const isVaultLoss = post.category === 'VAULT_PERFORMANCE'
    && !!post.tweet && /rough|loss|down|smoked|negative|red/i.test(post.tweet);
  const imagePath = getCategoryImage(post.category, isVaultLoss);

  // 1. Post to X
  if (channels.includes('x')) {
    try {
      const tweetText = post.tweet;
      let tweetData;

      if (post.type === 'quote' && post.target_post_id) {
        tweetData = await quoteTweet(tweetText, post.target_post_id);
      } else if (post.category === 'COMMUNITY_PROMPT' && post.metadata?.poll) {
        const poll = post.metadata.poll;
        tweetData = await postPoll(tweetText, poll.options, 1440);
      } else {
        tweetData = await postTweet(tweetText, imagePath || undefined);
      }

      tweetId = tweetData.id;
      console.log(`[Calendar] Published to X: ${post.category} (${tweetId})${post.metadata?.poll ? ' [poll]' : imagePath ? ' [with image]' : ''}`);
    } catch (error: any) {
      const detail = error.data?.detail || error.data?.errors?.[0]?.message || '';
      console.error(`[Calendar] X post failed for ${post.category}: ${error.message}${detail ? ' — ' + detail : ''}`);
      if (error.code === 403 || error.message?.includes('403')) {
        console.error(`[Calendar] 403 likely cause: duplicate content or tweet too long (${post.tweet?.length} chars)`);
      }
    }
  }

  // 2. Post to Telegram
  if (channels.includes('tg') && (post.telegram || post.metadata?.poll)) {
    try {
      let tgResult;

      if (post.category === 'COMMUNITY_PROMPT' && post.metadata?.poll) {
        const poll = post.metadata.poll;
        tgResult = await sendPoll(poll.question, poll.options, post.telegram || undefined);
      } else if (imagePath) {
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
      console.log(`[Calendar] Published to TG: ${post.category} (msg ${tgMessageId})${post.metadata?.poll ? ' [poll]' : imagePath ? ' [with photo]' : ''}`);
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
      channels,
      type: post.type,
      tweet: post.tweet,
      telegram: post.telegram,
      category: post.category,
      metadata: post.metadata,
      postedAt: new Date(),
    });
  } catch (error: any) {
    console.error(`[Calendar] DB log failed:`, error.message);
  }

  dailyCounts[post.category] = (dailyCounts[post.category] || 0) + 1;
}

async function executeWindow(
  contentType: string,
  channels: Channel[],
  windowOpts?: { hcCategory?: string; vaultName?: string },
): Promise<void> {
  if (!canPost(contentType)) {
    console.log(`[Calendar] Daily limit reached for ${contentType}, skipping`);
    return;
  }

  try {
    let post: GeneratedPost;

    switch (contentType) {
      case 'PROJECT_PRIMER':
        post = await generateProjectPrimer();
        break;
      case 'VAULT_PERFORMANCE':
        post = await generateVaultPerformance(windowOpts?.vaultName);
        break;
      case 'COMMUNITY_PROMPT':
        post = await generateCommunityPrompt();
        break;
      case 'HIGH_CONVICTION': {
        const category = windowOpts?.hcCategory || nextHcCategory();
        console.log(`[Calendar] HC category: ${category}`);
        post = await generateHighConvictionAlert(category);
        break;
      }
      case 'TRADER_PROFILE':
        post = await generateTraderAlpha({ rotation: 1, totalTraders: 3 });
        break;
      default:
        console.warn(`[Calendar] Unknown content type: ${contentType}`);
        return;
    }

    await publishPost(post, channels);
  } catch (error: any) {
    console.error(`[Calendar] Error generating ${contentType}:`, error.message);
  }
}

export function startScheduler(): void {
  console.log('[Calendar] Starting content scheduler...');

  // Window 1: 7:30 PM IST / 10:00 AM EDT — Project Primer (X + TG)
  cron.schedule('30 19 * * *', () => {
    setTimeout(() => executeWindow('PROJECT_PRIMER', ['x', 'tg']), randomJitter());
  }, { timezone: 'Asia/Kolkata' });

  // Window 2: 10:00 PM IST / 12:30 PM EDT — Vault Performance (X + TG, daily rotation)
  cron.schedule('0 22 * * *', () => {
    const vault = todaysVault();
    console.log(`[Calendar] Today's vault: ${vault}`);
    setTimeout(() => executeWindow('VAULT_PERFORMANCE', ['x', 'tg'], { vaultName: vault }), randomJitter());
  }, { timezone: 'Asia/Kolkata' });

  // Window 3: 12:00 AM IST / 2:30 PM EDT — Community Prompt (X + TG, native polls)
  cron.schedule('0 0 * * *', () => {
    setTimeout(() => executeWindow('COMMUNITY_PROMPT', ['x', 'tg']), randomJitter());
  }, { timezone: 'Asia/Kolkata' });

  // Window 4: 3:00 AM IST / 5:30 PM EDT — High Conviction (X only)
  cron.schedule('0 3 * * *', () => {
    setTimeout(() => executeWindow('HIGH_CONVICTION', ['x']), randomJitter());
  }, { timezone: 'Asia/Kolkata' });

  // Window 5: 6:00 AM IST / 8:30 PM EDT — Trader Profile (X only)
  cron.schedule('0 6 * * *', () => {
    setTimeout(() => executeWindow('TRADER_PROFILE', ['x']), randomJitter());
  }, { timezone: 'Asia/Kolkata' });

  console.log('[Calendar] 5 posting windows scheduled (IST timezone)');
  console.log('[Calendar] Daily: 5 posts on X, 3 posts on TG');
}
