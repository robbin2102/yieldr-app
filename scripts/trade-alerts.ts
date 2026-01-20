/**
 * Trade Alerts - Monitor target traders for new trades
 *
 * Usage:
 *   npx tsx scripts/trade-alerts.ts              # Check once and exit
 *   npx tsx scripts/trade-alerts.ts --watch      # Continuous monitoring (60s interval)
 *   npx tsx scripts/trade-alerts.ts --add <wallet> <label> [backfill_hours]  # Add trader
 *   npx tsx scripts/trade-alerts.ts --fix        # Sync all traders to API timestamps
 *   npx tsx scripts/trade-alerts.ts --list       # List tracked traders
 *   npx tsx scripts/trade-alerts.ts --pending    # Show pending alerts
 *
 * Examples:
 *   --add 0x123... "Whale1"       # Add trader, start from latest API activity
 *   --add 0x123... "Whale1" 24    # Add trader, backfill last 24 hours
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
  conditionId?: string;
  asset?: string;
  title: string;
  slug?: string;
  outcome?: string;
  type: 'TRADE' | 'REDEEM' | 'YIELD' | 'SPLIT' | 'MERGE' | 'REWARD' | 'CONVERSION';
  side?: 'BUY' | 'SELL' | '';
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
  // Paginate to ensure we catch all activities since lastSeenTimestamp
  const LIMIT = 500;
  const MAX_OFFSET = 2000;
  let allActivities: Activity[] = [];
  let offset = 0;

  while (offset <= MAX_OFFSET) {
    const url = `${API_BASE}/activity?user=${wallet}&limit=${LIMIT}&offset=${offset}&sortBy=TIMESTAMP&sortDirection=DESC`;
    const response = await fetchWithRetry(url);
    const batch = (await response.json()) as Activity[];

    if (batch.length === 0) break;

    // Collect all activities newer than sinceTimestamp
    for (const activity of batch) {
      if (activity.timestamp > sinceTimestamp) {
        allActivities.push(activity);
      } else {
        // Reached activities older than sinceTimestamp, stop
        return allActivities;
      }
    }

    if (batch.length < LIMIT) break;
    offset += LIMIT;
    await new Promise(r => setTimeout(r, 100));
  }

  return allActivities;
}

async function fetchLatestActivity(wallet: string): Promise<Activity | null> {
  const url = `${API_BASE}/activity?user=${wallet}&limit=1&sortBy=TIMESTAMP&sortDirection=DESC`;
  try {
    const response = await fetchWithRetry(url);
    const activities = (await response.json()) as Activity[];
    return activities[0] || null;
  } catch {
    return null;
  }
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

  // Non-TRADE types are informational only
  if (activity.type !== 'TRADE') {
    return { recommendation: 'SKIP', reason: `${activity.type} (informational)`, isHighConviction: false };
  }

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

  // Handle empty string side (convert to undefined for valid enum)
  const side = activity.side && activity.side !== '' ? activity.side : undefined;

  const alert = new TradeAlert({
    traderWallet: trader.wallet,
    traderLabel: trader.label,
    type: activity.type,
    side,
    market: activity.title,
    marketSlug: activity.slug,
    outcome: activity.outcome || undefined,
    conditionId: activity.conditionId || undefined,
    tokenId: activity.asset || undefined,
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
    const sinceTime = new Date(trader.lastSeenTimestamp * 1000).toISOString().split('T')[1].split('.')[0];
    console.log(`Checking ${trader.label} (since ${sinceTime})...`);

    try {
      const activities = await fetchNewActivities(trader.wallet, trader.lastSeenTimestamp);

      if (activities.length > 0) {
        const newestTs = Math.max(...activities.map(a => a.timestamp));
        const newestTime = new Date(newestTs * 1000).toISOString().split('T')[1].split('.')[0];
        console.log(`  Found ${activities.length} activities (up to ${newestTime})`);

        let savedCount = 0;
        for (const activity of activities) {
          const alert = await createAlert(trader, activity);

          if (alert) {
            savedCount++;
            totalNewAlerts++;
            const emoji = alert.copyRecommendation === 'PRIORITY' ? '🔴' :
                          alert.copyRecommendation === 'COPY' ? '🟡' :
                          alert.copyRecommendation === 'CAUTIOUS' ? '🟠' : '⚪';

            console.log(`  ${emoji} ${alert.type} ${alert.side || ''} ${alert.outcome || ''} - $${alert.usdcValue.toFixed(2)}`);
          }

          // Update last seen timestamp
          if (activity.timestamp > trader.lastSeenTimestamp) {
            trader.lastSeenTimestamp = activity.timestamp;
          }
        }

        // Save trader with updated timestamp and stats
        trader.totalAlerts += savedCount;
        trader.lastUpdatedAt = new Date();
        await trader.save();
        console.log(`  Saved ${savedCount} alerts to MongoDB`);
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

async function addTrader(wallet: string, label: string, backfillHours = 0) {
  const existing = await TrackedTrader.findOne({ wallet: wallet.toLowerCase() });
  if (existing) {
    console.log(`Trader ${wallet} already exists as "${existing.label}"`);
    return;
  }

  // Get the latest activity from API to determine starting point
  // This handles API delay - we start from where the API actually is, not "now"
  const latestActivity = await fetchLatestActivity(wallet.toLowerCase());
  let lastSeenTimestamp: number;

  if (latestActivity) {
    if (backfillHours > 0) {
      // Backfill: set to N hours before the latest activity
      lastSeenTimestamp = latestActivity.timestamp - (backfillHours * 60 * 60);
      console.log(`Starting from ${backfillHours}h before latest API activity...`);
    } else {
      // No backfill: start from the latest activity (won't alert on it, but will catch new ones)
      lastSeenTimestamp = latestActivity.timestamp;
      console.log(`Starting from latest API activity (${new Date(latestActivity.timestamp * 1000).toISOString()})`);
    }
  } else {
    // Fallback if we can't fetch - use current time minus 1 hour to be safe
    lastSeenTimestamp = Math.floor(Date.now() / 1000) - 3600;
    console.log(`Could not fetch latest activity, starting from 1 hour ago`);
  }

  const trader = new TrackedTrader({
    wallet: wallet.toLowerCase(),
    label,
    lastSeenTimestamp,
  });

  await trader.save();
  console.log(`Added trader: ${label} (${wallet})`);

  // If backfilling, immediately check for activities
  if (backfillHours > 0) {
    const activities = await fetchNewActivities(wallet.toLowerCase(), lastSeenTimestamp);
    if (activities.length > 0) {
      console.log(`  Found ${activities.length} activities in last ${backfillHours}h`);
      for (const activity of activities) {
        const alert = await createAlert(trader, activity);
        if (alert) {
          console.log(`  📝 ${alert.side || alert.type} ${alert.outcome} - $${alert.usdcValue.toFixed(2)}`);
        }
        if (activity.timestamp > trader.lastSeenTimestamp) {
          trader.lastSeenTimestamp = activity.timestamp;
        }
      }
      trader.totalAlerts = activities.length;
      trader.lastUpdatedAt = new Date();
      await trader.save();
    } else {
      console.log(`  No activities found in last ${backfillHours}h`);
    }
  }
}

async function listTraders() {
  // Show database info
  const dbName = mongoose.connection.db?.databaseName || 'unknown';
  console.log(`[DB] Database: ${dbName}`);
  console.log(`[DB] Traders collection: polymarket-trackedTraders`);
  console.log(`[DB] Alerts collection: polymarket-tradeAlerts\n`);

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
    console.log(`   Alerts: ${t.totalAlerts} | Copied: ${t.totalCopied}`);
    console.log(`   Last check: ${new Date(t.lastSeenTimestamp * 1000).toISOString()}`);

    // Fetch last activity from API to show when trader was last active
    const lastActivity = await fetchLatestActivity(t.wallet);
    if (lastActivity) {
      const lastTradeTime = new Date(lastActivity.timestamp * 1000);
      const ageMinutes = Math.floor((Date.now() - lastTradeTime.getTime()) / 1000 / 60);
      const ageStr = ageMinutes < 60 ? `${ageMinutes}m ago` :
                     ageMinutes < 1440 ? `${Math.floor(ageMinutes / 60)}h ago` :
                     `${Math.floor(ageMinutes / 1440)}d ago`;
      console.log(`   Last trade: ${lastActivity.type} ${lastActivity.outcome?.substring(0, 20) || ''} (${ageStr})`);
    } else {
      console.log(`   Last trade: Unable to fetch`);
    }
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

async function fixTraderTimestamps() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('                    FIX TRADER TIMESTAMPS                       ');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('Syncing all traders to latest API activity timestamp...\n');

  const traders = await TrackedTrader.find({});

  for (const trader of traders) {
    const latestActivity = await fetchLatestActivity(trader.wallet);
    if (latestActivity) {
      const oldTs = trader.lastSeenTimestamp;
      trader.lastSeenTimestamp = latestActivity.timestamp;
      await trader.save();
      console.log(`✅ ${trader.label}`);
      console.log(`   Old: ${new Date(oldTs * 1000).toISOString()}`);
      console.log(`   New: ${new Date(latestActivity.timestamp * 1000).toISOString()}`);
      console.log(`   Latest: ${latestActivity.type} ${latestActivity.outcome?.substring(0, 25) || ''}`);
      console.log('');
    } else {
      console.log(`❌ ${trader.label} - Could not fetch latest activity`);
    }
    await new Promise(r => setTimeout(r, 200));
  }

  console.log('Done! All traders synced to API timestamps.\n');
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
      console.log(`\n🔔 ${newAlerts} NEW ALERT(S) saved to MongoDB!`);
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
    const backfillHours = args[3] ? parseInt(args[3]) : 0;
    await addTrader(args[1], args[2], backfillHours);
  } else if (args[0] === '--list') {
    await listTraders();
  } else if (args[0] === '--pending') {
    await showPendingAlerts();
  } else if (args[0] === '--fix') {
    await fixTraderTimestamps();
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
    console.log('  --watch     Continuous monitoring (60s poll)');
    console.log('  --fix       Sync all traders to latest API timestamps');
    console.log('  --add       Add trader: --add <wallet> <label> [backfill_hours]');
    console.log('  --list      List tracked traders with last activity');
    console.log('  --pending   Show pending alerts');
    console.log('───────────────────────────────────────────────────────────────\n');
  }

  await mongoose.connection.close();
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
