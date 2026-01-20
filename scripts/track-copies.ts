/**
 * Copy Trade Tracker - Track your copy trades and attribute P&L to each trader
 *
 * Usage:
 *   npx tsx scripts/track-copies.ts                    # Default wallet, last 7 days
 *   npx tsx scripts/track-copies.ts <your_wallet>      # Custom wallet
 *   npx tsx scripts/track-copies.ts <your_wallet> 30   # Custom period (days)
 *   npx tsx scripts/track-copies.ts --save             # Save results to MongoDB
 *   npx tsx scripts/track-copies.ts <wallet> 30 --save # Custom + save
 *
 * Environment:
 *   MONGODB_URI - MongoDB connection string
 */

import mongoose from 'mongoose';
import { TrackedTrader } from '../models/TrackedTrader';
import { CopyPosition } from '../models/CopyPosition';

const API_BASE = 'https://data-api.polymarket.com';

// Default copy trade wallet
const DEFAULT_WALLET = '0x01ba1dfbf9dd83a6ee27eb4c33f2d540232ca4ba';

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

interface Activity {
  conditionId: string;
  asset: string;
  title: string;
  slug?: string;
  outcome: string;
  type: 'TRADE' | 'REDEEM' | 'SPLIT' | 'MERGE';
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
  initialValue: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
}

interface ClosedPosition {
  conditionId: string;
  asset: string;
  title: string;
  outcome: string;
  totalBought: number;
  avgPrice: number;
  realizedPnl: number;
  timestamp: number;
}

interface TraderCopyStats {
  wallet: string;
  label: string;
  trades: {
    market: string;
    outcome: string;
    side: string;
    size: number;
    price: number;
    usdcValue: number;
    timestamp: Date;
    currentValue?: number;
    pnl?: number;
    pnlPercent?: number;
    status: 'OPEN' | 'CLOSED' | 'UNKNOWN';
  }[];
  totalInvested: number;
  currentValue: number;
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
  tradeCount: number;
}

// ═══════════════════════════════════════════════════════════════
// Database
// ═══════════════════════════════════════════════════════════════

async function connectDB() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI environment variable is required');
  }

  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(uri);
    console.log('[DB] Connected to MongoDB\n');
  }
}

// ═══════════════════════════════════════════════════════════════
// API Functions
// ═══════════════════════════════════════════════════════════════

async function fetchActivities(wallet: string, days: number): Promise<Activity[]> {
  const now = Math.floor(Date.now() / 1000);
  const startTs = now - (days * 24 * 60 * 60);
  const MAX_ACTIVITIES = 2000;

  let allActivities: Activity[] = [];
  let offset = 0;

  while (allActivities.length < MAX_ACTIVITIES) {
    const url = `${API_BASE}/activity?user=${wallet}&limit=500&offset=${offset}&sortBy=TIMESTAMP&sortDirection=DESC`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`API error: ${response.status}`);

    const batch = await response.json() as Activity[];
    if (batch.length === 0) break;

    for (const activity of batch) {
      if (activity.timestamp >= startTs) {
        allActivities.push(activity);
      } else {
        return allActivities;
      }
    }

    if (batch.length < 500) break;
    offset += 500;
    await new Promise(r => setTimeout(r, 100));
  }

  return allActivities;
}

async function fetchOpenPositions(wallet: string): Promise<OpenPosition[]> {
  const url = `${API_BASE}/positions?user=${wallet}&sizeThreshold=0.1`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`API error: ${response.status}`);
  return response.json();
}

