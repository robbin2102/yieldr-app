/**
 * Telegram Integration Test
 *
 * Verifies bot access, sends a test message, and optionally generates
 * a real content post to the channel.
 *
 * Run with: npx tsx services/x-content-agent/src/test-telegram.ts
 * Options:
 *   --verify-only        Just check bot access, don't post
 *   --live               Generate real content and post to channel
 *   --type=VAULT_PERFORMANCE  Content type for --live mode
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const dotenv = require('dotenv');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require('path');

dotenv.config({ path: path.resolve(process.cwd(), 'services/x-content-agent/.env') });
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

import { verifyBotAccess, sendChannelMessage, sendChannelMessageWithButton } from './lib/tg-client';
import { generateTraderAlpha, generateHighConvictionAlert, generateVaultPerformance } from './content/generator';

const SEPARATOR = '═'.repeat(70);

async function main() {
  console.log('');
  console.log(SEPARATOR);
  console.log('           📱 TELEGRAM INTEGRATION TEST');
  console.log(SEPARATOR);

  if (!process.env.TELEGRAM_BOT_TOKEN) {
    console.error('\n  ❌ Missing TELEGRAM_BOT_TOKEN');
    console.error('  Create a bot via @BotFather and set the token in .env');
    process.exit(1);
  }
  if (!process.env.TELEGRAM_CHANNEL_ID) {
    console.error('\n  ❌ Missing TELEGRAM_CHANNEL_ID');
    console.error('  Set to @your_channel_name or the numeric -100xxx ID');
    process.exit(1);
  }

  console.log(`  Bot token: ${process.env.TELEGRAM_BOT_TOKEN.substring(0, 10)}...`);
  console.log(`  Channel: ${process.env.TELEGRAM_CHANNEL_ID}`);

  // Step 1: Verify bot access
  console.log('\n  🔍 Verifying bot access...');
  const access = await verifyBotAccess();
  if (!access.ok) {
    console.error(`\n  ❌ Bot cannot access channel: ${access.error}`);
    console.error('  Make sure the bot is added as an admin with "Post Messages" permission');
    process.exit(1);
  }
  console.log(`  ✅ Bot has access to: "${access.chatTitle}"`);

  const verifyOnly = process.argv.includes('--verify-only');
  if (verifyOnly) {
    console.log('\n  Done (--verify-only mode)');
    return;
  }

  // Step 2: Send test message
  console.log('\n  📤 Sending test message...');
  const testMsg = await sendChannelMessageWithButton(
    '🤖 **Yieldr Agent Test**\n\nTelegram integration is live. Content posts will appear here automatically.\n\n📊 NBA Edge Vault | ⚽ Soccer Alpha Vault | 🌍 Geopolitics Vault',
    'Visit Yieldr →',
    'https://yieldr.org',
  );
  console.log(`  ✅ Test message sent: message_id=${testMsg.message_id}`);

  // Step 3: Optionally generate and post real content
  const liveMode = process.argv.includes('--live');
  if (!liveMode) {
    console.log('\n  💡 Run with --live to generate real content and post to channel');
    console.log('     --live --type=TRADER_PROFILE');
    console.log('     --live --type=HIGH_CONVICTION');
    console.log('     --live --type=VAULT_PERFORMANCE');
    return;
  }

  const typeArg = process.argv.find(a => a.startsWith('--type='))?.split('=')[1]?.toUpperCase() || 'VAULT_PERFORMANCE';
  console.log(`\n  ⏳ Generating ${typeArg} content...`);

  let post;
  switch (typeArg) {
    case 'TRADER_PROFILE':
      post = await generateTraderAlpha({ rotation: 1, totalTraders: 4, source: 'test' });
      break;
    case 'HIGH_CONVICTION':
      post = await generateHighConvictionAlert('NBA', 'test');
      break;
    case 'VAULT_PERFORMANCE':
      post = await generateVaultPerformance(undefined, 'test');
      break;
    default:
      console.error(`  ❌ Unknown type: ${typeArg}`);
      process.exit(1);
  }

  console.log(`\n  📱 TG content (${post.telegram.length} chars):`);
  post.telegram.split('\n').forEach((line: string) => console.log(`    ${line}`));

  console.log('\n  📤 Posting to channel...');
  const result = await sendChannelMessageWithButton(
    post.telegram,
    'Track live →',
    'https://yieldr.org',
  );
  console.log(`  ✅ Posted: message_id=${result.message_id}`);

  console.log('');
  console.log(SEPARATOR);
  console.log('  📊 DONE — check your Telegram channel');
  console.log(SEPARATOR);
  console.log('');
}

main().catch(err => {
  console.error(`\n  ❌ ${err.message}`);
  process.exit(1);
});
