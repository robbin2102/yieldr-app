/**
 * Live Vault Data — cached summary from the vaults collection
 *
 * Same collection the TG agent reads. Refreshed every ~60s.
 */

import { getDB, COLLECTIONS } from './db';

let _cache: string | null = null;
let _cacheTs = 0;
const CACHE_TTL_MS = 60_000;

const VAULT_PERF_KEYWORDS = [
  'perform', 'roi', 'return', 'stat', 'win rate', 'pnl', 'profit',
  'loss', 'drawdown', 'result', 'track record', 'number', 'figure',
  'live', 'current', 'latest', 'recent', 'achievement', 'how have',
  'how are', 'doing',
];

export function isPerformanceQuery(text: string): boolean {
  const lower = text.toLowerCase();
  return VAULT_PERF_KEYWORDS.some((kw) => lower.includes(kw));
}

export async function getLiveVaultSummary(): Promise<string> {
  const now = Date.now();
  if (_cache && now - _cacheTs < CACHE_TTL_MS) return _cache;

  try {
    const db = await getDB();
    const col = db.collection(COLLECTIONS.VAULTS);

    const vaults = await col
      .find(
        { status: 'active' },
        {
          projection: {
            traderLabel: 1,
            vault_size_usdc: 1,
            initial_capital_usdc: 1,
            totalPnlAllTime: 1,
            win_rate: 1,
            win_rate_sample_size: 1,
            'timeframePnL.30d': 1,
            'timeframePnL.7d': 1,
            currentStreak: 1,
            currentStreakType: 1,
            profitFactor: 1,
            label: 1,
          },
        },
      )
      .toArray();

    if (!vaults.length) return '';

    const lines = ['Live vault performance (updated every ~1 min):'];
    for (const v of vaults) {
      const initial = v.initial_capital_usdc || 0;
      const current = v.vault_size_usdc || 0;
      const roi = initial ? ((current - initial) / initial) * 100 : 0;
      const d30 = v.timeframePnL?.['30d'] || {};
      lines.push(
        `${v.traderLabel} [${v.label}]: size=$${current.toLocaleString()} | ROI=${roi >= 0 ? '+' : ''}${roi.toFixed(1)}% | all-time PnL=$${(v.totalPnlAllTime || 0).toLocaleString()} | win rate=${(v.win_rate || 0).toFixed(1)}% over ${v.win_rate_sample_size || 0} trades | 30d ROCE=${(d30.roce || 0).toFixed(1)}% | streak=${v.currentStreak || 0} ${(v.currentStreakType || '').toLowerCase()}`,
      );
    }

    _cache = lines.join('\n');
    _cacheTs = now;
    return _cache;
  } catch (error: any) {
    console.error('[VaultData] Failed to fetch live vault summary:', error.message);
    return '';
  }
}
