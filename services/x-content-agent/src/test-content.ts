/**
 * Content Quality Test Script
 *
 * Generates sample content for active post types using real MCP data + Grok.
 * Produces both X tweet and TG channel post for each.
 *
 * Run with: npx tsx services/x-content-agent/src/test-content.ts
 * Options:
 *   --type=TRADER_PROFILE   Only test one type
 *   --type=HIGH_CONVICTION
 *   --type=VAULT_PERFORMANCE
 *   --rotation=2            Trader profile rotation index (1-4)
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const dotenv = require('dotenv');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require('path');

dotenv.config({ path: path.resolve(process.cwd(), 'services/x-content-agent/.env') });
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

import { generateTraderAlpha, generateHighConvictionAlert, generateVaultPerformance, GeneratedPost } from './content/generator';

type DualContent = Pick<GeneratedPost, 'type' | 'tweet' | 'telegram'>;

const SEPARATOR = '═'.repeat(70);
const THIN_SEP = '─'.repeat(70);

function printResult(category: string, result: DualContent) {
  console.log('');
  console.log(SEPARATOR);
  console.log(`  📝 ${category}`);
  console.log(SEPARATOR);
  console.log('');
  console.log('  🐦 X TWEET:');
  console.log('');
  // Print tweet with proper line breaks visible
  const tweetText = result.tweet || '';
  tweetText.split('\n').forEach((line: string) => console.log(`    ${line}`));
  console.log('');
  console.log(`  [${tweetText.length} chars]`);
  console.log('');
  console.log(THIN_SEP);
  console.log('');
  console.log('  📱 TG POST:');
  console.log('');
  const tgText = result.telegram || '';
  tgText.split('\n').forEach((line: string) => console.log(`    ${line}`));
  console.log('');
}

async function testTraderProfile(rotation?: number): Promise<DualContent> {
  console.log('  Generating TRADER_PROFILE via generator...');
  return generateTraderAlpha({ rotation, totalTraders: 4, source: 'test' });
}

async function testHighConviction(category?: string): Promise<DualContent> {
  const cat = category || 'NBA';
  console.log(`  Generating HIGH_CONVICTION via generator (category: ${cat})...`);
  return generateHighConvictionAlert(cat, 'test');
}

async function testVaultPerformance(): Promise<DualContent> {
  console.log('  Generating VAULT_PERFORMANCE via generator...');
  return generateVaultPerformance(undefined, 'test');
}

async function main() {
  console.log('');
  console.log(SEPARATOR);
  console.log('           🚀 CONTENT QUALITY TEST');
  console.log('           X Tweet + TG Post for each type');
  console.log(SEPARATOR);

  // Check env
  if (!process.env.XAI_API_KEY) {
    console.error('\n  ❌ Missing XAI_API_KEY in .env.local');
    process.exit(1);
  }
  if (!process.env.MCP_SERVER_URL) {
    console.error('\n  ❌ Missing MCP_SERVER_URL in .env.local');
    console.error('  Set to: https://mcp-demo-production-59da.up.railway.app');
    process.exit(1);
  }

  console.log(`  MCP Server: ${process.env.MCP_SERVER_URL}`);
  console.log(`  Grok Model: grok-4-1-fast-reasoning`);

  const typeFilter = process.argv.find(a => a.startsWith('--type='))?.split('=')[1];
  const rotationArg = process.argv.find(a => a.startsWith('--rotation='))?.split('=')[1];
  const categoryArg = process.argv.find(a => a.startsWith('--category='))?.split('=')[1];
  const rotation = rotationArg ? parseInt(rotationArg) : undefined;

  const tests: { name: string; fn: () => Promise<DualContent> }[] = [
    { name: 'TRADER_PROFILE', fn: () => testTraderProfile(rotation) },
    { name: 'HIGH_CONVICTION', fn: () => testHighConviction(categoryArg) },
    { name: 'VAULT_PERFORMANCE', fn: testVaultPerformance },
  ];

  const filtered = typeFilter
    ? tests.filter(t => t.name === typeFilter.toUpperCase())
    : tests;

  if (filtered.length === 0) {
    console.error(`\n  ❌ Unknown type: ${typeFilter}`);
    console.error('  Available: TRADER_PROFILE, HIGH_CONVICTION, VAULT_PERFORMANCE');
    process.exit(1);
  }

  let passed = 0;
  let failed = 0;

  for (const test of filtered) {
    try {
      console.log(`\n  ⏳ Generating ${test.name}...`);
      const result = await test.fn();
      printResult(test.name, result);
      passed++;
    } catch (error: any) {
      console.log('');
      console.log(SEPARATOR);
      console.log(`  ❌ ${test.name} — FAILED`);
      console.log(SEPARATOR);
      console.log(`  Error: ${error.message}`);
      if (error.response?.data) {
        console.log(`  Response: ${JSON.stringify(error.response.data).substring(0, 200)}`);
      }
      failed++;
    }
  }

  console.log('');
  console.log(SEPARATOR);
  console.log(`  📊 RESULTS: ${passed} passed, ${failed} failed out of ${filtered.length}`);
  console.log(SEPARATOR);
  console.log('');
}

main().catch(console.error);
