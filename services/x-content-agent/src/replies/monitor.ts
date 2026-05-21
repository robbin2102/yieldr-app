/**
 * Reply Monitor
 * Polls for new mentions and generates contextual replies.
 *
 * Cost controls:
 *   - Polls every 15 minutes (not 3) to reduce GET request costs
 *   - Skips mentions from our own account (prevents self-reply loops)
 *   - Max 1 reply per conversation (prevents back-and-forth chains)
 *   - Daily cap of 20 replies to limit runaway costs
 *
 * Double-reply prevention:
 *   - On startup: fetches our last 50 tweets to seed already-replied IDs
 *   - Per mention: checks MongoDB x_mentions collection before replying
 *   - Per conversation: checks if we already replied in same thread
 *   - NEEDS_HUMAN_REPLY: logs but doesn't post
 */

import { getMentions, getUserTweets, getAuthenticatedUserId, likeTweet, replyToTweet } from '../lib/x-client';
import { generateReply } from '../content/generator';
import { getDB, COLLECTIONS } from '../lib/db';
import { CONFIG } from '../config';

let intervalId: NodeJS.Timeout | null = null;
let lastSeenMentionId: string | null = null;
let isRunning = false;
let dailyReplyCount = 0;
let lastReplyCountReset = '';

const DAILY_REPLY_CAP = 20;

function resetDailyReplyCount(): void {
  const today = new Date().toISOString().split('T')[0];
  if (today !== lastReplyCountReset) {
    dailyReplyCount = 0;
    lastReplyCountReset = today;
  }
}

async function seedRepliedMentions(): Promise<void> {
  try {
    const userId = getAuthenticatedUserId();
    if (!userId) {
      console.log('[Replies] No authenticated user ID — skipping startup seed');
      return;
    }

    const tweetsResult = await getUserTweets(userId, 50);
    const tweets = tweetsResult?.data || [];

    if (tweets.length > 0) {
      const db = await getDB();
      let seeded = 0;

      for (const tweet of tweets) {
        const replyTo = (tweet as any).in_reply_to_user_id;
        const convId = (tweet as any).conversation_id;

        if (convId && convId !== tweet.id) {
          const existing = await db.collection(COLLECTIONS.X_MENTIONS).findOne({
            tweetId: convId,
          });
          if (!existing) {
            await db.collection(COLLECTIONS.X_MENTIONS).insertOne({
              tweetId: convId,
              authorId: replyTo || 'unknown',
              text: '',
              processed: true,
              repliedTo: true,
              seededOnStartup: true,
              indexedAt: new Date(),
            });
            seeded++;
          }
        }
      }

      if (seeded > 0) {
        console.log(`[Replies] Seeded ${seeded} already-replied mention IDs from recent tweets`);
      }
    }
  } catch (error: any) {
    console.error('[Replies] Tweet seed failed (non-critical):', error.message);
  }

  try {
    const mentionsResult = await getMentions(undefined, 10);
    const mentions = mentionsResult?.data || [];
    if (mentions.length > 0) {
      let newest = mentions[0].id;
      for (const m of mentions) {
        if (m.id > newest) newest = m.id;
      }
      lastSeenMentionId = newest;
      console.log(`[Replies] Cursor set to latest mention ${newest} — will only process newer mentions`);
    } else {
      console.log('[Replies] No existing mentions found — starting fresh');
    }
  } catch (error: any) {
    console.error('[Replies] Mention cursor seed failed (non-critical):', error.message);
  }
}

