/**
 * POST /api/alerts/acknowledge - Acknowledge an alert
 *
 * Body:
 *   - id: string (alert ID)
 *   - copied: boolean (optional - mark as copied too)
 *   - copiedTxHash: string (optional - transaction hash if copied)
 *   - copiedSize: number (optional - size copied)
 *   - copiedPrice: number (optional - price copied at)
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
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    await connectDB();

    const TradeAlert = mongoose.models.TradeAlert || mongoose.model('TradeAlert', TradeAlertSchema);

    const { id, copied, copiedTxHash, copiedSize, copiedPrice } = req.body;

    if (!id) {
      return res.status(400).json({ error: 'id is required' });
    }

    const update: any = {
      acknowledged: true,
      acknowledgedAt: new Date(),
    };

    if (copied) {
      update.copied = true;
      update.copiedAt = new Date();
      if (copiedTxHash) update.copiedTxHash = copiedTxHash;
      if (copiedSize) update.copiedSize = copiedSize;
      if (copiedPrice) update.copiedPrice = copiedPrice;
    }

    const alert = await TradeAlert.findByIdAndUpdate(id, { $set: update }, { new: true });

    if (!alert) {
      return res.status(404).json({ error: 'Alert not found' });
    }

    return res.status(200).json({
      success: true,
      alert,
    });
  } catch (error: any) {
    console.error('Error acknowledging alert:', error);
    return res.status(500).json({ error: error.message });
  }
}
