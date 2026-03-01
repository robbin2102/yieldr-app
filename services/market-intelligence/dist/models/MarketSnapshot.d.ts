import mongoose, { Document } from 'mongoose';
export interface IMarketSnapshot extends Document {
    symbol: string;
    timestamp: Date;
    interval: string;
    price: {
        open: number;
        high: number;
        low: number;
        close: number;
        volume: number;
    };
    indicators: Record<string, unknown>;
    candlestick_patterns: Array<{
        pattern: string;
        value: number;
        timeframe: string;
    }>;
    derivatives: Record<string, unknown>;
    computed: {
        ma_crossovers: unknown[];
        divergences: unknown[];
        market_structure: Record<string, unknown>;
        fvg: unknown[];
        order_blocks: unknown[];
        alerts: unknown[];
    };
    chart_patterns: unknown[];
    tier: 'full' | 'lite' | 'on_demand';
    fetched_on_demand: boolean;
    on_demand_expires_at: Date | null;
    fetch_duration_ms: number;
}
declare const _default: mongoose.Model<any, {}, {}, {}, any, any> | mongoose.Model<IMarketSnapshot, {}, {}, {}, mongoose.Document<unknown, {}, IMarketSnapshot, {}, {}> & IMarketSnapshot & Required<{
    _id: mongoose.Types.ObjectId;
}> & {
    __v: number;
}, any>;
export default _default;
