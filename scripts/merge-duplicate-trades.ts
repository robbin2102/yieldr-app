/**
 * Merge duplicate trades and fix timestamps
 *
 * Process:
 * 1. Fetch tradeIndex for CLOSED trades from their closedTxHash
 * 2. Match EXECUTED and CLOSED trades by (trader, pairIndex, tradeIndex)
 * 3. Merge data: keep CLOSED entry, add executedAt from EXECUTED
 * 4. Fix timestamps using block data
 * 5. Calculate correct duration
 * 6. Delete duplicate EXECUTED entries
 */

import { config } from 'dotenv';
import { resolve } from 'path';

config({ path: resolve(process.cwd(), '.env.local') });

async function main() {
  try {
    console.log('🔧 Merging duplicate trades and fixing timestamps...\n');

    const { default: TradeEvent } = await import('../models/TradeEvent');
    const { default: connectDB } = await import('../lib/mongoose');
    const { getTransactionReceipt, getBlock } = await import('../services/avantis-listener/core/ViemClient');
    const { decodeEventLog } = await import('viem');
    const { MARKET_EXECUTED_EVENT } = await import('../services/avantis-listener/config/events');

    await connectDB();
    console.log('✓ MongoDB connected\n');

    // Get all trades
    const allTrades = await TradeEvent.find({});
    console.log('Total trades in DB: ' + allTrades.length);

    const executedTrades = await TradeEvent.find({ status: 'EXECUTED' });
    const closedTrades = await TradeEvent.find({ status: 'CLOSED' });

    console.log('EXECUTED trades: ' + executedTrades.length);
    console.log('CLOSED trades: ' + closedTrades.length + '\n');

    // Step 1: Add tradeIndex to CLOSED trades by fetching from closedTxHash
    console.log('Step 1: Fetching tradeIndex for CLOSED trades from blockchain...\n');

    let fetchedCount = 0;
    for (const trade of closedTrades) {
      if (trade.tradeIndex !== undefined && trade.tradeIndex !== null) {
        console.log('Trade ' + trade.orderId + ': already has tradeIndex ' + trade.tradeIndex);
        continue;
      }

      if (!trade.closedTxHash) {
        console.log('⚠️  Trade ' + trade.orderId + ': Missing closedTxHash');
        continue;
      }

      try {
        const receipt = await getTransactionReceipt(trade.closedTxHash as `0x${string}`);

        // Find MarketExecuted event in logs
        const marketExecutedLog = receipt.logs.find((log: any) => {
          try {
            const decoded = decodeEventLog({
              abi: [MARKET_EXECUTED_EVENT],
              data: log.data,
              topics: log.topics,
            });
            return decoded.eventName === 'MarketExecuted';
          } catch {
            return false;
          }
        });

        if (marketExecutedLog) {
          const decoded = decodeEventLog({
            abi: [MARKET_EXECUTED_EVENT],
            data: marketExecutedLog.data,
            topics: marketExecutedLog.topics,
          });

          const args = decoded.args as any;
          const tradeData = args.t as any;
          const tradeIndex = Number(tradeData.index);

          trade.tradeIndex = tradeIndex;
          await trade.save();

          console.log('✓ Trade ' + trade.orderId + ': tradeIndex = ' + tradeIndex);
          fetchedCount++;
        } else {
          console.log('⚠️  Trade ' + trade.orderId + ': MarketExecuted event not found in tx');
        }
      } catch (error) {
        console.error('❌ Trade ' + trade.orderId + ': Failed to fetch tradeIndex:', error);
      }
    }

    console.log('\n✓ Fetched tradeIndex for ' + fetchedCount + '/' + closedTrades.length + ' CLOSED trades\n');

    // Step 2: Match and merge EXECUTED and CLOSED trades
    console.log('Step 2: Matching and merging duplicate trades...\n');

    // Reload closed trades with updated tradeIndex
    const updatedClosedTrades = await TradeEvent.find({ status: 'CLOSED' });

    let mergedCount = 0;
    let deletedCount = 0;

    for (const closedTrade of updatedClosedTrades) {
      if (closedTrade.tradeIndex === undefined || closedTrade.tradeIndex === null) {
        console.log('⚠️  CLOSED trade ' + closedTrade.orderId + ': Missing tradeIndex, skipping');
        continue;
      }

      // Find matching EXECUTED trade
      const matchingExecuted = await TradeEvent.findOne({
        status: 'EXECUTED',
        trader: closedTrade.trader,
        pairIndex: closedTrade.pairIndex,
        tradeIndex: closedTrade.tradeIndex,
      });

      if (matchingExecuted) {
        console.log('✓ Found match:');
        console.log('  EXECUTED orderId: ' + matchingExecuted.orderId + ' (tradeIndex: ' + matchingExecuted.tradeIndex + ')');
        console.log('  CLOSED orderId: ' + closedTrade.orderId + ' (tradeIndex: ' + closedTrade.tradeIndex + ')');

        // Merge data: copy executedAt from EXECUTED to CLOSED
        if (matchingExecuted.executedAt && !closedTrade.executedAt) {
          closedTrade.executedAt = matchingExecuted.executedAt;
          closedTrade.executedTxHash = matchingExecuted.executedTxHash;
          closedTrade.executedBlockNumber = matchingExecuted.executedBlockNumber;

          // Also copy any other missing open data
          if (!closedTrade.openPrice && matchingExecuted.openPrice) {
            closedTrade.openPrice = matchingExecuted.openPrice;
          }
          if (!closedTrade.leverage && matchingExecuted.leverage) {
            closedTrade.leverage = matchingExecuted.leverage;
          }
          if (!closedTrade.collateralUsdc && matchingExecuted.collateralUsdc) {
            closedTrade.collateralUsdc = matchingExecuted.collateralUsdc;
          }
          if (!closedTrade.positionSizeUsdc && matchingExecuted.positionSizeUsdc) {
            closedTrade.positionSizeUsdc = matchingExecuted.positionSizeUsdc;
          }

          await closedTrade.save();
          console.log('  → Merged executedAt: ' + matchingExecuted.executedAt.toISOString());
        }

        // Delete the duplicate EXECUTED entry
        await TradeEvent.deleteOne({ _id: matchingExecuted._id });
        console.log('  → Deleted duplicate EXECUTED entry\n');

        mergedCount++;
        deletedCount++;
      } else {
        console.log('⚠️  CLOSED trade ' + closedTrade.orderId + ' (tradeIndex: ' + closedTrade.tradeIndex + '): No matching EXECUTED trade found\n');
      }
    }

    console.log('✓ Merged ' + mergedCount + ' trade pairs');
    console.log('✓ Deleted ' + deletedCount + ' duplicate EXECUTED entries\n');

    // Step 3: Fix timestamps using block data
    console.log('Step 3: Fixing timestamps from blockchain blocks...\n');

    const finalClosedTrades = await TradeEvent.find({ status: 'CLOSED' });

    // Collect all unique block numbers
    const executedBlocks = new Set<number>();
    const closedBlocks = new Set<number>();

    for (const trade of finalClosedTrades) {
      if (trade.executedBlockNumber) executedBlocks.add(trade.executedBlockNumber);
      if (trade.closedBlockNumber) closedBlocks.add(trade.closedBlockNumber);
    }

    const allBlocks = [...new Set([...executedBlocks, ...closedBlocks])];
    console.log('Fetching timestamps for ' + allBlocks.length + ' unique blocks...');

    const blockTimestamps = new Map<number, Date>();
    const blockPromises = allBlocks.map(async (blockNumber) => {
      try {
        const block = await getBlock(BigInt(blockNumber));
        return { blockNumber, timestamp: new Date(Number(block.timestamp) * 1000) };
      } catch (error) {
        console.error('Failed to fetch block ' + blockNumber + ':', error);
        return null;
      }
    });

    const blockResults = await Promise.all(blockPromises);
    for (const result of blockResults) {
      if (result) blockTimestamps.set(result.blockNumber, result.timestamp);
    }

    console.log('✓ Fetched ' + blockTimestamps.size + '/' + allBlocks.length + ' block timestamps\n');

    // Update trades with correct timestamps and durations
    let fixedCount = 0;
    for (const trade of finalClosedTrades) {
      let needsUpdate = false;
      let correctOpenTime: Date | null = null;
      let correctCloseTime: Date | null = null;

      // Get correct open time from executedBlockNumber
      if (trade.executedBlockNumber && blockTimestamps.has(trade.executedBlockNumber)) {
        correctOpenTime = blockTimestamps.get(trade.executedBlockNumber)!;
        if (!trade.executedAt || trade.executedAt.getTime() !== correctOpenTime.getTime()) {
          trade.executedAt = correctOpenTime;
          needsUpdate = true;
        }
      }

      // Get correct close time from closedBlockNumber
      if (trade.closedBlockNumber && blockTimestamps.has(trade.closedBlockNumber)) {
        correctCloseTime = blockTimestamps.get(trade.closedBlockNumber)!;
        if (trade.closedAt.getTime() !== correctCloseTime.getTime()) {
          trade.closedAt = correctCloseTime;
          needsUpdate = true;
        }
      }

      // Calculate correct duration
      if (correctOpenTime && correctCloseTime) {
        const durationMs = correctCloseTime.getTime() - correctOpenTime.getTime();
        const durationSeconds = Math.floor(durationMs / 1000);

        if (trade.durationSeconds !== durationSeconds) {
          const oldDuration = trade.durationSeconds;
          trade.durationSeconds = durationSeconds;
          needsUpdate = true;

          console.log('✓ Fixed trade ' + trade.orderId + ':');
          console.log('  executedAt: ' + correctOpenTime.toISOString());
          console.log('  closedAt: ' + correctCloseTime.toISOString());
          console.log('  duration: ' + oldDuration + 's → ' + durationSeconds + 's (' + (durationSeconds / 3600).toFixed(1) + 'h)\n');
        }
      }

      if (needsUpdate) {
        await trade.save();
        fixedCount++;
      }
    }

    console.log('✓ Fixed timestamps and durations for ' + fixedCount + ' trades\n');

    // Final summary
    const finalCount = await TradeEvent.countDocuments();
    const finalExecuted = await TradeEvent.countDocuments({ status: 'EXECUTED' });
    const finalClosed = await TradeEvent.countDocuments({ status: 'CLOSED' });

    console.log('=== FINAL SUMMARY ===');
    console.log('Total trades: ' + finalCount + ' (was ' + allTrades.length + ')');
    console.log('EXECUTED (open positions): ' + finalExecuted);
    console.log('CLOSED (completed trades): ' + finalClosed);
    console.log('Duplicates removed: ' + deletedCount);

    process.exit(0);
  } catch (error) {
    console.error('❌ Failed:', error);
    process.exit(1);
  }
}

main();
