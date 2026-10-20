/**
 * X API v2 Test Script
 *
 * Tests all X API endpoints to verify credentials and functionality.
 * Run with: npm run test:x-api
 *
 * Costs on pay-per-use:
 * - verifyCredentials: 1 read request
 * - postTweet: 1 write request
 * - getMentions: 1 read request
 * - getUserByUsername: 1 read request
 * Total estimated cost: ~$0.05-0.10
 */

import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../../.env.local') });

import {
  verifyCredentials,
  postTweet,
  getMentions,
  getUserByUsername,
  likeTweet,
  getXClient,
} from './lib/x-client';

async function testXApi() {
  console.log('');
  console.log('=== X API v2 Test ===');
  console.log('');

  // Check env vars
  const envVars = ['X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_SECRET', 'X_BEARER_TOKEN'];
  const missing = envVars.filter(v => !process.env[v]);

  if (missing.length > 0) {
    console.error(`Missing environment variables: ${missing.join(', ')}`);
    console.log('\nRequired X API v2 credentials:');
    console.log('  X_API_KEY       - Consumer Key (OAuth 1.0a)');
    console.log('  X_API_SECRET    - Consumer Secret (OAuth 1.0a)');
    console.log('  X_ACCESS_TOKEN  - Access Token (User Context)');
    console.log('  X_ACCESS_SECRET - Access Token Secret (User Context)');
    console.log('  X_BEARER_TOKEN  - Bearer Token (App Context, for reads)');
    process.exit(1);
  }

  // Test 1: Verify credentials
  console.log('1. Testing authentication...');
  try {
    const user = await verifyCredentials();
    console.log(`   ✓ Authenticated as @${user.username} (ID: ${user.id})`);
    console.log(`   Name: ${user.name}`);
  } catch (error: any) {
    console.error(`   ✗ Auth failed: ${error.message}`);
    console.log('\n   Common fixes:');
    console.log('   - Ensure app has "Read and Write" permissions');
    console.log('   - Regenerate access tokens after changing permissions');
    console.log('   - Check if tokens are for the correct X account');
    process.exit(1);
  }

  // Test 2: Get mentions (read)
  console.log('\n2. Testing mentions fetch...');
  try {
    const mentions = await getMentions(undefined, 5);
    const count = mentions?.data?.length || 0;
    console.log(`   ✓ Fetched ${count} recent mentions`);
    if (count > 0) {
      console.log(`   Latest: "${mentions.data[0].text.substring(0, 80)}..."`);
    }
  } catch (error: any) {
    console.log(`   ⚠ Mentions fetch failed (may need elevated access): ${error.message}`);
  }

  // Test 3: Look up a user
  console.log('\n3. Testing user lookup...');
  try {
    const user = await getUserByUsername('base');
    if (user) {
      console.log(`   ✓ Found @${user.username} (ID: ${user.id})`);
    } else {
      console.log('   ⚠ User not found');
    }
  } catch (error: any) {
    console.log(`   ⚠ User lookup failed: ${error.message}`);
  }

  // Test 4: Post a test tweet (optional)
  const testPost = process.argv.includes('--post');
  if (testPost) {
    console.log('\n4. Testing tweet posting...');
    try {
      const tweet = await postTweet(
        `Test from YieldrAgent [${new Date().toISOString().substring(11, 19)}] - verifying X API integration. This will be deleted.`
      );
      console.log(`   ✓ Posted tweet: ${tweet.id}`);
      console.log(`   URL: https://x.com/i/status/${tweet.id}`);

      // Auto-delete test tweet after 5 seconds
      console.log('   Deleting test tweet in 5s...');
      await new Promise(r => setTimeout(r, 5000));
      try {
        const client = getXClient();
        await client.v2.deleteTweet(tweet.id);
        console.log('   ✓ Test tweet deleted');
      } catch {
        console.log('   ⚠ Could not delete test tweet (delete manually)');
      }
    } catch (error: any) {
      console.error(`   ✗ Posting failed: ${error.message}`);
    }
  } else {
    console.log('\n4. Skipping post test (add --post flag to test posting)');
  }

  console.log('\n=== Test complete ===\n');
}

testXApi().catch(console.error);
