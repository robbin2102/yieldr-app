/**
 * Backfill All Manager Wallets
 *
 * One-time script to backfill historical trade data (last 30 days)
 * for all manager wallets with active Avantis positions.
 *
 * Purpose:
 * - Loads all wallets with active Avantis positions from MongoDB
 * - Excludes test wallet (already backfilled)
 * - Runs historical backfiller for each wallet
 * - Populates historicaltrades collection with 30-day history
 *
 * Usage:
 *   npx tsx scripts/backfill-all-managers.ts
 *
 * Environment Variables Required:
 *   - MONGODB_URI: MongoDB connection string
 *   - QUICKNODE_BASE_RPC_URL: Base chain RPC endpoint
 *
 * Configuration:
 *   - DAYS_TO_BACKFILL: Number of days to backfill (default: 30)
 *   - DELAY_BETWEEN_WALLETS_MS: Delay between wallets to avoid rate limits (default: 3000)
 *   - EXCLUDE_WALLETS: Wallets to skip (test wallets, already backfilled, etc.)
 */

import { config } from 'dotenv';
import { resolve } from 'path';
import { createPublicClient, http, parseAbiItem } from 'viem';
import { base } from 'viem/chains';

config({ path: resolve(process.cwd(), '.env.local') });

// Configuration
const DAYS_TO_BACKFILL = 30;
const BLOCKS_PER_DAY = 172800; // Base chain: 2 blocks/sec × 86400 sec/day
const DELAY_BETWEEN_WALLETS_MS = 3000; // 3 seconds between wallets
const BATCH_SIZE = 2000; // Events per batch query

// Wallets to exclude (already backfilled or test wallets)
const EXCLUDE_WALLETS = [
  '0x780bb763e1463d2236fec780b7bd6adb40aaa120', // Test wallet
];

// Constants
const CONTRACTS = {
  EVENTS: '0xC2F4eg24f333e5D51037232Eac77D8aE8093c1d1' as `0x${string}`,
};

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function backfillWallet(
  wallet: string,
  fromBlock: bigint,
  toBlock: bigint,
  client: any,
  processMarketExecuted: any,
  parseMarketExecuted: any,
  parseLimitExecuted: any
): Promise<{ success: boolean; eventsProcessed: number; errors: number }> {
  console.log(`\n${'─'.repeat(70)}`);
  console.log(`📍 Backfilling: ${wallet}`);
  console.log(`${'─'.repeat(70)}`);

  let eventsProcessed = 0;
  let errors = 0;

  try {
    // Fetch MarketExecuted events
    console.log('🔍 Fetching MarketExecuted events...');

    const marketExecutedLogs = await client.getLogs({
      address: CONTRACTS.EVENTS,
      event: parseAbiItem('event MarketExecuted(uint256 indexed orderId, (address trader, uint256 pairIndex, uint256 index, bool open, uint256 initialPosToken, uint256 positionSizeUsdc, uint256 openPrice, bool buy, uint256 leverage, uint256 tp, uint256 sl, uint256 timestamp), (uint256 open, uint256 high, uint256 low, uint256 close), bool orderType, uint256 price, uint256 priceImpactP, int256 percentProfit, uint256 usdcSentToTrader, uint256 executionTxnFee)'),
      fromBlock,
      toBlock,
    });

    const relevantMarket = marketExecutedLogs.filter(log => {
      const parsed = parseMarketExecuted(log);
      return parsed && parsed.trader.toLowerCase() === wallet.toLowerCase();
    });

    console.log(`  Found ${relevantMarket.length} MarketExecuted events for this wallet`);

    // Fetch LimitExecuted events
    console.log('🔍 Fetching LimitExecuted events...');

    const limitExecutedLogs = await client.getLogs({
      address: CONTRACTS.EVENTS,
      event: parseAbiItem('event LimitExecuted(uint256 indexed orderId, uint256 limitIndex, (address trader, uint256 pairIndex, uint256 index, bool open, uint256 initialPosToken, uint256 positionSizeUsdc, uint256 openPrice, bool buy, uint256 leverage, uint256 tp, uint256 sl, uint256 timestamp), (uint256 open, uint256 high, uint256 low, uint256 close), uint8 orderType, uint256 price, uint256 priceImpactP, int256 percentProfit, uint256 usdcSentToTrader, uint256 executionTxnFee)'),
      fromBlock,
      toBlock,
    });

    const relevantLimit = limitExecutedLogs.filter(log => {
      const parsed = parseLimitExecuted(log);
      return parsed && parsed.trader.toLowerCase() === wallet.toLowerCase();
    });

    console.log(`  Found ${relevantLimit.length} LimitExecuted events for this wallet\n`);

    const totalEvents = relevantMarket.length + relevantLimit.length;

    if (totalEvents === 0) {
      console.log('ℹ️  No events found for this wallet in the specified range.');
      return { success: true, eventsProcessed: 0, errors: 0 };
    }

    console.log(`💾 Processing ${totalEvents} events...\n`);

    // Process MarketExecuted
    for (const log of relevantMarket) {
      try {
        const parsed = parseMarketExecuted(log);
        if (!parsed) continue;

        await processMarketExecuted(parsed);
        eventsProcessed++;

        if (eventsProcessed % 10 === 0) {
          console.log(`  Processed ${eventsProcessed}/${totalEvents} events...`);
        }
      } catch (error: any) {
        errors++;
        console.error(`  ❌ Error processing event:`, error.message);
      }
    }

    // Process LimitExecuted
    for (const log of relevantLimit) {
      try {
        const parsed = parseLimitExecuted(log);
        if (!parsed) continue;

        await processMarketExecuted(parsed);
        eventsProcessed++;

        if (eventsProcessed % 10 === 0) {
          console.log(`  Processed ${eventsProcessed}/${totalEvents} events...`);
        }
      } catch (error: any) {
        errors++;
        console.error(`  ❌ Error processing event:`, error.message);
      }
    }

    console.log(`\n✅ Wallet backfill complete: ${eventsProcessed} events processed, ${errors} errors`);

    return { success: errors === 0, eventsProcessed, errors };

  } catch (error: any) {
    console.error(`\n❌ Failed to backfill wallet ${wallet}:`, error.message);
    return { success: false, eventsProcessed, errors: errors + 1 };
  }
}

