import { Document } from 'mongoose';
export interface IMarketStructureHistory extends Document {
    symbol: string;
    updated_at: Date;
    swing_points: Array<{
        type: 'high' | 'low';
        price: number;
        timestamp: Date;
        timeframe: string;
    }>;
    structure_events: Array<{
        type: 'bos' | 'choch';
        direction: 'bullish' | 'bearish';
        price: number;
        timestamp: Date;
    }>;
    trend: 'uptrend' | 'downtrend' | 'range';
    last_hh: number | null;
    last_hl: number | null;
    last_lh: number | null;
    last_ll: number | null;
}
declare const _default: any;
export default _default;
