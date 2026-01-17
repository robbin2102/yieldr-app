/**
 * Trade Alerts - Monitor target traders for new trades
 *
 * Usage:
 *   npx tsx scripts/trade-alerts.ts              # Check once and exit
 *   npx tsx scripts/trade-alerts.ts --watch      # Continuous monitoring (60s interval)
 *   npx tsx scripts/trade-alerts.ts --add <wallet> <label>  # Add trader to track
 *   npx tsx scripts/trade-alerts.ts --list       # List tracked traders
 *   npx tsx scripts/trade-alerts.ts --pending    # Show pending alerts
 *
 * Environment:
 *   MONGODB_URI - MongoDB connection string
 */

import mongoose from 'mongoose';
import { TradeAlert, ITradeAlert } from '../models/TradeAlert';
import { TrackedTrader, ITrackedTrader } from '../models/TrackedTrader';

const API_BASE = 'https://data-api.polymarket.com';

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

async function fetchWithRetry(url: string, retries = 3): Promise<Response> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`API error: ${response.status}`);
      return response;
    } catch (error: any) {
      if (attempt === retries) throw error;
      const delay = attempt * 2000; // 2s, 4s, 6s
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error('Fetch failed after retries');
}

async function fetchNewActivities(wallet: string, sinceTimestamp: number): Promise<Activity[]> {
  // Fetch activities newer than sinceTimestamp
  const url = `${API_BASE}/activity?user=${wallet}&limit=100&sortBy=TIMESTAMP&sortDirection=DESC`;

  const response = await fetchWithRetry(url);
  const activities = (await response.json()) as Activity[];

  // Filter to only new activities (TRADE and REDEEM types)
  return activities.filter(
    (a) =>
      a.timestamp > sinceTimestamp &&
      (a.type === 'TRADE' || a.type === 'REDEEM')
  );
}

// ═══════════════════════════════════════════════════════════════
// Alert Functions
// ═══════════════════════════════════════════════════════════════

function determineCopyRecommendation(
  trader: ITrackedTrader,
  activity: Activity,
  avgTradeSize?: number
): { recommendation: 'PRIORITY' | 'COPY' | 'CAUTIOUS' | 'SKIP'; reason: string; isHighConviction: boolean } {
  let isHighConviction = false;

  // Check if this is a high-conviction (asymmetric) trade (>10x avg)
  if (avgTradeSize && activity.usdcSize >= avgTradeSize * 10) {
    isHighConviction = true;
  }

  // Skip small bets (unless high conviction check overrides)
  if (trader.skipSmallBets && activity.usdcSize < trader.smallBetThreshold) {
    return { recommendation: 'SKIP', reason: `Small bet ($${activity.usdcSize.toFixed(2)} < $${trader.smallBetThreshold})`, isHighConviction: false };
  }

  // Skip SELL trades for BUY_AND_HOLD traders (unusual)
  if (trader.strategyLabel === 'BUY_AND_HOLD' && activity.side === 'SELL') {
    return { recommendation: 'CAUTIOUS', reason: 'SELL from BUY_AND_HOLD trader (unusual)', isHighConviction };
  }

  // REDEEM is always informational
  if (activity.type === 'REDEEM') {
    return { recommendation: 'SKIP', reason: 'REDEEM (market resolved)', isHighConviction: false };
  }

  // HIGH CONVICTION TRADE - always priority!
  if (isHighConviction) {
    const multiplier = avgTradeSize ? (activity.usdcSize / avgTradeSize).toFixed(1) : '10+';
    return { recommendation: 'PRIORITY', reason: `🔥 HIGH CONVICTION (${multiplier}x avg size!)`, isHighConviction: true };
  }

  // Entry odds based priority (for BUY trades)
  if (activity.side === 'BUY') {
    if (activity.price < 0.40) {
      return { recommendation: 'PRIORITY', reason: `Underdog entry (${(activity.price * 100).toFixed(0)}c)`, isHighConviction };
    }
    if (activity.price < 0.60) {
      return { recommendation: 'COPY', reason: `Mid-range entry (${(activity.price * 100).toFixed(0)}c)`, isHighConviction };
    }
    return { recommendation: 'CAUTIOUS', reason: `Favorite entry (${(activity.price * 100).toFixed(0)}c)`, isHighConviction };
  }

  return { recommendation: 'COPY', reason: 'Standard trade', isHighConviction };
}

