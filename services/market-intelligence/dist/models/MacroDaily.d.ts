import mongoose, { Document } from 'mongoose';
export interface IMacroDaily extends Document {
    date: Date;
    btc_etf: {
        total_flow_usd: number | null;
        net_assets_usd: number | null;
        flows_by_ticker: Array<{
            ticker: string;
            flow_usd: number;
        }>;
        data_date: Date | null;
    };
    eth_etf: {
        total_flow_usd: number | null;
        net_assets_usd: number | null;
        flows_by_ticker: Array<{
            ticker: string;
            flow_usd: number;
        }>;
        data_date: Date | null;
    };
    coinbase_premium: {
        btc: number | null;
    };
    fear_greed: {
        value: number | null;
        classification: string | null;
    };
    stablecoin_mcap: {
        total_usd: number | null;
        change_24h_usd: number | null;
    };
}
declare const _default: mongoose.Model<any, {}, {}, {}, any, any> | mongoose.Model<IMacroDaily, {}, {}, {}, mongoose.Document<unknown, {}, IMacroDaily, {}, {}> & IMacroDaily & Required<{
    _id: mongoose.Types.ObjectId;
}> & {
    __v: number;
}, any>;
export default _default;
