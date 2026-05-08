/**
 * X (Twitter) API v2 Client
 *
 * Uses twitter-api-v2 package with OAuth 1.0a User Context
 * for posting on behalf of @yieldrdotorg.
 *
 * Pay-per-use model - be mindful of API costs:
 * - POST /2/tweets: charges per tweet
 * - GET endpoints: charges per request
 */

import { TwitterApi, UserV2 } from 'twitter-api-v2';
import * as fs from 'fs';

interface TweetResult {
  id: string;
  text: string;
}
import { CONFIG } from '../config';

let client: TwitterApi | null = null;
let readOnlyClient: TwitterApi | null = null;
let authenticatedUserId: string | null = null;

/**
 * Initialize the X API client with OAuth 1.0a (User Context)
 * Required for posting tweets on behalf of the user
 */
export function getXClient(): TwitterApi {
  if (!client) {
    // Read at call time so dotenv has a chance to load before first use
    client = new TwitterApi({
      appKey: process.env.X_API_KEY || CONFIG.X_API_KEY,
      appSecret: process.env.X_API_SECRET || CONFIG.X_API_SECRET,
      accessToken: process.env.X_ACCESS_TOKEN || CONFIG.X_ACCESS_TOKEN,
      accessSecret: process.env.X_ACCESS_SECRET || CONFIG.X_ACCESS_SECRET,
    });
  }
  return client;
}

/**
 * Get read-only client using Bearer Token (App Context)
 * Cheaper for read operations
 */
export function getReadOnlyClient(): TwitterApi {
  if (!readOnlyClient) {
    readOnlyClient = new TwitterApi(process.env.X_BEARER_TOKEN || CONFIG.X_BEARER_TOKEN);
  }
  return readOnlyClient;
}

/**
 * Verify credentials and get authenticated user ID
 */
export async function verifyCredentials(): Promise<UserV2> {
  const xClient = getXClient();
  const me = await xClient.v2.me();
  authenticatedUserId = me.data.id;
  console.log(`[X] Authenticated as @${me.data.username} (ID: ${me.data.id})`);
  return me.data;
}

/**
 * Get the authenticated user's ID
 */
export function getAuthenticatedUserId(): string | null {
  return authenticatedUserId;
}

// ═══════════════════════════════════════════════════════════════
// Posting
// ═══════════════════════════════════════════════════════════════

/**
 * Upload media (image) and return media_id string
 */
export async function uploadMedia(filePath: string): Promise<string> {
  const xClient = getXClient();
  const mediaId = await xClient.v1.uploadMedia(filePath);
  console.log(`[X] Uploaded media: ${mediaId}`);
  return mediaId;
}

/**
 * Post a tweet, optionally with an image
 */
export async function postTweet(content: string, imagePath?: string): Promise<TweetResult> {
  const xClient = getXClient();

  let mediaIds: string[] | undefined;
  if (imagePath && fs.existsSync(imagePath)) {
    try {
      const mediaId = await uploadMedia(imagePath);
      mediaIds = [mediaId];
    } catch (error: any) {
      console.error(`[X] Media upload failed, posting without image:`, error.message);
    }
  }

  const params: any = {};
  if (mediaIds) params.media = { media_ids: mediaIds };

  const result = await xClient.v2.tweet(content, params);
  console.log(`[X] Posted tweet: ${result.data.id}`);
  return result.data;
}

/**
 * Post a tweet with a native poll
 */
export async function postPoll(
  content: string,
  options: string[],
  durationMinutes: number = 1440,
  imagePath?: string,
): Promise<TweetResult> {
  const xClient = getXClient();

  let mediaIds: string[] | undefined;
  if (imagePath && fs.existsSync(imagePath)) {
    try {
      const mediaId = await uploadMedia(imagePath);
      mediaIds = [mediaId];
    } catch (error: any) {
      console.error(`[X] Media upload failed, posting poll without image:`, error.message);
    }
  }

  const params: any = {
    poll: {
      options: options.slice(0, 4),
      duration_minutes: durationMinutes,
    },
  };
  if (mediaIds) params.media = { media_ids: mediaIds };

  const result = await xClient.v2.tweet(content, params);
  console.log(`[X] Posted poll: ${result.data.id} (${options.length} options, ${durationMinutes}min)`);
  return result.data;
}

/**
 * Reply to a tweet
 */
export async function replyToTweet(content: string, replyToId: string): Promise<TweetResult> {
  const xClient = getXClient();
  const result = await xClient.v2.reply(content, replyToId);
  console.log(`[X] Replied to ${replyToId}: ${result.data.id}`);
  return result.data;
}

/**
 * Quote tweet
 */
export async function quoteTweet(content: string, quotedTweetId: string): Promise<TweetResult> {
  const xClient = getXClient();
  const result = await xClient.v2.tweet(content, {
    quote_tweet_id: quotedTweetId,
  });
  console.log(`[X] Quote tweeted ${quotedTweetId}: ${result.data.id}`);
  return result.data;
}

// ═══════════════════════════════════════════════════════════════
// Engagement
// ═══════════════════════════════════════════════════════════════

/**
 * Like a tweet
 */
export async function likeTweet(tweetId: string): Promise<void> {
  const xClient = getXClient();
  const userId = authenticatedUserId;
  if (!userId) throw new Error('Not authenticated - call verifyCredentials first');
  await xClient.v2.like(userId, tweetId);
  console.log(`[X] Liked tweet: ${tweetId}`);
}

// ═══════════════════════════════════════════════════════════════
// Reading (use sparingly - pay per use)
// ═══════════════════════════════════════════════════════════════

/**
 * Get mentions of authenticated user
 * COST: charges per request in pay-per-use
 */
export async function getMentions(sinceId?: string, maxResults: number = 10) {
  const xClient = getXClient();
  const userId = authenticatedUserId;
  if (!userId) throw new Error('Not authenticated');

  const params: any = {
    max_results: maxResults,
    'tweet.fields': ['created_at', 'author_id', 'conversation_id', 'in_reply_to_user_id'],
  };
  if (sinceId) params.since_id = sinceId;

  const mentions = await xClient.v2.userMentionTimeline(userId, params);
  return mentions.data;
}

/**
 * Get recent tweets from a specific user (for Base account monitoring)
 * COST: charges per request
 */
export async function getUserTweets(userId: string, maxResults: number = 5) {
  const roClient = getReadOnlyClient();
  const tweets = await roClient.v2.userTimeline(userId, {
    max_results: maxResults,
    'tweet.fields': ['created_at', 'public_metrics'],
  });
  return tweets.data;
}

/**
 * Look up user by username
 */
export async function getUserByUsername(username: string): Promise<UserV2 | null> {
  const roClient = getReadOnlyClient();
  try {
    const result = await roClient.v2.userByUsername(username);
    return result.data;
  } catch {
    return null;
  }
}

/**
 * Search recent tweets
 * COST: charges per request - use sparingly
 */
export async function searchTweets(query: string, maxResults: number = 10) {
  const roClient = getReadOnlyClient();
  const result = await roClient.v2.search(query, {
    max_results: maxResults,
    'tweet.fields': ['created_at', 'author_id', 'public_metrics'],
  });
  return result.data;
}
