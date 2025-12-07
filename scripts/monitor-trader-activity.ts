/**
 * Real-time Trade Monitor for Polymarket Wallet
 * Compact single-line format with API call counter
 */

import axios from 'axios';

const API_BASE = 'https://data-api.polymarket.com';
const WALLET = '0xecd55daa7c6900683b804d1d4db935fbfabe43f4';
const POLL_INTERVAL = 1000; // 1 second

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

class TradeMonitor {
  private lastTimestamp: number;
  private seenTradeIds: Set<string> = new Set();
  private sessionStartTime: number;
  private apiCallCount: number = 0;
  private tradeCount: number = 0;

  constructor() {
    this.lastTimestamp = Math.floor(Date.now() / 1000);
    this.sessionStartTime = Date.now();
  }

  /**
   * Clear console and move cursor to top
   */
  clearScreen() {
    process.stdout.write('\x1Bc'); // Clear console
  }

  /**
   * Update header with stats
   */
  updateHeader() {
    const runtime = Math.floor((Date.now() - this.sessionStartTime) / 1000);
    const hours = Math.floor(runtime / 3600);
    const minutes = Math.floor((runtime % 3600) / 60);
    const seconds = runtime % 60;
    const runtimeStr = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;

    // Move cursor to top
    process.stdout.write('\x1b[H');

    console.log('='.repeat(120));
    console.log(`🎯 POLYMARKET MONITOR | Wallet: ${WALLET.substring(0, 10)}...${WALLET.slice(-6)}`);
    console.log(`📊 API Calls: ${this.apiCallCount.toString().padStart(6, ' ')} | Trades: ${this.tradeCount.toString().padStart(4, ' ')} | Runtime: ${runtimeStr}`);
    console.log('='.repeat(120));
  }

  /**
   * Fetch new trades since last check
   */
  async fetchNewTrades(): Promise<ActivityResponse[]> {
    try {
      this.apiCallCount++;

      const now = Math.floor(Date.now() / 1000);

      // Use a sliding window approach (last 120 seconds to ensure we don't miss anything)
      const windowStart = Math.max(this.lastTimestamp - 5, now - 120);

      const url = `${API_BASE}/activity?user=${WALLET}&type=TRADE&start=${windowStart}&end=${now}&limit=500&sortBy=TIMESTAMP&sortDirection=ASC`;

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

      // Update last timestamp to now (for next poll window)
      if (newTrades.length > 0 || activities.length > 0) {
        this.lastTimestamp = now;
      }

      // Mark trades as seen
      newTrades.forEach(trade => this.seenTradeIds.add(trade.id));

      return newTrades;
    } catch (error: any) {
      const now = new Date().toLocaleTimeString('en-US', { hour12: false });
      console.log(`[${now}] ❌ API Error: ${error.message}`);
      return [];
    }
  }

  /**
   * Log a single trade in compact format
   */
  logTrade(trade: ActivityResponse) {
    this.tradeCount++;

    const timestamp = new Date(trade.timestamp * 1000);
    const timeStr = timestamp.toLocaleTimeString('en-US', { hour12: false });
    const side = trade.side || 'UNKNOWN';
    const sideIcon = side === 'BUY' ? '🟢' : side === 'SELL' ? '🔴' : '⚪';

    // Compact single-line format
    console.log(
      `${sideIcon} [${timeStr}] ${side.padEnd(4)} ${trade.size.toLocaleString().padStart(8)} @ $${trade.price.toFixed(4).padStart(7)} | ` +
      `${trade.outcome.padEnd(5)} | $${trade.usdcSize.toFixed(2).padStart(8)} | ${trade.title.substring(0, 50)}`
    );
  }

  /**
   * Log polling activity
   */
  logPoll(newTradesCount: number) {
    const now = new Date().toLocaleTimeString('en-US', { hour12: false });

    if (newTradesCount === 0) {
      // Overwrite same line for "no trades" messages
      process.stdout.write(`\r[${now}] 📡 Poll #${this.apiCallCount} - No new trades...`);
    }
  }

  /**
   * Start monitoring
   */
  async start() {
    this.clearScreen();
    this.updateHeader();
    console.log('\n⏳ Monitoring for new trades...\n');

    // Update header every second
    setInterval(() => {
      this.updateHeader();
    }, 1000);

    // Poll for new trades
    setInterval(async () => {
      const newTrades = await this.fetchNewTrades();

      if (newTrades.length > 0) {
        // Clear the "no trades" line
        process.stdout.write('\r' + ' '.repeat(100) + '\r');

        newTrades.forEach((trade) => {
          this.logTrade(trade);
        });
      } else {
        this.logPoll(0);
      }
    }, POLL_INTERVAL);

    // Keep process alive
    process.on('SIGINT', () => {
      console.log('\n\n👋 Monitor stopped by user');
      console.log(`Total runtime: ${((Date.now() - this.sessionStartTime) / 1000).toFixed(0)}s`);
      console.log(`Total API calls: ${this.apiCallCount}`);
      console.log(`Total trades seen: ${this.tradeCount}`);
      process.exit(0);
    });
  }
}

// Start the monitor
const monitor = new TradeMonitor();
monitor.start();
