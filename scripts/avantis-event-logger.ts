/**
 * Avantis Event Logger
 *
 * Designed to run as a 5-minute cron job (Vercel or local)
 *
 * Purpose:
 * - Monitors wallets with active Avantis positions
 * - Checks last 10 minutes of blockchain events
 * - Logs new events to historicaltrades collection
 * - Does NOT modify positions collection (Python service manages that)
 *
 * Usage:
 *   npx tsx scripts/avantis-event-logger.ts
 *
 * Environment Variables Required:
 *   - MONGODB_URI: MongoDB connection string
 *   - QUICKNODE_BASE_RPC_URL: Base chain RPC endpoint
 */

import { config } from 'dotenv';
import { resolve } from 'path';
import { createPublicClient, http, parseAbiItem } from 'viem';
import { base } from 'viem/chains';

config({ path: resolve(process.cwd(), '.env.local') });

// Constants
const CONTRACTS = {
  EVENTS: '0x0c16ff40065cc3ab4bc55b60e447504afb9c7970' as `0x${string}`,
};

const BLOCKS_PER_10_MINUTES = 600; // Base chain: ~2 blocks/sec = 600 blocks per 10 min
const BATCH_SIZE = 2000; // Events per batch query

async function main() {
  console.log('='.repeat(70));
  console.log('Avantis Event Logger');
  console.log('='.repeat(70));
  console.log(`Started at: ${new Date().toLocaleString()}\n`);

  try {
    // Import modules dynamically
    const { default: connectDB } = await import('../lib/mongoose');
    const { default: Position } = await import('../models/Position');
    const { processMarketExecuted } = await import('../services/avantis-listener/EventCorrelator');
    const { parseMarketExecuted, parseLimitExecuted } = await import('../services/avantis-listener/EventParser');

    // Connect to MongoDB
    console.log('🔌 Connecting to MongoDB...');
    await connectDB();
    console.log('✅ Connected to MongoDB\n');

    // Step 1: Load all wallets with active Avantis positions
    console.log('📍 Loading wallets with active Avantis positions...');
    const wallets = await Position.distinct('walletAddress', {
      platform: 'Avantis',
      status: 'active',
    });

    console.log(`Found ${wallets.length} wallets to monitor:\n`);
    wallets.forEach((wallet, i) => {
      console.log(`  ${i + 1}. ${wallet}`);
    });
    console.log();

    if (wallets.length === 0) {
      console.log('⚠️  No active Avantis positions found. Exiting.');
      process.exit(0);
    }

    // Step 2: Create RPC client
    const rpcUrl = process.env.QUICKNODE_BASE_RPC_URL;
    if (!rpcUrl) {
      throw new Error('QUICKNODE_BASE_RPC_URL environment variable not set');
    }

    const client = createPublicClient({
      chain: base,
      transport: http(rpcUrl),
    });

    console.log('🔌 Connected to Base RPC\n');

    // Step 3: Calculate block range (last 10 minutes)
    const latestBlock = await client.getBlockNumber();
    const fromBlock = latestBlock - BigInt(BLOCKS_PER_10_MINUTES);

    console.log('📦 Block Range:');
    console.log(`  Latest: ${latestBlock}`);
    console.log(`  From: ${fromBlock} (last ~10 minutes)`);
    console.log(`  Range: ${Number(latestBlock - fromBlock)} blocks\n`);

    // Step 4: Fetch MarketExecuted events
    console.log('🔍 Fetching MarketExecuted events...');

    const marketExecutedLogs = await client.getLogs({
      address: CONTRACTS.EVENTS,
      event: parseAbiItem('event MarketExecuted(uint256 indexed orderId, (address trader, uint256 pairIndex, uint256 index, bool open, uint256 initialPosToken, uint256 positionSizeUsdc, uint256 openPrice, bool buy, uint256 leverage, uint256 tp, uint256 sl, uint256 timestamp), (uint256 open, uint256 high, uint256 low, uint256 close), bool orderType, uint256 price, uint256 priceImpactP, int256 percentProfit, uint256 usdcSentToTrader, uint256 executionTxnFee)'),
      fromBlock,
      toBlock: latestBlock,
    });

    console.log(`  Found ${marketExecutedLogs.length} MarketExecuted events`);

    // Step 5: Fetch LimitExecuted events
    console.log('🔍 Fetching LimitExecuted events...');

    const limitExecutedLogs = await client.getLogs({
      address: CONTRACTS.EVENTS,
      event: parseAbiItem('event LimitExecuted(uint256 indexed orderId, uint256 limitIndex, (address trader, uint256 pairIndex, uint256 index, bool open, uint256 initialPosToken, uint256 positionSizeUsdc, uint256 openPrice, bool buy, uint256 leverage, uint256 tp, uint256 sl, uint256 timestamp), (uint256 open, uint256 high, uint256 low, uint256 close), uint8 orderType, uint256 price, uint256 priceImpactP, int256 percentProfit, uint256 usdcSentToTrader, uint256 executionTxnFee)'),
      fromBlock,
      toBlock: latestBlock,
    });

    console.log(`  Found ${limitExecutedLogs.length} LimitExecuted events\n`);

    // Step 6: Filter events for monitored wallets
    const walletSet = new Set(wallets.map(w => w.toLowerCase()));

    const relevantMarketEvents = marketExecutedLogs.filter(log => {
      const parsed = parseMarketExecuted(log);
      return parsed && walletSet.has(parsed.trader.toLowerCase());
    });

    const relevantLimitEvents = limitExecutedLogs.filter(log => {
      const parsed = parseLimitExecuted(log);
      return parsed && walletSet.has(parsed.trader.toLowerCase());
    });

    const totalRelevant = relevantMarketEvents.length + relevantLimitEvents.length;

    console.log('📊 Filtered Events:');
    console.log(`  Relevant MarketExecuted: ${relevantMarketEvents.length}`);
    console.log(`  Relevant LimitExecuted: ${relevantLimitEvents.length}`);
    console.log(`  Total to process: ${totalRelevant}\n`);

    if (totalRelevant === 0) {
      console.log('✅ No new events found for monitored wallets.');
      console.log('Exiting successfully.\n');
      process.exit(0);
    }

    // Step 7: Process events
    console.log('💾 Processing and saving events...\n');

    let processed = 0;
    let skipped = 0;
    let errors = 0;

    // Process MarketExecuted events
    for (const log of relevantMarketEvents) {
      try {
        const parsed = parseMarketExecuted(log);
        if (!parsed) {
          skipped++;
          continue;
        }

        await processMarketExecuted(parsed);
        processed++;

        console.log(`  [${processed}/${totalRelevant}] ${parsed.open ? 'OPEN' : 'CLOSE'} - ${parsed.trader.substring(0, 10)}... - orderId: ${parsed.orderId}`);
      } catch (error: any) {
        errors++;
        console.error(`  ❌ Error processing MarketExecuted log:`, error.message);
      }
    }

    // Process LimitExecuted events
    for (const log of relevantLimitEvents) {
      try {
        const parsed = parseLimitExecuted(log);
        if (!parsed) {
          skipped++;
          continue;
        }

        await processMarketExecuted(parsed); // Same processor works for both
        processed++;

        console.log(`  [${processed}/${totalRelevant}] ${parsed.open ? 'OPEN' : 'CLOSE'} (LIMIT) - ${parsed.trader.substring(0, 10)}... - orderId: ${parsed.orderId}`);
      } catch (error: any) {
        errors++;
        console.error(`  ❌ Error processing LimitExecuted log:`, error.message);
      }
    }

    // Step 8: Summary
    console.log('\n' + '='.repeat(70));
    console.log('✅ Event Logger Complete');
    console.log('='.repeat(70));
    console.log(`Monitored Wallets: ${wallets.length}`);
    console.log(`Events Found: ${totalRelevant}`);
    console.log(`Successfully Processed: ${processed}`);
    console.log(`Skipped: ${skipped}`);
    console.log(`Errors: ${errors}`);
    console.log(`Finished at: ${new Date().toLocaleString()}`);
    console.log('='.repeat(70) + '\n');

    process.exit(errors > 0 ? 1 : 0);

  } catch (error: any) {
    console.error('\n❌ Fatal Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main();
