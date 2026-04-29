import { ContentStyle, STYLE_DESCRIPTIONS } from '../styles';

export function buildTraderAlphaPrompt(
  traderData: any,
  opts?: { rotation?: number; totalTraders?: number; style?: ContentStyle }
): string {
  const t = traderData;
  const metrics = t.metrics || {};
  const edge = t.edge || {};
  const style = opts?.style || 'narrative';

  const winRateGap = metrics.winRate && edge.expectedWinRate
    ? (metrics.winRate - edge.expectedWinRate * 100).toFixed(1)
    : null;

  const winningPositions = (t.topOpenPositions || [])
    .filter((p: any) => (p.percentPnl || 0) > 0 && p.curPrice < 0.95)
    .slice(0, 3);

  const hcTrades = (t.highConviction?.recentTrades || []).slice(0, 3);
  const catBreakdown = (t.categoryBreakdown || []).slice(0, 5);
  const strengths = (t.strengths || []).slice(0, 3);

  const rotationNote = opts?.rotation
    ? `(Trader ${opts.rotation}/${opts.totalTraders || 4} in today's series — mention naturally, don't force it)`
    : '';

  return `Write a post about this Polymarket trader. ${rotationNote}

${STYLE_DESCRIPTIONS[style]}

━━━ TRADER DATA ━━━
Rank: #${t.rank || '?'} by statistical edge
Wallet: ${t.wallet || 'N/A'}${t.xUsername ? ` | X: @${t.xUsername}` : ''}
Specialty: ${t.specialty || 'Multi-category'}
Strategy: ${t.strategyLabel || 'N/A'} | Volume: ${t.volumeLabel || 'N/A'}
Account age: ${t.accountAgeDays ? t.accountAgeDays + ' days' : 'N/A'}

Win Rate: ${metrics.winRate?.toFixed(1)}%${winRateGap ? ` (expected ${(edge.expectedWinRate * 100).toFixed(1)}% — that's a ${winRateGap}pp edge gap)` : ''}
P-value: ${edge.pValue != null ? edge.pValue.toFixed(8) : 'N/A'} — ${edge.pValue < 0.0001 ? 'statistically impossible to fake' : 'confirmed edge'}
Profit Factor: ${metrics.profitFactor?.toFixed(2)}x
30d PnL: $${metrics.pnl30d?.toLocaleString() || 'N/A'} | ROCE: ${metrics.roce30d?.toFixed(0) || 'N/A'}%
All-time PnL: $${metrics.totalPnlAllTime?.toLocaleString() || 'N/A'}
Sample: ${metrics.sampleSize} closed trades | ${metrics.tradesPerDay?.toFixed(1) || '?'} trades/day
Current streak: ${t.currentStreak || 0} ${t.currentStreakType || ''}
Sortino: ${metrics.sortino?.toFixed(2) || 'N/A'} | Max DD: ${t.maxDrawdown30dPct != null ? t.maxDrawdown30dPct.toFixed(1) + '%' : 'N/A'} (30d)

Edge hypothesis: ${t.edgeHypothesis || 'N/A'}
Sustainability: ${t.sustainability || 'N/A'}
Insider signals: ${t.insider || 'none'} (score: ${t.insiderScore || 'N/A'})

${catBreakdown.length ? `Category breakdown:\n${catBreakdown.map((c: any) => `${c.category}: ${c.win_rate?.toFixed(0)}% WR, $${c.total_pnl?.toLocaleString()} PnL, ${c.closed_positions || '?'} trades`).join('\n')}` : ''}

${strengths.length ? `Best categories:\n${strengths.map((s: any) => `${s.category}: ${s.winRate?.toFixed(0)}% WR, $${s.totalPnl?.toLocaleString()}, ${s.trades} trades`).join('\n')}` : ''}

${hcTrades.length ? `Recent big trades:\n${hcTrades.map((h: any) => `"${h.market?.substring(0, 70)}": ${h.outcome} — $${h.usdcSize?.toLocaleString()} (${h.sizeMultiplier?.toFixed(1)}x avg size)`).join('\n')}` : ''}

${winningPositions.length ? `Current winning positions:\n${winningPositions.map((p: any) => `"${p.title?.substring(0, 60)}": ${p.outcome} — entered $${p.avgPrice?.toFixed(2)}, now $${p.curPrice?.toFixed(2)} (+${p.percentPnl?.toFixed(0)}%)`).join('\n')}` : ''}

━━━ WRITING NOTES ━━━
- Use the full wallet address as the trader's identifier — it lets readers search it on Polymarket
- Pick the 2-3 most striking data points, ignore the rest
- If they have a weird or specific edge (insider signals, late entries, a niche category), build the story around that
- Don't mention @yieldrdotorg or the vault in the tweet — this is pure alpha signal content
- For telegram: end with a line about how Yieldr's agents track wallets like this 24/7 and link to yieldr.org/vaults`;
}
