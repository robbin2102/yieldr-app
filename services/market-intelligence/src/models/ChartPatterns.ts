import mongoose, { Schema, Document } from 'mongoose';

export interface IChartPatterns extends Document {
  symbol: string;
  updated_at: Date;
  detected_patterns: Array<{
    pattern: string;
    timeframe: string;
    status: 'forming' | 'confirmed' | 'failed';
    key_levels: { neckline: number | null; breakout: number | null; target: number | null; stop: number | null };
    confidence: number;
    detected_at: Date;
    volume_confirmation: boolean;
    notes: string;
  }>;
  active_count: number;
}

const ChartPatternsSchema = new Schema<IChartPatterns>({
  symbol: { type: String, required: true, uppercase: true },
  updated_at: { type: Date, default: Date.now },
  detected_patterns: [{
    pattern: { type: String, required: true },
    timeframe: { type: String, default: '1h' },
    status: { type: String, enum: ['forming', 'confirmed', 'failed'], default: 'forming' },
    key_levels: {
      neckline: { type: Number, default: null },
      breakout: { type: Number, default: null },
      target: { type: Number, default: null },
      stop: { type: Number, default: null },
    },
    confidence: { type: Number, min: 0, max: 1, default: 0.5 },
    detected_at: { type: Date, default: Date.now },
    volume_confirmation: { type: Boolean, default: false },
    notes: { type: String, default: '' },
  }],
  active_count: { type: Number, default: 0 },
}, { collection: 'chart_patterns', timestamps: false });

ChartPatternsSchema.index({ symbol: 1 }, { unique: true });

export default mongoose.models.ChartPatterns ||
  mongoose.model<IChartPatterns>('ChartPatterns', ChartPatternsSchema);
