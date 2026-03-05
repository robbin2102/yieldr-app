import mongoose, { Document } from 'mongoose';
export interface IOhlcv15m extends Document {
    symbol: string;
    timestamp: Date;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    fetched_at: Date;
}
declare const _default: mongoose.Model<IOhlcv15m, {}, {}, {}, mongoose.Document<unknown, {}, IOhlcv15m, {}, {}> & IOhlcv15m & Required<{
    _id: mongoose.Types.ObjectId;
}> & {
    __v: number;
}, any>;
export default _default;
