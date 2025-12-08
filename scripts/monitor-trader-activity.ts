/**
 * Real-time Trade Monitor for Polymarket Wallet
 * Clear format with market summaries and readable trade logs
 */

import axios from 'axios';

const API_BASE = 'https://data-api.polymarket.com';
const WALLET = '0xecd55daa7c6900683b804d1d4db935fbfabe43f4';
const POLL_INTERVAL = 1000; // 1 second
const POSITION_REFRESH_INTERVAL = 30000; // 30 seconds

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

interface OpenPosition {
  conditionId: string;
  asset: string;
  title: string;
  outcome: string;
  size: number;
  avgPrice: number;
  curPrice: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
}

class TradeMonitor {
  private lastTimestamp: number;
  private seenTradeIds: Set<string> = new Set();
  private sessionStartTime: number;
  private apiCallCount: number = 0;
  private tradeCount: number = 0;
  private positions: Map<string, OpenPosition> = new Map();
  private lastPositionUpdate: number = 0;

  constructor() {
    this.lastTimestamp = Math.floor(Date.now() / 1000);
    this.sessionStartTime = Date.now();
  }

  /**
   * Fetch current open positions for market summaries
   */
  async fetchPositions(): Promise<void> {
    try {
      const url = `${API_BASE}/positions?user=${WALLET}&limit=500`;

      const response = await axios.get(url, {
        timeout: 10000,
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0'
        },
      });

      const positions: OpenPosition[] = response.data;

      // Store positions by market + outcome key
      this.positions.clear();
      positions.forEach(pos => {
        const key = `${pos.title}|${pos.outcome}`;
        this.positions.set(key, pos);
      });

      this.lastPositionUpdate = Date.now();
    } catch (error: any) {
      // Silently fail - not critical
    }
  }

  /**
   * Fetch new trades since last check
   * Uses fixed lookback window to handle API indexing delays
   */
  async fetchNewTrades(): Promise<ActivityResponse[]> {
    try {
      this.apiCallCount++;

      const now = Math.floor(Date.now() / 1000);

      // Always look back 60 seconds from current time to catch API delays
      // This ensures trades that take time to index are still captured
      const windowStart = now - 60;

      const url = `${API_BASE}/activity?user=${WALLET}&type=TRADE&start=${windowStart}&end=${now}&limit=500&sortBy=TIMESTAMP&sortDirection=ASC`;

      const response = await axios.get(url, {
        timeout: 10000,
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0'
        },
      });

      const activities: ActivityResponse[] = response.data;

      // Filter out trades we've already seen (critical for 60s lookback)
      const newTrades = activities.filter(trade => !this.seenTradeIds.has(trade.id));

      // Update lastTimestamp to the MAX trade timestamp (not system time!)
      // This prevents the window from advancing past unindexed trades
      if (newTrades.length > 0) {
        const maxTradeTimestamp = Math.max(...newTrades.map(t => t.timestamp));
        this.lastTimestamp = maxTradeTimestamp;
      }
      // Don't update lastTimestamp if no new trades - keep looking back

      // Mark trades as seen
      newTrades.forEach(trade => this.seenTradeIds.add(trade.id));

      return newTrades;
    } catch (error: any) {
      const now = new Date().toLocaleTimeString('en-US', { hour12: false });
      console.log(`\n❌ [${now}] API Error: ${error.message}\n`);
      return [];
    }
  }

  /**
   * Get position summary for a market/outcome
   */
  getPositionSummary(market: string, outcome: string): string {
    const key = `${market}|${outcome}`;
    const pos = this.positions.get(key);

    if (!pos) {
      return '(no open position)';
    }

    const pnlColor = pos.cashPnl >= 0 ? '+' : '';
    return `Position: ${pos.size.toFixed(1)} shares @ avg $${pos.avgPrice.toFixed(2)} | Current: $${pos.curPrice.toFixed(2)} | PnL: ${pnlColor}$${pos.cashPnl.toFixed(2)} (${pnlColor}${pos.percentPnl.toFixed(1)}%)`;
  }

  /**
   * Log a single trade in clear format
   */
  logTrade(trade: ActivityResponse) {
    this.tradeCount++;

    const timestamp = new Date(trade.timestamp * 1000);
    const timeStr = timestamp.toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });

    const dateStr = timestamp.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric'
    });

    const side = trade.side || 'UNKNOWN';
    const sideIcon = side === 'BUY' ? '🟢 BUY ' : side === 'SELL' ? '🔴 SELL' : '⚪ UNKNOWN';

    console.log('\n' + '─'.repeat(120));
    console.log(`${sideIcon} | ${dateStr} ${timeStr} | Trade #${this.tradeCount} | Unix: ${trade.timestamp}`);
    console.log('─'.repeat(120));
    console.log(`📊 Market:    ${trade.title}`);
    console.log(`🎯 Outcome:   ${trade.outcome}`);
    console.log(`💰 Amount:    ${trade.size.toLocaleString()} shares × $${trade.price.toFixed(4)} = $${trade.usdcSize.toFixed(2)}`);
    console.log(`📍 Position:  ${this.getPositionSummary(trade.title, trade.outcome)}`);
    console.log(`🔗 TX:        ${trade.transactionHash.substring(0, 20)}...`);
  }

  /**
   * Print header with stats
   */
  printHeader() {
    const runtime = Math.floor((Date.now() - this.sessionStartTime) / 1000);
    const hours = Math.floor(runtime / 3600);
    const minutes = Math.floor((runtime % 3600) / 60);
    const seconds = runtime % 60;
    const runtimeStr = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;

    console.log('\n' + '='.repeat(120));
    console.log(`🎯 POLYMARKET LIVE TRADE MONITOR`);
    console.log('='.repeat(120));
    console.log(`Wallet: ${WALLET}`);
    console.log(`API Calls: ${this.apiCallCount.toString().padStart(5, ' ')} | Trades Detected: ${this.tradeCount.toString().padStart(4, ' ')} | Runtime: ${runtimeStr} | Open Positions: ${this.positions.size}`);
    console.log('='.repeat(120));
  }

  /**
   * Start monitoring
   */
  async start() {
    // Initial header
    this.printHeader();
    console.log('\n⏳ Waiting for new trades...\n');

    // Fetch positions immediately
    await this.fetchPositions();

    // Refresh positions periodically
    setInterval(async () => {
      await this.fetchPositions();
    }, POSITION_REFRESH_INTERVAL);

    // Poll for new trades
    setInterval(async () => {
      const newTrades = await this.fetchNewTrades();

      if (newTrades.length > 0) {
        // Print updated header
        this.printHeader();

        // Log each trade
        newTrades.forEach((trade) => {
          this.logTrade(trade);
        });

        console.log('\n' + '='.repeat(120));
        console.log('⏳ Waiting for more trades...\n');
      } else {
        // Show a simple status update every 10 polls
        if (this.apiCallCount % 10 === 0) {
          const now = new Date().toLocaleTimeString('en-US', { hour12: false });
          process.stdout.write(`\r[${now}] 📡 Monitoring... (${this.apiCallCount} API calls, ${this.tradeCount} trades)`);
        }
      }
    }, POLL_INTERVAL);

    // Keep process alive
    process.on('SIGINT', () => {
      console.log('\n\n' + '='.repeat(120));
      console.log('👋 Monitor stopped by user');
      console.log('='.repeat(120));
      console.log(`Total runtime:   ${((Date.now() - this.sessionStartTime) / 1000).toFixed(0)}s`);
      console.log(`Total API calls: ${this.apiCallCount}`);
      console.log(`Total trades:    ${this.tradeCount}`);
      console.log('='.repeat(120) + '\n');
      process.exit(0);
    });
  }
}

// Start the monitor
const monitor = new TradeMonitor();
monitor.start();
