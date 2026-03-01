import mongoose, { Document } from 'mongoose';
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
declare const _default: mongoose.Model<any, {}, {}, {}, any, any>;
export default _default;
