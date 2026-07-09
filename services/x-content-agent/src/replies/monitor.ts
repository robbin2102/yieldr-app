/**
 * Reply Monitor
 * Polls for new mentions and generates contextual replies
 */

import { getMentions, likeTweet, replyToTweet } from '../lib/x-client';
import { generateReply } from '../content/generator';
import { getDB, COLLECTIONS } from '../lib/db';
import { CONFIG } from '../config';

let intervalId: NodeJS.Timeout | null = null;
let lastSeenMentionId: string | null = null;
let isRunning = false;

async function processNewMentions(): Promise<void> {
  if (isRunning) return;
  isRunning = true;

  try {
    const mentionsResult = await getMentions(lastSeenMentionId || undefined, 10);
    const mentions = mentionsResult?.data || [];

    if (mentions.length === 0) return;

    const db = await getDB();

    for (const mention of mentions) {
      // Update last seen
      if (!lastSeenMentionId || mention.id > lastSeenMentionId) {
        lastSeenMentionId = mention.id;
      }

      // Check if already replied
      const existing = await db.collection(COLLECTIONS.X_MENTIONS).findOne({
        tweetId: mention.id,
      });
      if (existing) continue;

      // Log the mention
      await db.collection(COLLECTIONS.X_MENTIONS).insertOne({
        tweetId: mention.id,
        authorId: mention.author_id,
        text: mention.text,
        createdAt: mention.created_at ? new Date(mention.created_at) : new Date(),
        processed: false,
        repliedTo: false,
        indexedAt: new Date(),
      });

      // Skip if it looks like spam
      if (isSpam(mention.text)) {
        console.log(`[Replies] Skipping spam mention: ${mention.id}`);
        continue;
      }

      try {
        // Generate reply
        const reply = await generateReply({
          text: mention.text,
          authorUsername: mention.author_id || 'user', // Would need user lookup for username
          tweetId: mention.id,
        });

        // Post reply
        await replyToTweet(reply.content, mention.id);

        // Like the mention
        await likeTweet(mention.id);

        // Log reply
        await db.collection(COLLECTIONS.X_REPLIES).insertOne({
          parentTweetId: mention.id,
          content: reply.content,
          category: 'MENTION_REPLY',
          metadata: reply.metadata,
          postedAt: new Date(),
        });

        // Mark mention as replied
        await db.collection(COLLECTIONS.X_MENTIONS).updateOne(
          { tweetId: mention.id },
          { $set: { processed: true, repliedTo: true, repliedAt: new Date() } }
        );

        console.log(`[Replies] Replied to mention ${mention.id}`);

        // Delay between replies (30s - 60s)
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
  console.log(`[Replies] Starting reply monitor (every ${CONFIG.REPLY_POLL_INTERVAL_MS / 60000}m)`);

  // Delay start by 60s
  setTimeout(() => {
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
