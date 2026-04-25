/**
 * Content Quality Test Script
 *
 * Generates sample content for ALL 5 post types using real MCP data + Grok.
 * Produces both X tweet (280 chars) and TG channel post for each.
 *
 * Run with: npx tsx services/x-content-agent/src/test-content.ts
 * Options:
 *   --type=TRADER_PROFILE   Only test one type
 *   --type=HIGH_CONVICTION
 *   --type=MARKETS_ALPHA
 *   --type=VAULT_PERFORMANCE
 *   --type=BASE_POSTING
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const dotenv = require('dotenv');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require('path');

dotenv.config({ path: path.resolve(process.cwd(), 'services/x-content-agent/.env') });
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

import { generateStructuredContent } from './lib/grok-client';
import { YIELDR_AGENT_SYSTEM_PROMPT } from './content/system-prompt';
import { buildTraderAlphaPrompt } from './content/templates/trader-alpha';
import { buildMarketsAlphaPrompt } from './content/templates/markets-alpha';
import { buildHighConvictionPrompt } from './content/templates/high-conviction';
import { buildVaultPerformancePrompt } from './content/templates/vault-performance';
import { buildBasePostingPrompt } from './content/templates/base-posting';
import * as mcp from './lib/mcp-client';

const DUAL_OUTPUT_INSTRUCTION = `

IMPORTANT: Return JSON with BOTH an X tweet and a Telegram channel post:
{
  "type": "post",
  "tweet": "X tweet text (max 280 chars, no hashtags, end with question + CTA)",
  "telegram": "Telegram channel post (can be longer, use markdown bold **text**, bullet points, emojis for visual appeal, include key data points, 3-8 lines, end with CTA to join TG or visit yieldr.org)"
}`;

interface DualContent {
  type: string;
  tweet: string;
  telegram: string;
}

const SEPARATOR = '═'.repeat(70);
const THIN_SEP = '─'.repeat(70);

function printResult(category: string, result: DualContent) {
  console.log('');
  console.log(SEPARATOR);
  console.log(`  ${category}`);
  console.log(SEPARATOR);
  console.log('');
  console.log('  X TWEET:');
  console.log(`  ${result.tweet}`);
  console.log(`  [${result.tweet?.length || 0} chars]`);
  console.log('');
  console.log(THIN_SEP);
  console.log('');
  console.log('  TG POST:');
  console.log(`  ${result.telegram}`);
  console.log('');
}

async function testTraderProfile(): Promise<DualContent> {
  console.log('  Fetching edge-ranked traders...');
  const data = await mcp.getEdgeRankedTraders({ sortBy: 'rank_score', limit: 5 });
  const traders = data.traders || [];
  if (traders.length === 0) throw new Error('No traders found');

  const trader = traders[Math.floor(Math.random() * Math.min(3, traders.length))];
  const prompt = buildTraderAlphaPrompt(trader) + DUAL_OUTPUT_INSTRUCTION;
  return generateStructuredContent(YIELDR_AGENT_SYSTEM_PROMPT, prompt, { temperature: 0.85 });
}

async function testHighConviction(): Promise<DualContent> {
  console.log('  Fetching high conviction trades...');
  let data = await mcp.getHighConvictionTrades({ convictionLevel: 'ALL', hours: 168, limit: 5 });
  let trades = data.trades || [];

  if (trades.length === 0) {
    console.log('  No HC trades in materialized view, using trader positions directly...');
    const traderData = await mcp.getEdgeRankedTraders({ sortBy: 'rank_score', limit: 3 });
    const topTrader = traderData.traders?.[0];
    if (topTrader?.highConviction?.recentTrades?.length > 0) {
      const hcTrade = topTrader.highConviction.recentTrades[0];
      trades = [{
        traderLabel: topTrader.displayName || `Trader-${topTrader.wallet?.slice(0, 6)}`,
        market: hcTrade.market,
        outcome: hcTrade.outcome,
        price: hcTrade.price,
        usdcValue: hcTrade.usdcSize,
        sizeMultiplier: hcTrade.sizeMultiplier,
        convictionLevel: (hcTrade.sizeMultiplier || 0) >= 50 ? 'WHALE' : 'SIGNIFICANT',
        traderContext: {
          winRate: topTrader.metrics?.winRate,
          profitFactor: topTrader.metrics?.profitFactor,
          avgTradeSize: topTrader.metrics?.avgTradeSize,
        },
        wallet: topTrader.wallet,
      }];
    }
  }

  if (trades.length === 0) throw new Error('No high conviction trades found anywhere');

  const trade = trades[0];
  const prompt = buildHighConvictionPrompt(trade) + DUAL_OUTPUT_INSTRUCTION;
  return generateStructuredContent(YIELDR_AGENT_SYSTEM_PROMPT, prompt, { temperature: 0.85 });
}

async function testMarketsAlpha(): Promise<DualContent> {
  console.log('  Searching markets...');
  const keywords = ['Trump', 'Iran', 'NBA', 'Bitcoin'];
  const keyword = keywords[Math.floor(Math.random() * keywords.length)];
  console.log(`  Keyword: "${keyword}"`);

  const marketData = await mcp.searchMarketsByKeyword([keyword], { limit: 5 });
  const markets = marketData.markets || [];

  let traderPositions: any[] = [];
  if (markets.length > 0 && markets[0].conditionId) {
    const posData = await mcp.getTraderPositionsInMarket({
      conditionId: markets[0].conditionId,
      edgeTradersOnly: true,
    });
    traderPositions = posData.positions || [];
  }

  const prompt = buildMarketsAlphaPrompt({
    markets,
    traderPositions,
    trendKeyword: keyword,
  }) + DUAL_OUTPUT_INSTRUCTION;

  return generateStructuredContent(YIELDR_AGENT_SYSTEM_PROMPT, prompt, { temperature: 0.85 });
}

async function testVaultPerformance(): Promise<DualContent> {
  console.log('  Fetching vault performance...');
  const data = await mcp.getVaultPerformance({ period: '30d' });
  const vaults = data.vaults || [];

  if (vaults.length === 0) {
    console.log('  No vault data — generating with placeholder...');
    const mockVault = {
      name: 'NBA Edge Vault',
      description: 'AI agent ranks top NBA prediction market traders by statistical edge and mirrors highest-conviction positions.',
      performance: { period: '30d', roi: 12.4, totalPnl: 8500, latestNav: 108500 },
      stats: { totalTrades: 47, winRate: 68.2, subscribers: 0 },
      recentTrades: [],
      openPositions: [],
    };
    const prompt = buildVaultPerformancePrompt(mockVault) + DUAL_OUTPUT_INSTRUCTION;
    return generateStructuredContent(YIELDR_AGENT_SYSTEM_PROMPT, prompt, { temperature: 0.85 });
  }

  const vault = vaults[Math.floor(Math.random() * vaults.length)];
  const prompt = buildVaultPerformancePrompt(vault) + DUAL_OUTPUT_INSTRUCTION;
  return generateStructuredContent(YIELDR_AGENT_SYSTEM_PROMPT, prompt, { temperature: 0.85 });
}

async function testBasePosting(): Promise<DualContent> {
  console.log('  Generating Base ecosystem post...');
  const prompt = buildBasePostingPrompt({
    sourcePost: {
      text: 'Base just hit $10B in TVL. The ecosystem is growing faster than any L2 in history.',
      author: 'jessepollak',
      tweetId: '1234567890',
    },
  }) + DUAL_OUTPUT_INSTRUCTION;

  return generateStructuredContent(YIELDR_AGENT_SYSTEM_PROMPT, prompt, { temperature: 0.85 });
}

async function main() {
  console.log('');
  console.log(SEPARATOR);
  console.log('           CONTENT QUALITY TEST');
  console.log('           X Tweet + TG Post for each type');
  console.log(SEPARATOR);

  // Check env
  if (!process.env.XAI_API_KEY) {
    console.error('\n  Missing XAI_API_KEY in .env.local');
    process.exit(1);
  }
  if (!process.env.MCP_SERVER_URL) {
    console.error('\n  Missing MCP_SERVER_URL in .env.local');
    console.error('  Set to: https://mcp-demo-production-59da.up.railway.app');
    process.exit(1);
  }

  console.log(`  MCP Server: ${process.env.MCP_SERVER_URL}`);
  console.log(`  Grok Model: grok-4-1-fast-reasoning`);

  const typeFilter = process.argv.find(a => a.startsWith('--type='))?.split('=')[1];

  const tests: { name: string; fn: () => Promise<DualContent> }[] = [
    { name: 'TRADER_PROFILE', fn: testTraderProfile },
    { name: 'HIGH_CONVICTION', fn: testHighConviction },
    { name: 'MARKETS_ALPHA', fn: testMarketsAlpha },
    { name: 'VAULT_PERFORMANCE', fn: testVaultPerformance },
    { name: 'BASE_POSTING', fn: testBasePosting },
  ];

  const filtered = typeFilter
    ? tests.filter(t => t.name === typeFilter.toUpperCase())
    : tests;

  if (filtered.length === 0) {
    console.error(`\n  Unknown type: ${typeFilter}`);
    console.error('  Available: TRADER_PROFILE, HIGH_CONVICTION, MARKETS_ALPHA, VAULT_PERFORMANCE, BASE_POSTING');
    process.exit(1);
  }

  let passed = 0;
  let failed = 0;

  for (const test of filtered) {
    try {
      console.log(`\n  Generating ${test.name}...`);
      const result = await test.fn();
      printResult(test.name, result);
      passed++;
    } catch (error: any) {
      console.log('');
      console.log(SEPARATOR);
      console.log(`  ${test.name} — FAILED`);
      console.log(SEPARATOR);
      console.log(`  Error: ${error.message}`);
      failed++;
    }
  }

  console.log('');
  console.log(SEPARATOR);
  console.log(`  RESULTS: ${passed} passed, ${failed} failed out of ${filtered.length}`);
  console.log(SEPARATOR);
  console.log('');
}

main().catch(console.error);