async function main() {
  console.log('='.repeat(70));
  console.log('Backfill All Manager Wallets - Historical Trades (30 Days)');
  console.log('='.repeat(70));
  console.log(`Started at: ${new Date().toLocaleString()}\n`);

  try {
    // Import modules
    const { default: connectDB } = await import('../lib/mongoose');
    const { default: Position } = await import('../models/Position');
    const { processMarketExecuted } = await import('../services/avantis-listener/EventCorrelator');
    const { parseMarketExecuted, parseLimitExecuted } = await import('../services/avantis-listener/EventParser');

    // Connect to MongoDB
    console.log('🔌 Connecting to MongoDB...');
    await connectDB();
    console.log('✅ Connected to MongoDB\n');

    // Load all wallets with active Avantis positions
    console.log('📍 Loading wallets with active Avantis positions...');
    const allWallets = await Position.distinct('walletAddress', {
      platform: 'Avantis',
      status: 'active',
    });

    // Exclude test wallets
    const walletsToBackfill = allWallets.filter(
      wallet => !EXCLUDE_WALLETS.includes(wallet.toLowerCase())
    );

    console.log(`Total wallets found: ${allWallets.length}`);
    console.log(`Excluded wallets: ${allWallets.length - walletsToBackfill.length}`);
    console.log(`Wallets to backfill: ${walletsToBackfill.length}\n`);

    if (walletsToBackfill.length === 0) {
      console.log('⚠️  No wallets to backfill. Exiting.');
      process.exit(0);
    }

    console.log('Wallets to process:');
    walletsToBackfill.forEach((wallet, i) => {
      console.log(`  ${i + 1}. ${wallet}`);
    });
    console.log();

    // Create RPC client
    const rpcUrl = process.env.QUICKNODE_BASE_RPC_URL;
    if (!rpcUrl) {
      throw new Error('QUICKNODE_BASE_RPC_URL environment variable not set');
    }

    const client = createPublicClient({
      chain: base,
      transport: http(rpcUrl),
    });

    console.log('🔌 Connected to Base RPC\n');

    // Calculate block range (last 30 days)
    const latestBlock = await client.getBlockNumber();
    const blocksToBackfill = BigInt(DAYS_TO_BACKFILL * BLOCKS_PER_DAY);
    const fromBlock = latestBlock - blocksToBackfill;

    console.log('📦 Block Range:');
    console.log(`  Latest: ${latestBlock}`);
    console.log(`  From: ${fromBlock} (${DAYS_TO_BACKFILL} days ago)`);
    console.log(`  Total blocks: ${Number(blocksToBackfill)}\n`);

    // Process each wallet
    const results = {
      total: walletsToBackfill.length,
      successful: 0,
      failed: 0,
      totalEventsProcessed: 0,
      totalErrors: 0,
    };

    for (let i = 0; i < walletsToBackfill.length; i++) {
      const wallet = walletsToBackfill[i];

      console.log(`\n[${'█'.repeat(i + 1)}${' '.repeat(walletsToBackfill.length - i - 1)}] ${i + 1}/${walletsToBackfill.length}`);

      const result = await backfillWallet(
        wallet,
        fromBlock,
        latestBlock,
        client,
        processMarketExecuted,
        parseMarketExecuted,
        parseLimitExecuted
      );

      if (result.success) {
        results.successful++;
      } else {
        results.failed++;
      }

      results.totalEventsProcessed += result.eventsProcessed;
      results.totalErrors += result.errors;

      // Delay before next wallet (avoid rate limits)
      if (i < walletsToBackfill.length - 1) {
        console.log(`\n⏳ Waiting ${DELAY_BETWEEN_WALLETS_MS / 1000}s before next wallet...`);
        await sleep(DELAY_BETWEEN_WALLETS_MS);
      }
    }

    // Final summary
    console.log('\n' + '='.repeat(70));
    console.log('✅ Batch Backfill Complete');
    console.log('='.repeat(70));
    console.log(`Total Wallets: ${results.total}`);
    console.log(`Successful: ${results.successful}`);
    console.log(`Failed: ${results.failed}`);
    console.log(`Total Events Processed: ${results.totalEventsProcessed}`);
    console.log(`Total Errors: ${results.totalErrors}`);
    console.log(`Finished at: ${new Date().toLocaleString()}`);
    console.log('='.repeat(70) + '\n');

    process.exit(results.failed > 0 ? 1 : 0);

  } catch (error: any) {
    console.error('\n❌ Fatal Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main();
