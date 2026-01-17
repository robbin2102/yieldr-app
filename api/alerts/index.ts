/**
 * GET /api/alerts - Fetch trade alerts
 *
 * Query params:
 *   - acknowledged: 'true' | 'false' (filter by status)
 *   - limit: number (default 50)
 *   - trader: string (filter by trader wallet)
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import mongoose from 'mongoose';

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
    copiedSize: { type: Number },
    copiedPrice: { type: Number },
  },
  { timestamps: true, collection: 'polymarket-tradeAlerts' }
);

let cachedConnection: typeof mongoose | null = null;

async function connectDB() {
  if (cachedConnection) return cachedConnection;
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is required');
  cachedConnection = await mongoose.connect(uri);
  return cachedConnection;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    await connectDB();

    const TradeAlert = mongoose.models.TradeAlert || mongoose.model('TradeAlert', TradeAlertSchema);

    const { acknowledged, limit = '50', trader, recommendation } = req.query;

    const filter: any = {};

    if (acknowledged === 'true') filter.acknowledged = true;
    else if (acknowledged === 'false') filter.acknowledged = false;

    if (trader) filter.traderWallet = (trader as string).toLowerCase();

    if (recommendation) filter.copyRecommendation = recommendation;

    const alerts = await TradeAlert.find(filter)
      .sort({ alertedAt: -1 })
      .limit(parseInt(limit as string, 10))
      .lean();

    // Add computed fields
    const enrichedAlerts = alerts.map((alert: any) => ({
      ...alert,
      ageMinutes: Math.floor((Date.now() - new Date(alert.alertedAt).getTime()) / 1000 / 60),
      priceDisplay: `${(alert.price * 100).toFixed(0)}c`,
    }));

    return res.status(200).json({
      success: true,
      count: enrichedAlerts.length,
      alerts: enrichedAlerts,
    });
  } catch (error: any) {
    console.error('Error fetching alerts:', error);
    return res.status(500).json({ error: error.message });
  }
}