async function fetchClosedPositions(wallet: string, days: number): Promise<ClosedPosition[]> {
  const now = Math.floor(Date.now() / 1000);
  const startTs = now - (days * 24 * 60 * 60);

  let allPositions: ClosedPosition[] = [];
  let offset = 0;

  while (true) {
    const url = `${API_BASE}/v1/closed-positions?user=${wallet}&limit=50&offset=${offset}&sortBy=TIMESTAMP&sortDirection=DESC`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`API error: ${response.status}`);

    const batch = await response.json() as ClosedPosition[];
    if (batch.length === 0) break;

    for (const pos of batch) {
      if (pos.timestamp >= startTs) {
        allPositions.push(pos);
      } else {
        return allPositions;
      }
    }

    if (batch.length < 50) break;
    offset += 50;
    await new Promise(r => setTimeout(r, 100));
  }

  return allPositions;
}

async function fetchTraderActivities(traderWallet: string, days: number): Promise<Activity[]> {
  // Fetch trader activities to match against
  return fetchActivities(traderWallet, days);
}

// ═══════════════════════════════════════════════════════════════
// Matching Logic
// ═══════════════════════════════════════════════════════════════

function matchTradeToTrader(
  myTrade: Activity,
  traders: { wallet: string; label: string; activities: Activity[] }[],
  debug: boolean = false
): { wallet: string; label: string } | null {
  // Match based on:
  // 1. Same market (conditionId)
  // 2. Same outcome
  // 3. Same side
  // 4. Within time window (24 hours for copy trading - often delayed)
  // 5. Pick the trader with the CLOSEST timestamp (not first match)

  const TIME_WINDOW = 24 * 60 * 60; // 24 hours in seconds (increased from 30 min)

  let bestMatch: { wallet: string; label: string; timeDiff: number } | null = null;

  for (const trader of traders) {
    for (const traderTrade of trader.activities) {
      const sameMarket = traderTrade.conditionId === myTrade.conditionId;
      const sameOutcome = traderTrade.outcome === myTrade.outcome;
      const sameSide = traderTrade.side === myTrade.side;
      const traderFirst = traderTrade.timestamp <= myTrade.timestamp;

      if (sameMarket && sameOutcome && sameSide && traderFirst) {
        const timeDiff = myTrade.timestamp - traderTrade.timestamp;
        if (timeDiff <= TIME_WINDOW) {
          if (!bestMatch || timeDiff < bestMatch.timeDiff) {
            bestMatch = { wallet: trader.wallet, label: trader.label, timeDiff };
          }
        }
      }

      // Debug: Show near misses
      if (debug && sameMarket && !bestMatch) {
        console.log(`    Near miss: ${trader.label}`);
        console.log(`      Market: ${sameMarket}, Outcome: ${sameOutcome} (${traderTrade.outcome} vs ${myTrade.outcome})`);
        console.log(`      Side: ${sameSide} (${traderTrade.side} vs ${myTrade.side}), TraderFirst: ${traderFirst}`);
      }
    }
  }

  return bestMatch ? { wallet: bestMatch.wallet, label: bestMatch.label } : null;
}

// ═══════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════

