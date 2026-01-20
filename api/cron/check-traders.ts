/**
 * Vercel Cron Job - Check tracked traders for new trades
 *
 * Runs every minute via Vercel cron
 * Configure in vercel.json:
 * {
 *   "crons": [{
 *     "path": "/api/cron/check-traders",
 *     "schedule": "* * * * *"
 *   }]
 * }
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import mongoose from 'mongoose';

const API_BASE = 'https://data-api.polymarket.com';

// ═══════════════════════════════════════════════════════════════
// Inline schemas (to avoid import issues in Vercel)
// ═══════════════════════════════════════════════════════════════

const TradeAlertSchema = new mongoose.Schema(
  {
    traderWallet: { type: String, required: true, index: true },
    traderLabel: { type: String },
    type: { type: String, required: true },
    side: { type: String },
    market: { type: String, required: true },
    marketSlug: { type: String },
    outcome: { type: String, required: true },
    conditionId: { type: String, required: true },
    tokenId: { type: String, required: true },
    size: { type: Number, required: true },
    price: { type: Number, required: true },
    usdcValue: { type: Number, required: true },
    timestamp: { type: Date, required: true },
    txHash: { type: String, required: true, unique: true },
    copyRecommendation: { type: String, required: true, default: 'COPY' },
    suggestedSize: { type: Number },
    reason: { type: String },
    alertedAt: { type: Date, default: Date.now },
    acknowledged: { type: Boolean, default: false },
    acknowledgedAt: { type: Date },
    copied: { type: Boolean, default: false },
    copiedAt: { type: Date },
    copiedTxHash: { type: String },
  },
  { timestamps: true, collection: 'polymarket-tradeAlerts' }
);

const TrackedTraderSchema = new mongoose.Schema(
  {
    wallet: { type: String, required: true, unique: true, lowercase: true },
    label: { type: String, required: true },
    volumeLabel: { type: String, default: 'MEDIUM' },
    strategyLabel: { type: String, default: 'BUY_AND_HOLD' },
    copyMultiplier: { type: Number, default: 1.0 },
    maxCopySize: { type: Number, default: 100 },
    skipSmallBets: { type: Boolean, default: true },
    smallBetThreshold: { type: Number, default: 50 },
    lastSeenTimestamp: { type: Number, default: () => Math.floor(Date.now() / 1000) },
    isActive: { type: Boolean, default: true },
    totalAlerts: { type: Number, default: 0 },
  },
  { collection: 'polymarket-trackedTraders' }
);

// ═══════════════════════════════════════════════════════════════
// Database connection
// ═══════════════════════════════════════════════════════════════

let cachedConnection: typeof mongoose | null = null;

async function connectDB() {
  if (cachedConnection) return cachedConnection;

  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is required');

  cachedConnection = await mongoose.connect(uri);
  return cachedConnection;
}

// ═══════════════════════════════════════════════════════════════
// API Functions
// ═══════════════════════════════════════════════════════════════

interface Activity {
  conditionId: string;
  asset: string;
  title: string;
  slug?: string;
  outcome: string;
  type: string;
  side?: string;
  size: number;
  price: number;
  usdcSize: number;
  timestamp: number;
  transactionHash: string;
}

async function fetchNewActivities(wallet: string, sinceTimestamp: number): Promise<Activity[]> {
  const url = `${API_BASE}/activity?user=${wallet}&limit=50&sortBy=TIMESTAMP&sortDirection=DESC`;

  const response = await fetch(url);
  if (!response.ok) throw new Error(`API error: ${response.status}`);

  const activities = (await response.json()) as Activity[];

  return activities.filter(
    (a) => a.timestamp > sinceTimestamp && (a.type === 'TRADE' || a.type === 'REDEEM')
  );
}

function determineCopyRecommendation(
  trader: any,
  activity: Activity
): { recommendation: string; reason: string } {
  if (trader.skipSmallBets && activity.usdcSize < trader.smallBetThreshold) {
    return { recommendation: 'SKIP', reason: `Small bet ($${activity.usdcSize.toFixed(2)})` };
  }

  if (activity.type === 'REDEEM') {
    return { recommendation: 'SKIP', reason: 'REDEEM (market resolved)' };
  }

  if (activity.side === 'BUY') {
    if (activity.price < 0.40) {
      return { recommendation: 'PRIORITY', reason: `Underdog (${(activity.price * 100).toFixed(0)}c)` };
    }
    if (activity.price < 0.60) {
      return { recommendation: 'COPY', reason: `Mid-range (${(activity.price * 100).toFixed(0)}c)` };
    }
    return { recommendation: 'CAUTIOUS', reason: `Favorite (${(activity.price * 100).toFixed(0)}c)` };
  }

  return { recommendation: 'COPY', reason: 'Standard trade' };
}

// ═══════════════════════════════════════════════════════════════
// Handler
// ═══════════════════════════════════════════════════════════════

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Verify cron secret (optional security)
  const cronSecret = req.headers['x-vercel-cron-secret'];
  if (process.env.CRON_SECRET && cronSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    await connectDB();

    const TradeAlert = mongoose.models.TradeAlert || mongoose.model('TradeAlert', TradeAlertSchema);
    const TrackedTrader = mongoose.models.TrackedTrader || mongoose.model('TrackedTrader', TrackedTraderSchema);

    const traders = await TrackedTrader.find({ isActive: true });

    if (traders.length === 0) {
      return res.status(200).json({ message: 'No traders to check', alerts: 0 });
    }

    let totalNewAlerts = 0;
    const newAlerts: any[] = [];

    for (const trader of traders) {
      try {
        const activities = await fetchNewActivities(trader.wallet, trader.lastSeenTimestamp);

        for (const activity of activities) {
          // Check for duplicate
          const existing = await TradeAlert.findOne({ txHash: activity.transactionHash });
          if (existing) continue;

          const { recommendation, reason } = determineCopyRecommendation(trader, activity);

          let suggestedSize = activity.usdcSize * trader.copyMultiplier;
          if (suggestedSize > trader.maxCopySize) suggestedSize = trader.maxCopySize;

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
          });

          await alert.save();
          totalNewAlerts++;
          newAlerts.push({
            trader: trader.label,
            side: activity.side,
            outcome: activity.outcome,
            market: activity.title.substring(0, 50),
            usdcValue: activity.usdcSize,
            recommendation,
          });

          // Update last seen
          if (activity.timestamp > trader.lastSeenTimestamp) {
            trader.lastSeenTimestamp = activity.timestamp;
          }
        }

        if (activities.length > 0) {
          trader.totalAlerts += activities.length;
          await trader.save();
        }
      } catch (err: any) {
        console.error(`Error checking ${trader.label}: ${err.message}`);
      }

      // Rate limit
      await new Promise((r) => setTimeout(r, 100));
    }

    return res.status(200).json({
      success: true,
      tradersChecked: traders.length,
      newAlerts: totalNewAlerts,
      alerts: newAlerts,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('Cron error:', error);
    return res.status(500).json({ error: error.message });
  }
}