async function processNewMentions(): Promise<void> {
  if (isRunning) return;
  isRunning = true;

  try {
    resetDailyReplyCount();

    if (dailyReplyCount >= DAILY_REPLY_CAP) {
      console.log(`[Replies] Daily reply cap reached (${DAILY_REPLY_CAP}), skipping poll`);
      return;
    }

    const mentionsResult = await getMentions(lastSeenMentionId || undefined, 10);
    const mentions = mentionsResult?.data || [];

    if (mentions.length === 0) return;

    const db = await getDB();
    const ownUserId = getAuthenticatedUserId();

    for (const mention of mentions) {
      if (!lastSeenMentionId || mention.id > lastSeenMentionId) {
        lastSeenMentionId = mention.id;
      }

      // Skip our own tweets (prevents self-reply loops in threads)
      if (mention.author_id === ownUserId) {
        continue;
      }

      // Skip if daily cap reached
      if (dailyReplyCount >= DAILY_REPLY_CAP) {
        console.log(`[Replies] Daily cap reached, skipping remaining mentions`);
        break;
      }

      const existing = await db.collection(COLLECTIONS.X_MENTIONS).findOne({
        tweetId: mention.id,
      });
      if (existing) continue;

      // Check conversation limit — max 1 reply per conversation thread
      const convId = (mention as any).conversation_id;
      if (convId) {
        const alreadyRepliedInConv = await db.collection(COLLECTIONS.X_REPLIES).findOne({
          conversationId: convId,
        });
        if (alreadyRepliedInConv) {
          await db.collection(COLLECTIONS.X_MENTIONS).insertOne({
            tweetId: mention.id,
            authorId: mention.author_id,
            text: mention.text,
            createdAt: mention.created_at ? new Date(mention.created_at) : new Date(),
            processed: true,
            repliedTo: false,
            skippedReason: 'conversation_limit',
            indexedAt: new Date(),
          });
          continue;
        }
      }

      await db.collection(COLLECTIONS.X_MENTIONS).insertOne({
        tweetId: mention.id,
        authorId: mention.author_id,
        text: mention.text,
        createdAt: mention.created_at ? new Date(mention.created_at) : new Date(),
        processed: false,
        repliedTo: false,
        indexedAt: new Date(),
      });

      if (isSpam(mention.text)) {
        console.log(`[Replies] Skipping spam mention: ${mention.id}`);
        await db.collection(COLLECTIONS.X_MENTIONS).updateOne(
          { tweetId: mention.id },
          { $set: { processed: true, spam: true } },
        );
        continue;
      }

      try {
        const reply = await generateReply({
          text: mention.text,
          authorUsername: mention.author_id || 'user',
          tweetId: mention.id,
        });

        if (reply.metadata?.needsHuman || reply.tweet === 'NEEDS_HUMAN_REPLY') {
          console.log(`[Replies] NEEDS_HUMAN_REPLY for mention ${mention.id}: "${mention.text?.substring(0, 80)}"`);
          await db.collection(COLLECTIONS.X_MENTIONS).updateOne(
            { tweetId: mention.id },
            { $set: { processed: true, repliedTo: false, needsHuman: true } },
          );
          continue;
        }

        await replyToTweet(reply.tweet, mention.id);
        await likeTweet(mention.id);

        await db.collection(COLLECTIONS.X_REPLIES).insertOne({
          parentTweetId: mention.id,
          conversationId: convId || mention.id,
          content: reply.tweet,
          category: 'MENTION_REPLY',
          metadata: reply.metadata,
          postedAt: new Date(),
        });

        await db.collection(COLLECTIONS.X_MENTIONS).updateOne(
          { tweetId: mention.id },
          { $set: { processed: true, repliedTo: true, repliedAt: new Date() } },
        );

        dailyReplyCount++;
        console.log(`[Replies] Replied to mention ${mention.id} (${dailyReplyCount}/${DAILY_REPLY_CAP} today)`);

        await new Promise(r => setTimeout(r, 30000 + Math.random() * 30000));
      } catch (error: any) {
        console.error(`[Replies] Error replying to ${mention.id}:`, error.message);
      }
    }
  } catch (error: any) {
    console.error('[Replies] Monitor error:', error.message);
  } finally {
    isRunning = false;
  }
}

function isSpam(text: string): boolean {
  const spamPatterns = [
    /free (airdrop|giveaway|drop)/i,
    /dm me/i,
    /send \d+ (eth|btc|sol)/i,
    /click (this|here|the link)/i,
    /\b(scam|rug|ponzi)\b/i,
  ];
  return spamPatterns.some(p => p.test(text));
}

export function startReplyMonitor(): void {
  if (process.env.DISABLE_REPLY_MONITOR === 'true') {
    console.log('[Replies] Monitor disabled via DISABLE_REPLY_MONITOR env var');
    return;
  }

  console.log(`[Replies] Starting reply monitor (every ${CONFIG.REPLY_POLL_INTERVAL_MS / 60000}m, cap ${DAILY_REPLY_CAP}/day)`);

  setTimeout(async () => {
    await seedRepliedMentions();
    processNewMentions();
    intervalId = setInterval(processNewMentions, CONFIG.REPLY_POLL_INTERVAL_MS);
  }, 60_000);
}

export function stopReplyMonitor(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log('[Replies] Monitor stopped');
  }
}
