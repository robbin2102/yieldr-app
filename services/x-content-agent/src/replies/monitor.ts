/**
 * Reply Monitor
 * Polls for new mentions and generates contextual replies.
 *
 * Double-reply prevention:
 *   - On startup: fetches our last 50 tweets to seed already-replied IDs
 *   - Per mention: checks MongoDB x_mentions collection before replying
 *   - NEEDS_HUMAN_REPLY: logs but doesn't post (flags for manual follow-up)
 */

import { getMentions, getUserTweets, getAuthenticatedUserId, likeTweet, replyToTweet } from '../lib/x-client';
import { generateReply } from '../content/generator';
import { getDB, COLLECTIONS } from '../lib/db';
import { CONFIG } from '../config';

let intervalId: NodeJS.Timeout | null = null;
let lastSeenMentionId: string | null = null;
let isRunning = false;

/**
 * On startup, seed already-replied mention IDs and set the cursor
 * so the first real poll only picks up genuinely new mentions.
 *
 * Two-step approach:
 *   1. Fetch our last 50 tweets — mark their parent conversation IDs as replied
 *   2. Fetch current mentions — set lastSeenMentionId to the newest one
 *      without processing any of them (they pre-date this boot)
 */
async function seedRepliedMentions(): Promise<void> {
  // Step 1: seed conversation IDs from our recent tweets
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

  // Step 2: set cursor to latest mention so first poll only gets new ones
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
    const mentionsResult = await getMentions(lastSeenMentionId || undefined, 10);
    const mentions = mentionsResult?.data || [];

    if (mentions.length === 0) return;

    const db = await getDB();

    for (const mention of mentions) {
      if (!lastSeenMentionId || mention.id > lastSeenMentionId) {
        lastSeenMentionId = mention.id;
      }

      const existing = await db.collection(COLLECTIONS.X_MENTIONS).findOne({
        tweetId: mention.id,
      });
      if (existing) continue;

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

        // NEEDS_HUMAN_REPLY — log and skip, don't post
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
          content: reply.tweet,
          category: 'MENTION_REPLY',
          metadata: reply.metadata,
          postedAt: new Date(),
        });

        await db.collection(COLLECTIONS.X_MENTIONS).updateOne(
          { tweetId: mention.id },
          { $set: { processed: true, repliedTo: true, repliedAt: new Date() } },
        );

        console.log(`[Replies] Replied to mention ${mention.id}`);

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

  console.log(`[Replies] Starting reply monitor (every ${CONFIG.REPLY_POLL_INTERVAL_MS / 60000}m)`);

  // Startup: seed already-replied mentions, then start polling
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
