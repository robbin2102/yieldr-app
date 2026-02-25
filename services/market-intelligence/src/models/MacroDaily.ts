import mongoose, { Schema, Document } from 'mongoose';

export interface IMacroDaily extends Document {
  date: Date;
  btc_etf: { total_flow_usd: number | null; net_assets_usd: number | null; flows_by_ticker: Array<{ ticker: string; flow_usd: number }> };
  eth_etf: { total_flow_usd: number | null; net_assets_usd: number | null; flows_by_ticker: Array<{ ticker: string; flow_usd: number }> };
  coinbase_premium: { btc: number | null; eth: number | null };
  fear_greed: { value: number | null; classification: string | null };
  stablecoin_mcap: { total_usd: number | null; change_24h_usd: number | null };
}

const ETFFlowsSchema = new Schema({
  total_flow_usd: { type: Number, default: null },
  net_assets_usd: { type: Number, default: null },
  flows_by_ticker: [{ ticker: String, flow_usd: Number, _id: false }],
}, { _id: false });

const MacroDailySchema = new Schema<IMacroDaily>({
  date: { type: Date, required: true },
  btc_etf: { type: ETFFlowsSchema, default: () => ({ total_flow_usd: null, net_assets_usd: null, flows_by_ticker: [] }) },
  eth_etf: { type: ETFFlowsSchema, default: () => ({ total_flow_usd: null, net_assets_usd: null, flows_by_ticker: [] }) },
  coinbase_premium: { btc: { type: Number, default: null }, eth: { type: Number, default: null } },
  fear_greed: { value: { type: Number, default: null }, classification: { type: String, default: null } },
  stablecoin_mcap: { total_usd: { type: Number, default: null }, change_24h_usd: { type: Number, default: null } },
}, { collection: 'macro_daily', timestamps: false });

MacroDailySchema.index({ date: -1 }, { unique: true });

export default mongoose.models.MacroDaily ||
  mongoose.model<IMacroDaily>('MacroDaily', MacroDailySchema);
