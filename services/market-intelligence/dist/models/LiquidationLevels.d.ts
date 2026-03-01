import mongoose, { Document } from 'mongoose';
export interface ILiquidationLevels extends Document {
    symbol: string;
    updated_at: Date;
    current_price: number | null;
    price_buckets: Array<{
        price_low: number;
        price_high: number;
        long_liq_usd: number;
        short_liq_usd: number;
        total_usd: number;
        count: number;
    }>;
    total_long_liq_24h: number | null;
    total_short_liq_24h: number | null;
    heaviest_cluster: {
        price_range: string | null;
        total_usd: number | null;
        side: string | null;
    };
    nearest_cluster_distance_pct: number | null;
}
declare const _default: mongoose.Model<any, {}, {}, {}, any, any>;
export default _default;
