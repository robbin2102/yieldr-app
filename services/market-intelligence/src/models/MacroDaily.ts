import mongoose, { Schema, Document } from 'mongoose';

export interface IMacroDaily extends Document {
  date: Date;
  btc_etf: { total_flow_usd: number | null; net_assets_usd: number | null; flows_by_ticker: Array<{ ticker: string; flow_usd: number }>; data_date: Date | null };
  eth_etf: { total_flow_usd: number | null; net_assets_usd: number | null; flows_by_ticker: Array<{ ticker: string; flow_usd: number }>; data_date: Date | null };
  coinbase_premium: { btc: number | null };
  fear_greed: { value: number | null; classification: string | null };
  stablecoin_mcap: { total_usd: number | null; change_24h_usd: number | null };
}

const ETFFlowsSchema = new Schema({
  total_flow_usd:  { type: Number, default: null },
  net_assets_usd:  { type: Number, default: null },
  flows_by_ticker: [{ ticker: String, flow_usd: Number, _id: false }],
  // data_date: the date of the ETF record returned by the API — used to detect stale data
  data_date:       { type: Date, default: null },
}, { _id: false });

const MacroDailySchema = new Schema<IMacroDaily>({
  date:             { type: Date, required: true },
  btc_etf:          { type: ETFFlowsSchema, default: () => ({ total_flow_usd: null, net_assets_usd: null, flows_by_ticker: [], data_date: null }) },
  eth_etf:          { type: ETFFlowsSchema, default: () => ({ total_flow_usd: null, net_assets_usd: null, flows_by_ticker: [], data_date: null }) },
  coinbase_premium: { btc: { type: Number, default: null } },
  fear_greed:       { value: { type: Number, default: null }, classification: { type: String, default: null } },
  stablecoin_mcap:  { total_usd: { type: Number, default: null }, change_24h_usd: { type: Number, default: null } },
}, { collection: 'macro_daily', timestamps: false });

MacroDailySchema.index({ date: -1 }, { unique: true });

export default mongoose.models.MacroDaily ||
  mongoose.model<IMacroDaily>('MacroDaily', MacroDailySchema);
