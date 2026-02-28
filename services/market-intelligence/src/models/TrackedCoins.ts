import mongoose, { Schema, Document } from 'mongoose';

export interface ITrackedCoins extends Document {
  updated_at: Date;
  all: string[];
  full_derivatives: string[];
  lite_derivatives: string[];
  excluded: string[];
  source_taapi_count: number;
  source_coinglass_count: number;
  intersection_count: number;
}

const TrackedCoinsSchema = new Schema<ITrackedCoins>({
  updated_at:            { type: Date,     default: Date.now },
  all:                   { type: [String], default: [] },
  full_derivatives:      { type: [String], default: [] },
  lite_derivatives:      { type: [String], default: [] },
  excluded:              { type: [String], default: [] },
  source_taapi_count:    { type: Number,   default: 0 },
  source_coinglass_count: { type: Number,  default: 0 },
  intersection_count:    { type: Number,   default: 0 },
}, { collection: 'tracked_coins', timestamps: false });

export default mongoose.models.TrackedCoins ||
  mongoose.model<ITrackedCoins>('TrackedCoins', TrackedCoinsSchema);
