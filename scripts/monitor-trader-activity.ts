/**
 * Real-time Trade Monitor for Polymarket Wallet
 * Monitors new trades at 1s intervals and provides 60s analytics summaries
 */

import axios from 'axios';

const API_BASE = 'https://data-api.polymarket.com';
const WALLET = '0xecd55daa7c6900683b804d1d4db935fbfabe43f4';
const POLL_INTERVAL = 1000; // 1 second
const SUMMARY_INTERVAL = 60000; // 60 seconds

interface ActivityResponse {
  id: string;
  conditionId: string;
  asset: string;
  title: string;
  slug?: string;
  outcome: string;
  outcomeIndex?: number;
  type: 'TRADE' | 'REDEEM' | 'SPLIT' | 'MERGE' | 'REWARD' | 'CONVERSION';
  side?: 'BUY' | 'SELL';
  size: number;
  price: number;
  usdcSize: number;
  timestamp: number;
  transactionHash: string;
}

interface MarketStats {
  market: string;
  outcome: string;
  buyVolume: number;
  sellVolume: number;
  buyShares: number;
  sellShares: number;
  buyCount: number;
  sellCount: number;
  netVolume: number;
  netShares: number;
  avgBuyPrice: number;
  avgSellPrice: number;
}

class TradeMonitor {
  private lastTimestamp: number;
  private trades: ActivityResponse[] = [];
  private seenTradeIds: Set<string> = new Set();
  private sessionStartTime: number;
  private lastSummaryTime: number;

  constructor() {
    this.lastTimestamp = Math.floor(Date.now() / 1000);
    this.sessionStartTime = Date.now();
    this.lastSummaryTime = Date.now();
  }

