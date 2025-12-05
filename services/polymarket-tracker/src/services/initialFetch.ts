import { fetchOpenPositions } from '../api/positions';
import { fetchClosedPositions } from '../api/closedPositions';
import { fetchHistoricalTrades } from '../api/activity';
import { OpenPosition as OpenPositionModel } from '../db/models/OpenPosition';
import { ClosedPosition as ClosedPositionModel } from '../db/models/ClosedPosition';
import { Trade as TradeModel } from '../db/models/Trade';
import { computeMetrics, saveMetrics } from './metrics';
import { config } from '../config';
import { createLogger } from '../utils/logger';

const logger = createLogger('InitialFetch');

export async function fetchAllDataForWallet(walletAddress: string) {
  const wallet = walletAddress.toLowerCase();

  logger.info(`${'='.repeat(60)}`);
  logger.info(`Starting initial fetch for wallet: ${wallet}`);
  logger.info(`${'='.repeat(60)}`);

  try {
    // 1. Fetch open positions (no pagination needed)
    logger.info('Step 1/5: Fetching open positions...');
    const openPositions = await fetchOpenPositions(wallet);
    logger.success(`✓ Fetched ${openPositions.length} open positions`);

    // 2. Fetch closed positions (last 30 days with pagination)
    logger.info('Step 2/5: Fetching closed positions...');
    const closedPositions = await fetchClosedPositions(wallet, config.polymarket.historicalDays);
    logger.success(`✓ Fetched ${closedPositions.length} closed positions`);

    // 3. Fetch historical trades (last 30 days with pagination)
    logger.info('Step 3/5: Fetching historical trades...');
    const trades = await fetchHistoricalTrades(wallet, config.polymarket.historicalDays);
    logger.success(`✓ Fetched ${trades.length} trades`);

    // 4. Compute metrics
    logger.info('Step 4/5: Computing performance metrics...');
    const metrics = await computeMetrics(wallet, openPositions, closedPositions);

    // 5. Save to MongoDB
    logger.info('Step 5/5: Saving to MongoDB...');

    // Save open positions (upsert to handle duplicates)
    for (const position of openPositions) {
      await OpenPositionModel.findOneAndUpdate(
        {
          walletAddress: position.walletAddress,
          conditionId: position.conditionId,
          asset: position.asset,
        },
        position,
        { upsert: true, new: true }
      );
    }
    logger.success(`✓ Saved ${openPositions.length} open positions`);

    // Save closed positions (upsert to handle duplicates)
    for (const position of closedPositions) {
      await ClosedPositionModel.findOneAndUpdate(
        {
          walletAddress: position.walletAddress,
          conditionId: position.conditionId,
          asset: position.asset,
        },
        position,
        { upsert: true, new: true }
      );
    }
    logger.success(`✓ Saved ${closedPositions.length} closed positions`);

    // Save trades (skip duplicates based on transactionHash)
    let savedTrades = 0;
    let skippedTrades = 0;

    for (const trade of trades) {
      try {
        await TradeModel.create(trade);
        savedTrades++;
      } catch (error: any) {
        if (error.code === 11000) {
          // Duplicate key error - skip
          skippedTrades++;
        } else {
          throw error;
        }
      }
    }
    logger.success(`✓ Saved ${savedTrades} trades (${skippedTrades} duplicates skipped)`);

    // Save metrics
    await saveMetrics(metrics);

    // Print summary
    logger.info(`\n${'='.repeat(60)}`);
    logger.info('INITIAL FETCH COMPLETE');
    logger.info(`${'='.repeat(60)}`);
    logger.info(`Wallet: ${wallet}`);
    logger.info(`\nPositions:`);
    logger.info(`  Open: ${metrics.openPositionsCount}`);
    logger.info(`  Closed: ${metrics.closedPositionsCount}`);
    logger.info(`\nPerformance (30d):`);
    logger.info(`  Total PnL: $${metrics.totalPnl.toFixed(2)}`);
    logger.info(`  Realized PnL: $${metrics.totalRealizedPnl.toFixed(2)}`);
    logger.info(`  Unrealized PnL: $${metrics.totalUnrealizedPnl.toFixed(2)}`);
    logger.info(`  ROI: ${metrics.overallRoi.toFixed(2)}%`);
    logger.info(`  Win Rate: ${metrics.winRate.toFixed(1)}% (${metrics.wins}W / ${metrics.losses}L)`);
    logger.info(`  Sharpe Ratio: ${metrics.sharpeRatio.toFixed(2)}`);
    logger.info(`\nTime-based PnL:`);
    logger.info(`  1D: $${metrics.pnl1d.toFixed(2)}`);
    logger.info(`  7D: $${metrics.pnl7d.toFixed(2)}`);
    logger.info(`  30D: $${metrics.pnl30d.toFixed(2)}`);
    logger.info(`\nTrades: ${trades.length} total`);
    logger.info(`${'='.repeat(60)}\n`);

    return { openPositions, closedPositions, trades, metrics };
  } catch (error) {
    logger.error(`Failed to fetch data for ${wallet}:`, error);
    throw error;
  }
}
