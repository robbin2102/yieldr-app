import mongoose, { Schema, Document } from 'mongoose';

export interface ILiquidationLevels extends Document {
  symbol: string;
  updated_at: Date;
  current_price: number | null;
  price_buckets: Array<{
    price_low: number; price_high: number;
    long_liq_usd: number; short_liq_usd: number;
    total_usd: number; count: number;
  }>;
  total_long_liq_24h: number | null;
  total_short_liq_24h: number | null;
  heaviest_cluster: { price_range: string | null; total_usd: number | null; side: string | null };
  nearest_cluster_distance_pct: number | null;
}

const LiquidationLevelsSchema = new Schema<ILiquidationLevels>({
  symbol:       { type: String, required: true, uppercase: true },
  updated_at:   { type: Date, default: Date.now },
  current_price: { type: Number, default: null },
  price_buckets: [{
    price_low: Number, price_high: Number,
    long_liq_usd:  { type: Number, default: 0 },
    short_liq_usd: { type: Number, default: 0 },
    total_usd:     { type: Number, default: 0 },
    count:         { type: Number, default: 0 },
    _id: false,
  }],
  total_long_liq_24h:          { type: Number, default: null },
  total_short_liq_24h:         { type: Number, default: null },
  heaviest_cluster: {
    price_range: { type: String, default: null },
    total_usd:   { type: Number, default: null },
    side:        { type: String, default: null },
  },
  nearest_cluster_distance_pct: { type: Number, default: null },
}, { collection: 'liquidation_levels', timestamps: false });

LiquidationLevelsSchema.index({ symbol: 1 }, { unique: true });

export default mongoose.models.LiquidationLevels ||
  mongoose.model<ILiquidationLevels>('LiquidationLevels', LiquidationLevelsSchema);
