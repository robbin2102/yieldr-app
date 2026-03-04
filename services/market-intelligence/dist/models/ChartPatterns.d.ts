import mongoose, { Document } from 'mongoose';
export interface IChartPatterns extends Document {
    symbol: string;
    updated_at: Date;
    detected_patterns: Array<{
        pattern: string;
        timeframe: string;
        status: 'forming' | 'confirmed' | 'failed';
        key_levels: {
            neckline: number | null;
            breakout: number | null;
            target: number | null;
            stop: number | null;
        };
        confidence: number;
        detected_at: Date;
        volume_confirmation: boolean;
        notes: string;
    }>;
    active_count: number;
}
declare const _default: mongoose.Model<any, {}, {}, {}, any, any>;
export default _default;