async function main() {
  // Load env - try multiple locations
  const dotenv = await import('dotenv');
  const path = await import('path');
  const envLocations = [
    path.resolve(process.cwd(), 'services/.private/poly-agent/.env.polyagent'),
    path.resolve(process.cwd(), '.env.local'),
    path.resolve(process.cwd(), '.env'),
  ];
  for (const envPath of envLocations) {
    const result = dotenv.config({ path: envPath });
    if (!result.error && process.env.MONGODB_URI) break;
  }

  // Parse args - support both positional and --save flag
  const args = process.argv.slice(2);
  const saveToDb = args.includes('--save');
  const filteredArgs = args.filter(a => !a.startsWith('--'));

  const myWallet = (filteredArgs[0] && filteredArgs[0].startsWith('0x'))
    ? filteredArgs[0]
    : DEFAULT_WALLET;
  const days = parseInt(
    filteredArgs.find(a => !a.startsWith('0x') && !isNaN(parseInt(a))) || '7'
  );

  const now = Math.floor(Date.now() / 1000);
  const startDate = new Date((now - days * 24 * 60 * 60) * 1000).toISOString().split('T')[0];
  const endDate = new Date(now * 1000).toISOString().split('T')[0];

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('                    COPY TRADE TRACKER                          ');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`Your Wallet:  ${myWallet}`);
  console.log(`Period:       Last ${days} days (${startDate} to ${endDate})`);
  console.log(`Save to DB:   ${saveToDb ? 'YES' : 'NO (use --save to persist)'}`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  await connectDB();

  // Get actively tracked traders (isTracking: true, not just profiled)
  const allTrackers = await TrackedTrader.find({ isActive: true, isTracking: true }).lean();

  // Filter to valid Ethereum addresses only
  const trackedTraders = allTrackers.filter(t =>
    t.wallet && /^0x[a-fA-F0-9]{40}$/.test(t.wallet)
  );

  if (trackedTraders.length === 0) {
    console.log('No traders being actively tracked.');
    console.log('Go to the UI and click "Start Tracking" on a profiled trader.\n');
    await mongoose.connection.close();
    return;
  }

  console.log(`Tracking ${trackedTraders.length} traders:\n`);
  trackedTraders.forEach(t => console.log(`  - ${t.label} (${t.wallet.slice(0, 10)}...)`));
  console.log('');

  // Fetch my activities
  console.log('Fetching your activities...');
  const myActivities = await fetchActivities(myWallet, days);
  const myTrades = myActivities.filter(a => a.type === 'TRADE');
  console.log(`  Found ${myTrades.length} trades\n`);

  // Fetch my positions
  console.log('Fetching your positions...');
  const myOpenPositions = await fetchOpenPositions(myWallet);
  const myClosedPositions = await fetchClosedPositions(myWallet, days);
  console.log(`  Found ${myOpenPositions.length} open, ${myClosedPositions.length} closed\n`);

  // Fetch trader activities
  console.log('Fetching trader activities...');
  const tradersWithActivities: { wallet: string; label: string; activities: Activity[] }[] = [];

  for (const trader of trackedTraders) {
    console.log(`  Fetching ${trader.label}...`);
    const activities = await fetchTraderActivities(trader.wallet, days);
    const trades = activities.filter(a => a.type === 'TRADE');
    tradersWithActivities.push({
      wallet: trader.wallet,
      label: trader.label,
      activities: trades,
    });
    console.log(`    Found ${trades.length} trades`);

    // Show recent markets
    const recentMarkets = [...new Set(trades.slice(0, 10).map(t => t.title.substring(0, 40)))];
    if (recentMarkets.length > 0) {
      console.log(`    Recent markets: ${recentMarkets.slice(0, 3).join(', ')}...`);
    }
    await new Promise(r => setTimeout(r, 200));
  }
  console.log('');

  // Show your recent trades for comparison
  console.log('Your recent trades:');
  myTrades.slice(0, 5).forEach(t => {
    console.log(`  ${t.side} ${t.outcome} - ${t.title.substring(0, 40)}...`);
  });
  console.log('');

  // Match my trades to traders
  const statsByTrader: Record<string, TraderCopyStats> = {};
  let unmatchedTrades: Activity[] = [];

  console.log('Matching trades...');
  for (const trade of myTrades) {
    const match = matchTradeToTrader(trade, tradersWithActivities);

    if (match) {
      if (!statsByTrader[match.wallet]) {
        statsByTrader[match.wallet] = {
          wallet: match.wallet,
          label: match.label,
          trades: [],
          totalInvested: 0,
          currentValue: 0,
          realizedPnl: 0,
          unrealizedPnl: 0,
          totalPnl: 0,
          tradeCount: 0,
        };
      }

      // Find position status
      const openPos = myOpenPositions.find(
        p => p.conditionId === trade.conditionId && p.outcome === trade.outcome
      );
      const closedPos = myClosedPositions.find(
        p => p.conditionId === trade.conditionId && p.outcome === trade.outcome
      );

      let status: 'OPEN' | 'CLOSED' | 'UNKNOWN' = 'UNKNOWN';
      let currentValue: number | undefined;
      let pnl: number | undefined;
      let pnlPercent: number | undefined;

      if (openPos) {
        status = 'OPEN';
        currentValue = openPos.currentValue;
        pnl = openPos.cashPnl;
        pnlPercent = openPos.percentPnl;
      } else if (closedPos) {
        status = 'CLOSED';
        pnl = closedPos.realizedPnl;
      }

      statsByTrader[match.wallet].trades.push({
        market: trade.title,
        outcome: trade.outcome,
        side: trade.side || 'UNKNOWN',
        size: trade.size,
        price: trade.price,
        usdcValue: trade.usdcSize,
        timestamp: new Date(trade.timestamp * 1000),
        currentValue,
        pnl,
        pnlPercent,
        status,
      });

      if (trade.side === 'BUY') {
        statsByTrader[match.wallet].totalInvested += trade.usdcSize;
      }
    } else {
      unmatchedTrades.push(trade);
    }
  }

  // Calculate totals per trader
  for (const traderStats of Object.values(statsByTrader)) {
    traderStats.tradeCount = traderStats.trades.length;

    for (const trade of traderStats.trades) {
      if (trade.status === 'OPEN' && trade.currentValue !== undefined) {
        traderStats.currentValue += trade.currentValue;
        traderStats.unrealizedPnl += trade.pnl || 0;
      } else if (trade.status === 'CLOSED' && trade.pnl !== undefined) {
        traderStats.realizedPnl += trade.pnl;
      }
    }

    traderStats.totalPnl = traderStats.realizedPnl + traderStats.unrealizedPnl;
  }

  // Print results
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('                    P&L BY TRADER COPIED                        ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const sortedTraders = Object.values(statsByTrader).sort((a, b) => b.totalPnl - a.totalPnl);

  for (const stats of sortedTraders) {
    const pnlSign = stats.totalPnl >= 0 ? '+' : '';
    const pnlColor = stats.totalPnl >= 0 ? '' : ''; // Could add colors if terminal supports

    console.log('┌─────────────────────────────────────────────────────────────┐');
    console.log(`│ TRADER: ${stats.label.padEnd(50)}│`);
    console.log(`│ ${stats.wallet.padEnd(59)}│`);
    console.log('├─────────────────────────────────────────────────────────────┤');
    console.log(`│ Trades Copied:  ${stats.tradeCount.toString().padEnd(42)}│`);
    console.log(`│ Total Invested: $${stats.totalInvested.toFixed(2).padEnd(40)}│`);
    console.log(`│ Current Value:  $${stats.currentValue.toFixed(2).padEnd(40)}│`);
    console.log(`│ Realized P&L:   ${pnlSign}$${stats.realizedPnl.toFixed(2).padEnd(40)}│`);
    console.log(`│ Unrealized P&L: ${pnlSign}$${stats.unrealizedPnl.toFixed(2).padEnd(40)}│`);
    console.log(`│ TOTAL P&L:      ${pnlSign}$${stats.totalPnl.toFixed(2).padEnd(40)}│`);
    console.log('├─────────────────────────────────────────────────────────────┤');

    // Show individual trades
    for (const trade of stats.trades.slice(0, 5)) {
      const tradePnlSign = (trade.pnl || 0) >= 0 ? '+' : '';
      const statusEmoji = trade.status === 'OPEN' ? '🔵' : trade.status === 'CLOSED' ? '✅' : '❓';

      console.log(`│ ${statusEmoji} ${trade.market.substring(0, 40).padEnd(40)}│`);
      console.log(`│    ${trade.side} ${trade.outcome.substring(0, 20)} @ ${(trade.price * 100).toFixed(0)}c`.padEnd(61) + '│');
      console.log(`│    $${trade.usdcValue.toFixed(2)} → ${trade.pnl !== undefined ? tradePnlSign + '$' + trade.pnl.toFixed(2) : 'pending'}`.padEnd(61) + '│');
    }

    if (stats.trades.length > 5) {
      console.log(`│    ... and ${stats.trades.length - 5} more trades`.padEnd(61) + '│');
    }

    console.log('└─────────────────────────────────────────────────────────────┘\n');
  }

  // Unmatched trades
  if (unmatchedTrades.length > 0) {
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('                    UNMATCHED TRADES                           ');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`${unmatchedTrades.length} trades could not be matched to any tracked trader.\n`);

    for (const trade of unmatchedTrades.slice(0, 5)) {
      console.log(`  ${trade.side} ${trade.outcome} - ${trade.title.substring(0, 40)}...`);
      console.log(`    $${trade.usdcSize.toFixed(2)} @ ${(trade.price * 100).toFixed(0)}c\n`);
    }

    if (unmatchedTrades.length > 5) {
      console.log(`  ... and ${unmatchedTrades.length - 5} more\n`);
    }
  }

  // Total summary
  const totalInvested = Object.values(statsByTrader).reduce((sum, s) => sum + s.totalInvested, 0);
  const totalCurrentValue = Object.values(statsByTrader).reduce((sum, s) => sum + s.currentValue, 0);
  const totalPnl = Object.values(statsByTrader).reduce((sum, s) => sum + s.totalPnl, 0);
  const totalPnlSign = totalPnl >= 0 ? '+' : '';

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('                    PORTFOLIO SUMMARY                           ');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Total Invested:    $${totalInvested.toFixed(2)}`);
  console.log(`  Current Value:     $${totalCurrentValue.toFixed(2)}`);
  console.log(`  Total P&L:         ${totalPnlSign}$${totalPnl.toFixed(2)}`);
  console.log(`  Matched Trades:    ${myTrades.length - unmatchedTrades.length}`);
  console.log(`  Unmatched Trades:  ${unmatchedTrades.length}`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Save to MongoDB if --save flag is set
  if (saveToDb) {
    console.log('Saving to MongoDB...');

    let savedCount = 0;
    let updatedCount = 0;

    for (const traderStats of Object.values(statsByTrader)) {
      for (const trade of traderStats.trades) {
        try {
          const result = await CopyPosition.updateOne(
            {
              userWallet: myWallet.toLowerCase(),
              conditionId: trade.market, // Using market as conditionId placeholder
              outcome: trade.outcome,
            },
            {
              $set: {
                userWallet: myWallet.toLowerCase(),
                traderWallet: traderStats.wallet,
                traderLabel: traderStats.label,
                conditionId: trade.market, // Will be updated with actual conditionId
                market: trade.market,
                outcome: trade.outcome,
                side: trade.side as 'BUY' | 'SELL',
                size: trade.size,
                price: trade.price,
                usdcValue: trade.usdcValue,
                timestamp: trade.timestamp,
                status: trade.status,
                currentValue: trade.currentValue,
                pnl: trade.pnl,
                pnlPercent: trade.pnlPercent,
                matchedAt: new Date(),
              },
            },
            { upsert: true }
          );

          if (result.upsertedCount > 0) savedCount++;
          else if (result.modifiedCount > 0) updatedCount++;
        } catch (err: any) {
          // Ignore duplicate key errors, log others
          if (!err.message?.includes('duplicate key')) {
            console.error(`  Error saving trade: ${err.message}`);
          }
        }
      }
    }

    console.log(`  Saved ${savedCount} new positions, updated ${updatedCount} existing\n`);

    // Also update trader copy stats in trackedTraders
    for (const traderStats of Object.values(statsByTrader)) {
      await TrackedTrader.updateOne(
        { wallet: traderStats.wallet },
        {
          $set: {
            totalCopied: traderStats.tradeCount,
            totalPnl: traderStats.totalPnl,
            lastUpdatedAt: new Date(),
          },
        }
      );
    }

    console.log('  Updated trader copy stats');
    console.log('═══════════════════════════════════════════════════════════════\n');
  }

  await mongoose.connection.close();
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