async function createAlert(trader: ITrackedTrader, activity: Activity): Promise<ITradeAlert | null> {
  // Check if alert already exists (dedup by txHash)
  const existing = await TradeAlert.findOne({ txHash: activity.transactionHash });
  if (existing) return null;

  const { recommendation, reason, isHighConviction } = determineCopyRecommendation(
    trader,
    activity,
    trader.avgTradeSize
  );

  // Calculate suggested size
  let suggestedSize = activity.usdcSize * trader.copyMultiplier;
  if (suggestedSize > trader.maxCopySize) {
    suggestedSize = trader.maxCopySize;
  }

  // Calculate size multiplier (how many times avg)
  const sizeMultiplier = trader.avgTradeSize
    ? activity.usdcSize / trader.avgTradeSize
    : undefined;

  const alert = new TradeAlert({
    traderWallet: trader.wallet,
    traderLabel: trader.label,
    type: activity.type,
    side: activity.side,
    market: activity.title,
    marketSlug: activity.slug,
    outcome: activity.outcome,
    conditionId: activity.conditionId,
    tokenId: activity.asset,
    size: activity.size,
    price: activity.price,
    usdcValue: activity.usdcSize,
    timestamp: new Date(activity.timestamp * 1000),
    txHash: activity.transactionHash,
    copyRecommendation: recommendation,
    suggestedSize: recommendation !== 'SKIP' ? suggestedSize : undefined,
    reason,
    isHighConviction,
    sizeMultiplier,
    alertedAt: new Date(),
  });

  await alert.save();
  return alert;
}

// ═══════════════════════════════════════════════════════════════
// Main Functions
// ═══════════════════════════════════════════════════════════════

async function checkTraders(): Promise<number> {
  const traders = await TrackedTrader.find({ isActive: true });

  if (traders.length === 0) {
    console.log('No traders being tracked. Use --add to add a trader.\n');
    return 0;
  }

  let totalNewAlerts = 0;

  for (const trader of traders) {
    console.log(`Checking ${trader.label} (${trader.wallet.slice(0, 10)}...)...`);

    try {
      const activities = await fetchNewActivities(trader.wallet, trader.lastSeenTimestamp);

      if (activities.length > 0) {
        console.log(`  Found ${activities.length} new activities`);

        for (const activity of activities) {
          const alert = await createAlert(trader, activity);

          if (alert) {
            totalNewAlerts++;
            const emoji = alert.copyRecommendation === 'PRIORITY' ? '🔴' :
                          alert.copyRecommendation === 'COPY' ? '🟡' :
                          alert.copyRecommendation === 'CAUTIOUS' ? '🟠' : '⚪';

            console.log(`  ${emoji} NEW: ${alert.side || alert.type} ${alert.outcome}`);
            console.log(`       ${alert.market.substring(0, 50)}...`);
            console.log(`       $${alert.usdcValue.toFixed(2)} @ ${(alert.price * 100).toFixed(0)}c`);
            console.log(`       Recommendation: ${alert.copyRecommendation} - ${alert.reason}`);
            if (alert.suggestedSize) {
              console.log(`       Suggested copy: $${alert.suggestedSize.toFixed(2)}`);
            }
            console.log('');
          }

          // Update last seen timestamp
          if (activity.timestamp > trader.lastSeenTimestamp) {
            trader.lastSeenTimestamp = activity.timestamp;
          }
        }

        // Save trader with updated timestamp and stats
        trader.totalAlerts += activities.length;
        trader.lastUpdatedAt = new Date();
        await trader.save();
      } else {
        console.log('  No new activities');
      }
    } catch (error: any) {
      console.error(`  Error: ${error.message}`);
    }

    // Rate limiting
    await new Promise((r) => setTimeout(r, 200));
  }

  return totalNewAlerts;
}

async function addTrader(wallet: string, label: string) {
  const existing = await TrackedTrader.findOne({ wallet: wallet.toLowerCase() });
  if (existing) {
    console.log(`Trader ${wallet} already exists as "${existing.label}"`);
    return;
  }

  const trader = new TrackedTrader({
    wallet: wallet.toLowerCase(),
    label,
    lastSeenTimestamp: Math.floor(Date.now() / 1000), // Start from now
  });

  await trader.save();
  console.log(`Added trader: ${label} (${wallet})`);
}

