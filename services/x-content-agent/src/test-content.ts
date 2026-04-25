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

import { generateStructuredContent } from './lib/grok-client';
import { YIELDR_AGENT_SYSTEM_PROMPT } from './content/system-prompt';
import { buildTraderAlphaPrompt } from './content/templates/trader-alpha';
import { buildHighConvictionPrompt } from './content/templates/high-conviction';
import { buildEdgePositionPrompt } from './content/templates/edge-position';
import { buildVaultPerformancePrompt } from './content/templates/vault-performance';
import * as mcp from './lib/mcp-client';

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
  console.log('  Fetching edge-ranked traders...');
  const data = await mcp.getEdgeRankedTraders({ sortBy: 'rank_score', limit: 4 });
  const traders = data.traders || [];
  if (traders.length === 0) throw new Error('No traders found');

  const traderIndex = rotation
    ? Math.min(rotation - 1, traders.length - 1)
    : Math.floor(Math.random() * Math.min(3, traders.length));

  const trader = traders[traderIndex];
  console.log(`  Selected trader: ${trader.displayName || trader.label || trader.wallet?.slice(0, 10)}`);
  console.log(`  Specialty: ${trader.specialty}, WR: ${trader.metrics?.winRate?.toFixed(1)}%`);

  const prompt = buildTraderAlphaPrompt(trader, {
    rotation: rotation || 1,
    totalTraders: Math.min(4, traders.length),
  });

  return generateStructuredContent(YIELDR_AGENT_SYSTEM_PROMPT, prompt, { temperature: 0.85 });
}

async function testHighConviction(category?: string): Promise<DualContent> {
  const cat = category || 'NBA';
  console.log(`  Fetching edge trader positions (category: ${cat})...`);

  // Primary: edge trader open positions
  let positionData = await mcp.getEdgeTraderPositions({ category: cat, limit: 10, minPercentPnl: 5 });
  let positions = positionData.positions || [];

  if (positions.length === 0) {
    console.log(`  No positions for ${cat}, trying without category filter...`);
    positionData = await mcp.getEdgeTraderPositions({ limit: 10, minPercentPnl: 5 });
    positions = positionData.positions || [];
  }

  if (positions.length === 0) {
    console.log('  Lowering bar — any profitable position...');
    positionData = await mcp.getEdgeTraderPositions({ category: cat, limit: 10 });
    positions = positionData.positions || [];
  }

  if (positions.length > 0) {
    const position = positions[0];
    console.log(`  Top position: "${position.title?.substring(0, 50)}" +${position.percentPnl?.toFixed(1)}% (+$${position.cashPnl?.toFixed(0)})`);
    console.log(`  Trader: rank #${position.traderRank}, WR ${position.traderWinRate?.toFixed(1)}%, PF ${position.traderProfitFactor?.toFixed(2)}x`);
    const prompt = buildEdgePositionPrompt(position);
    return generateStructuredContent(YIELDR_AGENT_SYSTEM_PROMPT, prompt, { temperature: 0.85 });
  }

  // Fallback: copy trade activity
  console.log('  No edge positions found, falling back to copy trades...');
  let trades: any[] = [];
  try {
    const copyData = await mcp.getCopyTradeActivity({ hours: 168, limit: 5 });
    trades = copyData.trades || [];
    if (trades.length > 0) {
      console.log(`  Found ${trades.length} filled copy trades`);
    }
  } catch (e: any) {
    console.log(`  Copy trade fetch failed: ${e.message}`);
  }

  if (trades.length === 0) throw new Error('No edge positions or copy trades found');

  const trade = trades.sort((a: any, b: any) => (b.convictionRatio || 0) - (a.convictionRatio || 0))[0];
  console.log(`  Top trade: "${trade.market?.substring(0, 50)}" (${trade.convictionRatio}x conviction)`);

  const prompt = buildHighConvictionPrompt(trade);
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
      status: 'Active',
      performance: { period: '30d', roi: 12.4, totalPnl: 8500, latestNav: 108500 },
      stats: { totalTrades: 47, winRate: 68.2, openPositionCount: 12, winningPositionCount: 8, totalUnrealizedPnl: 3200 },
      activity24h: { tradesExecuted: 3, trades: [
        { side: 'BUY', market: 'Will the Lakers win vs Celtics?', outcome: 'Yes', price: 0.62 },
        { side: 'BUY', market: 'Jokic MVP 2026?', outcome: 'Yes', price: 0.44 },
      ]},
      recentTrades: [
        { market: 'Will the Lakers win vs Celtics?', side: 'BUY', outcome: 'Yes', price: 0.62, size: 500, pnl: 180, reasoning: 'Top NBA trader with 78% WR went 4x size on this market' },
      ],
      openPositions: [
        { market: 'Jokic MVP 2026?', outcome: 'Yes', avgPrice: 0.35, curPrice: 0.44, unrealizedPnl: 450, pnlPercent: 25 },
        { market: 'Thunder win Western Conference?', outcome: 'Yes', avgPrice: 0.28, curPrice: 0.38, unrealizedPnl: 320, pnlPercent: 35 },
      ],
    };
    const prompt = buildVaultPerformancePrompt(mockVault);
    return generateStructuredContent(YIELDR_AGENT_SYSTEM_PROMPT, prompt, { temperature: 0.85 });
  }

  const vault = vaults[Math.floor(Math.random() * vaults.length)];
  const roiStr = vault.performance?.vaultROI != null ? `${vault.performance.vaultROI.toFixed(1)}%` : 'N/A';
  console.log(`  Vault: ${vault.name} | ${vault.openPositions?.length || 0} positions | ROI: ${roiStr}`);
  if (vault._debug) {
    console.log(`  DEBUG: specialty="${vault._debug.rawSpecialty}" label="${vault._debug.rawLabel}" display="${vault._debug.rawDisplayName}"`);
    console.log(`  DEBUG: edge_hypothesis="${vault._debug.rawEdgeHypothesis}"`);
    console.log(`  DEBUG: wallet="${vault._debug.walletUsed}" posSource="${vault._debug.positionSource}" posCount=${vault._debug.positionCount}`);
    console.log(`  DEBUG: sample pos: ${vault._debug.rawPositionSample}`);
    console.log(`  DEBUG: vault keys: ${vault._debug.vaultDocKeys}`);
  }
  if (vault.openPositions?.length > 0) {
    console.log(`  Sample position: ${JSON.stringify(vault.openPositions[0]).substring(0, 200)}`);
  }

  const prompt = buildVaultPerformancePrompt(vault);
  return generateStructuredContent(YIELDR_AGENT_SYSTEM_PROMPT, prompt, { temperature: 0.85 });
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
