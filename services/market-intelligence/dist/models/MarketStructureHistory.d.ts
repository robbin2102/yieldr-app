import mongoose, { Document } from 'mongoose';
export interface ISwingPoint {
    type: 'high' | 'low';
    price: number;
    timestamp: Date;
    timeframe: string;
}
export interface IStructureEvent {
    type: 'bos' | 'choch';
    direction: 'bullish' | 'bearish';
    price: number;
    timestamp: Date;
}
export interface IMarketStructureHistory extends Document {
    symbol: string;
    updated_at: Date;
    swing_points: ISwingPoint[];
    structure_events: IStructureEvent[];
    trend: string;
    last_hh: number | null;
    last_hl: number | null;
    last_lh: number | null;
    last_ll: number | null;
}
declare const _default: mongoose.Model<any, {}, {}, {}, any, any>;
export default _default;
