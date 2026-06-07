/**
 * Content Calendar & Scheduler
 *
 * 2 posts/day, 10h+ gap between windows.
 * Channels controlled by ENABLE_X and ENABLE_TG env vars.
 *
 * Schedule (IST → EDT):
 *   1. 8:00 PM / 10:30 AM — Vault Performance (daily rotation: NBA → Soccer → Geo)
 *   2. 6:00 AM / 8:30 PM — Trader Profile / High Conviction (alternating daily)
 */

import * as cron from 'node-cron';
import { CONFIG } from '../config';
import {
  generateTraderAlpha,
  generateHighConvictionAlert,
  generateVaultPerformance,
  GeneratedPost,
} from '../content/generator';
import { postTweet, postPoll, quoteTweet } from '../lib/x-client';
import { sendChannelMessageWithButton, sendPhotoWithButton, sendPoll } from '../lib/tg-client';
import { getCategoryImage } from '../lib/category-images';
import { getDB, COLLECTIONS } from '../lib/db';

type Channel = 'x' | 'tg';

const VAULT_ROTATION = ['NBA Edge Vault', 'Soccer Alpha Vault', 'Geopolitics Vault'];
const HC_CATEGORIES = ['NBA', 'Soccer', 'Politics'];

const dailyCounts: Record<string, number> = {};
let lastResetDate = '';
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

function todaysVault(): string {
  const dayOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0).getTime()) / 86400000);
  return VAULT_ROTATION[dayOfYear % VAULT_ROTATION.length];
}

function isTraderProfileDay(): boolean {
  const dayOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0).getTime()) / 86400000);
  return dayOfYear % 2 === 0;
}

function nextHcCategory(): string {
  const category = HC_CATEGORIES[hcRotation % HC_CATEGORIES.length];
  hcRotation++;
  return category;
}

function canPost(category: string): boolean {
  resetDailyCounts();
  const limit = (CONFIG.DAILY_LIMITS as any)[category] || 999;
  return (dailyCounts[category] || 0) < limit;
}

function enabledChannels(): Channel[] {
  const channels: Channel[] = [];
  if (CONFIG.ENABLE_X) channels.push('x');
  if (CONFIG.ENABLE_TG) channels.push('tg');
  return channels;
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
      console.log(`[Calendar] Published to X: ${post.category} (${tweetId})${imagePath ? ' [with image]' : ''}`);
    } catch (error: any) {
      const detail = error.data?.detail || error.data?.errors?.[0]?.message || '';
      console.error(`[Calendar] X post failed for ${post.category}: ${error.message}${detail ? ' — ' + detail : ''}`);
    }
  }

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
      console.log(`[Calendar] Published to TG: ${post.category} (msg ${tgMessageId})${imagePath ? ' [with photo]' : ''}`);
    } catch (error: any) {
      console.error(`[Calendar] TG post failed for ${post.category}:`, error.message);
    }
  }

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
  if (channels.length === 0) {
    console.log(`[Calendar] Both X and TG disabled, skipping ${contentType}`);
    return;
  }

  if (!canPost(contentType)) {
    console.log(`[Calendar] Daily limit reached for ${contentType}, skipping`);
    return;
  }

  try {
    let post: GeneratedPost;

    switch (contentType) {
      case 'VAULT_PERFORMANCE':
        post = await generateVaultPerformance(windowOpts?.vaultName);
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

  const channels = enabledChannels();
  console.log(`[Calendar] Channels enabled: ${channels.length > 0 ? channels.join(', ') : 'NONE (all posting disabled)'}`);

  // Window 1: 8:00 PM IST / 10:30 AM EDT — Vault Performance (daily rotation)
  cron.schedule('0 20 * * *', () => {
    const vault = todaysVault();
    console.log(`[Calendar] Today's vault: ${vault}`);
    setTimeout(() => executeWindow('VAULT_PERFORMANCE', enabledChannels(), { vaultName: vault }), randomJitter());
  }, { timezone: 'Asia/Kolkata' });

  // Window 2: 6:00 AM IST / 8:30 PM EDT — Trader Profile or HC (alternating daily)
  cron.schedule('0 6 * * *', () => {
    const contentType = isTraderProfileDay() ? 'TRADER_PROFILE' : 'HIGH_CONVICTION';
    console.log(`[Calendar] Window 2: ${contentType}`);
    setTimeout(() => executeWindow(contentType, enabledChannels()), randomJitter());
  }, { timezone: 'Asia/Kolkata' });

  console.log('[Calendar] 2 posting windows scheduled (IST timezone, 10h gap)');
  console.log('[Calendar] Window 1: 8:00 PM IST — Vault Performance');
  console.log('[Calendar] Window 2: 6:00 AM IST — Trader Profile / HC (alternating)');
}