  /**
   * Fetch new trades since last check
   */
  async fetchNewTrades(): Promise<ActivityResponse[]> {
    try {
      // Add small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 100));

      const url = `${API_BASE}/activity?user=${WALLET}&type=TRADE&start=${this.lastTimestamp}&limit=500&sortBy=TIMESTAMP&sortDirection=ASC`;

      const response = await axios.get(url, {
        timeout: 10000,
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0'
        },
      });

      const activities: ActivityResponse[] = response.data;

      // Filter out trades we've already seen
      const newTrades = activities.filter(trade => !this.seenTradeIds.has(trade.id));

      // Update last timestamp if we got new trades
      if (newTrades.length > 0) {
        const maxTimestamp = Math.max(...newTrades.map(t => t.timestamp));
        this.lastTimestamp = maxTimestamp;
      }

      // Mark trades as seen
      newTrades.forEach(trade => this.seenTradeIds.add(trade.id));

      return newTrades;
    } catch (error: any) {
      console.error(`❌ Error fetching trades: ${error.message}`);
      return [];
    }
  }

  /**
   * Log a single trade
   */
  logTrade(trade: ActivityResponse, index: number) {
    const timestamp = new Date(trade.timestamp * 1000);
    const timeStr = timestamp.toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      fractional: 3
    });

    const side = trade.side || 'UNKNOWN';
    const sideIcon = side === 'BUY' ? '🟢' : side === 'SELL' ? '🔴' : '⚪';

    console.log(`\n${sideIcon} TRADE #${index + 1} | ${timeStr}`);
    console.log(`   ${side} ${trade.size.toLocaleString()} shares @ $${trade.price.toFixed(4)}`);
    console.log(`   Market: ${trade.title}`);
    console.log(`   Outcome: ${trade.outcome}`);
    console.log(`   Volume: $${trade.usdcSize.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
    console.log(`   TX: ${trade.transactionHash.substring(0, 10)}...`);
  }

  /**
   * Generate analytics summary
   */
  generateSummary() {
    if (this.trades.length === 0) {
      console.log('\n📊 No trades detected in this period.');
      return;
    }

    const now = Date.now();
    const periodDuration = (now - this.lastSummaryTime) / 1000;
    const totalDuration = (now - this.sessionStartTime) / 1000;

    console.log('\n' + '='.repeat(100));
    console.log('📊 60-SECOND SUMMARY');
    console.log('='.repeat(100));
    console.log(`Period: Last ${periodDuration.toFixed(0)}s | Total Session: ${totalDuration.toFixed(0)}s`);
    console.log(`Trades Detected: ${this.trades.length}`);

    // 1. Batch Processing Analysis
    const timestampGroups = new Map<number, ActivityResponse[]>();
    this.trades.forEach(trade => {
      const ts = trade.timestamp;
      if (!timestampGroups.has(ts)) {
        timestampGroups.set(ts, []);
      }
      timestampGroups.get(ts)!.push(trade);
    });

    const batchTrades = Array.from(timestampGroups.values()).filter(group => group.length > 1);
    console.log(`\n🔄 BATCH PROCESSING:`);
    console.log(`   Unique timestamps: ${timestampGroups.size}`);
    console.log(`   Batched executions: ${batchTrades.length}`);

    if (batchTrades.length > 0) {
      console.log(`   Batch details:`);
      batchTrades.forEach((batch, idx) => {
        const ts = new Date(batch[0].timestamp * 1000).toLocaleTimeString();
        console.log(`     Batch ${idx + 1} @ ${ts}: ${batch.length} trades`);
        batch.forEach(t => {
          console.log(`       - ${t.side} ${t.size} ${t.outcome} @ $${t.price.toFixed(4)}`);
        });
      });
    }

    // 2. Buy/Sell Analysis
    const buys = this.trades.filter(t => t.side === 'BUY');
    const sells = this.trades.filter(t => t.side === 'SELL');
    const totalBuyVolume = buys.reduce((sum, t) => sum + t.usdcSize, 0);
    const totalSellVolume = sells.reduce((sum, t) => sum + t.usdcSize, 0);
    const totalBuyShares = buys.reduce((sum, t) => sum + t.size, 0);
    const totalSellShares = sells.reduce((sum, t) => sum + t.size, 0);

    console.log(`\n💰 BUY/SELL ANALYSIS:`);
    console.log(`   Buys:  ${buys.length} trades | ${totalBuyShares.toLocaleString()} shares | $${totalBuyVolume.toLocaleString(undefined, { minimumFractionDigits: 2 })}`);
    console.log(`   Sells: ${sells.length} trades | ${totalSellShares.toLocaleString()} shares | $${totalSellVolume.toLocaleString(undefined, { minimumFractionDigits: 2 })}`);
    console.log(`   Net:   ${(buys.length - sells.length) >= 0 ? '+' : ''}${buys.length - sells.length} trades | ${(totalBuyShares - totalSellShares) >= 0 ? '+' : ''}${(totalBuyShares - totalSellShares).toLocaleString()} shares | $${(totalBuyVolume - totalSellVolume) >= 0 ? '+' : ''}${(totalBuyVolume - totalSellVolume).toLocaleString(undefined, { minimumFractionDigits: 2 })}`);

    // 3. Market-by-Market Analysis
    const marketStats = new Map<string, MarketStats>();

    this.trades.forEach(trade => {
      const key = `${trade.title} | ${trade.outcome}`;

      if (!marketStats.has(key)) {
        marketStats.set(key, {
          market: trade.title,
          outcome: trade.outcome,
          buyVolume: 0,
          sellVolume: 0,
          buyShares: 0,
          sellShares: 0,
          buyCount: 0,
          sellCount: 0,
          netVolume: 0,
          netShares: 0,
          avgBuyPrice: 0,
          avgSellPrice: 0,
        });
      }

      const stats = marketStats.get(key)!;

      if (trade.side === 'BUY') {
        stats.buyVolume += trade.usdcSize;
        stats.buyShares += trade.size;
        stats.buyCount++;
      } else if (trade.side === 'SELL') {
        stats.sellVolume += trade.usdcSize;
        stats.sellShares += trade.size;
        stats.sellCount++;
      }
    });

    // Calculate averages and net
    marketStats.forEach(stats => {
      stats.avgBuyPrice = stats.buyShares > 0 ? stats.buyVolume / stats.buyShares : 0;
      stats.avgSellPrice = stats.sellShares > 0 ? stats.sellVolume / stats.sellShares : 0;
      stats.netVolume = stats.buyVolume - stats.sellVolume;
      stats.netShares = stats.buyShares - stats.sellShares;
    });

    console.log(`\n📈 MARKET-BY-MARKET BREAKDOWN (${marketStats.size} unique positions):`);

    Array.from(marketStats.values())
      .sort((a, b) => Math.abs(b.netVolume) - Math.abs(a.netVolume))
      .forEach((stats, idx) => {
        console.log(`\n   ${idx + 1}. ${stats.market}`);
        console.log(`      Outcome: ${stats.outcome}`);
        console.log(`      Buys:  ${stats.buyCount} trades | ${stats.buyShares.toLocaleString()} shares @ avg $${stats.avgBuyPrice.toFixed(4)} | $${stats.buyVolume.toLocaleString(undefined, { minimumFractionDigits: 2 })}`);
        console.log(`      Sells: ${stats.sellCount} trades | ${stats.sellShares.toLocaleString()} shares @ avg $${stats.avgSellPrice.toFixed(4)} | $${stats.sellVolume.toLocaleString(undefined, { minimumFractionDigits: 2 })}`);
        console.log(`      Net:   ${stats.netShares >= 0 ? '+' : ''}${stats.netShares.toLocaleString()} shares | $${stats.netVolume >= 0 ? '+' : ''}${stats.netVolume.toLocaleString(undefined, { minimumFractionDigits: 2 })} ${stats.netShares > 0 ? '(LONG)' : stats.netShares < 0 ? '(SHORT)' : '(FLAT)'}`);
      });

    // 4. Trading Velocity & Timing
    if (this.trades.length > 1) {
      const timestamps = this.trades.map(t => t.timestamp).sort((a, b) => a - b);
      const intervals: number[] = [];

      for (let i = 1; i < timestamps.length; i++) {
        intervals.push(timestamps[i] - timestamps[i - 1]);
      }

      const avgInterval = intervals.reduce((sum, val) => sum + val, 0) / intervals.length;
      const minInterval = Math.min(...intervals);
      const maxInterval = Math.max(...intervals);

      console.log(`\n⏱️  TRADING VELOCITY:`);
      console.log(`   Trades per minute: ${(this.trades.length / (periodDuration / 60)).toFixed(2)}`);
      console.log(`   Avg time between trades: ${avgInterval.toFixed(1)}s`);
      console.log(`   Min time between trades: ${minInterval}s`);
      console.log(`   Max time between trades: ${maxInterval}s`);
    }

    // 5. Price Analysis
    const prices = this.trades.map(t => t.price);
    const avgPrice = prices.reduce((sum, p) => sum + p, 0) / prices.length;
    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);

    console.log(`\n💵 PRICE ANALYSIS:`);
    console.log(`   Avg price: $${avgPrice.toFixed(4)}`);
    console.log(`   Price range: $${minPrice.toFixed(4)} - $${maxPrice.toFixed(4)}`);

    // 6. Trade Size Distribution
    const sizes = this.trades.map(t => t.size);
    const avgSize = sizes.reduce((sum, s) => sum + s, 0) / sizes.length;
    const minSize = Math.min(...sizes);
    const maxSize = Math.max(...sizes);

    console.log(`\n📊 TRADE SIZE DISTRIBUTION:`);
    console.log(`   Avg size: ${avgSize.toLocaleString()} shares`);
    console.log(`   Size range: ${minSize.toLocaleString()} - ${maxSize.toLocaleString()} shares`);

    // 7. Strategy Insights
    console.log(`\n🧠 STRATEGY INSIGHTS:`);

    if (batchTrades.length > 0) {
      console.log(`   ✓ Uses batch execution (${batchTrades.length} batches detected)`);
    }

    const buyRatio = buys.length / this.trades.length;
    if (buyRatio > 0.7) {
      console.log(`   ✓ Heavily buying (${(buyRatio * 100).toFixed(0)}% of trades)`);
    } else if (buyRatio < 0.3) {
      console.log(`   ✓ Heavily selling (${((1 - buyRatio) * 100).toFixed(0)}% of trades)`);
    } else {
      console.log(`   ✓ Balanced buy/sell activity (${(buyRatio * 100).toFixed(0)}% buys)`);
    }

    if (this.trades.length > 10 && avgInterval < 2) {
      console.log(`   ✓ High-frequency trading (${this.trades.length} trades, avg ${avgInterval.toFixed(1)}s apart)`);
    }

    const uniqueMarkets = new Set(this.trades.map(t => t.title)).size;
    if (uniqueMarkets === 1) {
      console.log(`   ✓ Focused on single market: ${this.trades[0].title}`);
    } else {
      console.log(`   ✓ Trading across ${uniqueMarkets} different markets`);
    }

    // Detect potential strategies
    const oppositePositions = Array.from(marketStats.values()).filter(
      stats => stats.buyCount > 0 && stats.sellCount > 0
    );

    if (oppositePositions.length > 0) {
      console.log(`   ✓ Possible hedging/scalping detected (${oppositePositions.length} markets with both buys and sells)`);
    }

    console.log('\n' + '='.repeat(100) + '\n');

    // Reset for next period
    this.trades = [];
    this.lastSummaryTime = now;
  }

  /**
   * Start monitoring
   */
  async start() {
    console.log('\n' + '='.repeat(100));
    console.log('🎯 POLYMARKET TRADE MONITOR - STARTED');
    console.log('='.repeat(100));
    console.log(`Wallet: ${WALLET}`);
    console.log(`Poll Interval: ${POLL_INTERVAL}ms (1 second)`);
    console.log(`Summary Interval: ${SUMMARY_INTERVAL}ms (60 seconds)`);
    console.log(`Started: ${new Date().toLocaleString()}`);
    console.log('='.repeat(100));
    console.log('\n⏳ Waiting for new trades...\n');

    // Poll for new trades
    setInterval(async () => {
      const newTrades = await this.fetchNewTrades();

      if (newTrades.length > 0) {
        newTrades.forEach((trade, idx) => {
          this.logTrade(trade, this.trades.length + idx);
        });

        this.trades.push(...newTrades);
      }
    }, POLL_INTERVAL);

    // Generate summary every 60 seconds
    setInterval(() => {
      this.generateSummary();
    }, SUMMARY_INTERVAL);

    // Keep process alive
    process.on('SIGINT', () => {
      console.log('\n\n👋 Monitor stopped by user');
      console.log(`Total session duration: ${((Date.now() - this.sessionStartTime) / 1000).toFixed(0)}s`);
      console.log(`Total trades seen: ${this.seenTradeIds.size}`);
      process.exit(0);
    });
  }
}

// Start the monitor
const monitor = new TradeMonitor();
monitor.start();