async function listTraders() {
  const traders = await TrackedTrader.find({}).sort({ addedAt: -1 });

  if (traders.length === 0) {
    console.log('No traders being tracked.\n');
    return;
  }

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('                    TRACKED TRADERS                             ');
  console.log('═══════════════════════════════════════════════════════════════');

  for (const t of traders) {
    const status = t.isActive ? '✅' : '⏸️';
    console.log(`\n${status} ${t.label}`);
    console.log(`   Wallet: ${t.wallet}`);
    console.log(`   Strategy: ${t.strategyLabel} | Volume: ${t.volumeLabel}`);
    console.log(`   Copy: ${t.copyMultiplier}x (max $${t.maxCopySize})`);
    console.log(`   Alerts: ${t.totalAlerts} | Copied: ${t.totalCopied}`);
    console.log(`   Last check: ${new Date(t.lastSeenTimestamp * 1000).toISOString()}`);
  }

  console.log('\n═══════════════════════════════════════════════════════════════\n');
}

async function showPendingAlerts() {
  const alerts = await TradeAlert.find({
    acknowledged: false,
    copyRecommendation: { $ne: 'SKIP' },
  })
    .sort({ alertedAt: -1 })
    .limit(20);

  if (alerts.length === 0) {
    console.log('No pending alerts.\n');
    return;
  }

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('                    PENDING ALERTS                              ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  for (const alert of alerts) {
    const emoji = alert.copyRecommendation === 'PRIORITY' ? '🔴 PRIORITY' :
                  alert.copyRecommendation === 'COPY' ? '🟡 COPY' :
                  '🟠 CAUTIOUS';

    const age = Math.floor((Date.now() - alert.alertedAt.getTime()) / 1000 / 60);

    console.log(`${emoji} [${age}m ago] ${alert.traderLabel}`);
    console.log(`   ${alert.side || alert.type} ${alert.outcome}`);
    console.log(`   ${alert.market.substring(0, 55)}...`);
    console.log(`   Trader: $${alert.usdcValue.toFixed(2)} @ ${(alert.price * 100).toFixed(0)}c`);
    if (alert.suggestedSize) {
      console.log(`   Suggested: $${alert.suggestedSize.toFixed(2)}`);
    }
    console.log(`   Reason: ${alert.reason}`);
    console.log(`   ID: ${alert._id}`);
    console.log('');
  }

  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`To acknowledge: db.getCollection("polymarket-tradeAlerts").updateOne({_id: ObjectId("...")}, {$set: {acknowledged: true}})`);
  console.log('═══════════════════════════════════════════════════════════════\n');
}

async function watchMode() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('                    TRADE ALERTS - WATCH MODE                   ');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('Polling every 60 seconds. Press Ctrl+C to stop.\n');

  while (true) {
    const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
    console.log(`\n[${timestamp}] Checking for new trades...`);

    const newAlerts = await checkTraders();

    if (newAlerts > 0) {
      console.log(`\n🔔 ${newAlerts} NEW ALERT(S)!`);
    }

    // Wait 60 seconds
    await new Promise((r) => setTimeout(r, 60000));
  }
}

// ═══════════════════════════════════════════════════════════════
// CLI
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

  await connectDB();

  const args = process.argv.slice(2);

  if (args[0] === '--add' && args[1] && args[2]) {
    await addTrader(args[1], args[2]);
  } else if (args[0] === '--list') {
    await listTraders();
  } else if (args[0] === '--pending') {
    await showPendingAlerts();
  } else if (args[0] === '--watch') {
    await watchMode();
  } else {
    // Default: check once
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('                    TRADE ALERTS CHECK                          ');
    console.log('═══════════════════════════════════════════════════════════════\n');

    const newAlerts = await checkTraders();

    console.log('\n───────────────────────────────────────────────────────────────');
    console.log(`Total new alerts: ${newAlerts}`);
    console.log('───────────────────────────────────────────────────────────────');
    console.log('Commands:');
    console.log('  --watch     Continuous monitoring');
    console.log('  --add       Add trader: --add <wallet> <label>');
    console.log('  --list      List tracked traders');
    console.log('  --pending   Show pending alerts');
    console.log('───────────────────────────────────────────────────────────────\n');
  }

  await mongoose.connection.close();
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
