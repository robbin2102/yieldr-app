/**
 * get_macro_snapshot Tool
 * Query daily macro data: BTC/ETH ETF flows, Coinbase premium, Fear & Greed, stablecoin mcap
 */

import { z } from 'zod';
import { getDB, COLLECTIONS } from '../../db/mongodb.js';

export const getMacroSnapshotSchema = z.object({
  days: z
    .number()
    .optional()
    .default(1)
    .describe('Number of days to return (default: 1, max: 30). Each day is one document.'),
});

export type GetMacroSnapshotInput = z.infer<typeof getMacroSnapshotSchema>;

export async function executeGetMacroSnapshot(input: GetMacroSnapshotInput) {
  const { days = 1 } = input;
  const limit = Math.min(days, 30);

  const db = await getDB();
  const col = db.collection(COLLECTIONS.MACRO_DAILY);

  const docs = await col
    .find({})
    .sort({ date: -1 })
    .limit(limit)
    .toArray();

  if (!docs.length) {
    return {
      found: false,
      message: 'No macro data yet. Daily cron runs at 10:00 UTC.',
    };
  }

  const ageMs = Date.now() - new Date(docs[0].date).getTime();
  const ageHours = Math.round(ageMs / 3600000);

  return {
    found: true,
    data_age_hours: ageHours,
    days_returned: docs.length,
    macro: docs.map(d => ({
      date: d.date,
      fear_greed: d.fear_greed,
      btc_etf: {
        total_flow_usd: d.btc_etf?.total_flow_usd,
        net_assets_usd: d.btc_etf?.net_assets_usd,
        top_flows: (d.btc_etf?.flows_by_ticker ?? []).slice(0, 5),
      },
      eth_etf: {
        total_flow_usd: d.eth_etf?.total_flow_usd,
        net_assets_usd: d.eth_etf?.net_assets_usd,
        top_flows: (d.eth_etf?.flows_by_ticker ?? []).slice(0, 5),
      },
      coinbase_premium: d.coinbase_premium,
      stablecoin_mcap: d.stablecoin_mcap,
    })),
  };
}

export const getMacroSnapshotTool = {
  name: 'get_macro_snapshot',
  description:
    'Get daily macro data: BTC + ETH ETF flows (total + by ticker), ETF net assets, Coinbase premium index (BTC + ETH), Fear & Greed index, and stablecoin market cap. Updated daily at 10:00 UTC. Use for macro context before analyzing any coin setup.',
  inputSchema: getMacroSnapshotSchema,
  execute: executeGetMacroSnapshot,
};
