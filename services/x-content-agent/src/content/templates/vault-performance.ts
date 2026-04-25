/**
 * Vault Performance Template
 * Dumps all available vault + trader data to the LLM agent
 * Agent picks the most compelling metrics for the fund update narrative
 */

export function buildVaultPerformancePrompt(vault: any): string {
  const perf = vault.performance || {};
  const stats = vault.stats || {};
  const activity = vault.activity24h || {};
  const tp = vault.traderProfile || {};

  // Positions
  const winningPositions = (vault.openPositions || [])
    .filter((p: any) => (p.unrealizedPnl || 0) > 0)
    .slice(0, 5);

  const recentTrades = (vault.recentTrades || []).slice(0, 5);

  // Category breakdown — top 6 by PnL
  const catBreakdown = (tp.categoryBreakdown || [])
    .sort((a: any, b: any) => (b.total_pnl || 0) - (a.total_pnl || 0))
    .slice(0, 6);

  const positionLines = winningPositions.map((p: any) =>
    `- "${p.market?.substring(0, 60)}": ${p.outcome} @ $${p.avgPrice?.toFixed(2)} → $${p.curPrice?.toFixed(2)}, unrealized +$${p.unrealizedPnl?.toLocaleString()}${p.pnlPercent ? ` (+${p.pnlPercent.toFixed(0)}%)` : ''}`
  ).join('\n');

  const tradeLines = recentTrades.map((t: any) =>
    `- "${t.market?.substring(0, 60)}": ${t.side} ${t.outcome} @ $${t.price?.toFixed(2)}, size $${(t.size || 0).toLocaleString()}`
  ).join('\n');

  const daysWonRate = tp.tradingConsistency?.daysWonRate;
  const sortinoRatio = tp.tradingConsistency?.sortinoRatio;
  const avgDailyPnl = tp.tradingConsistency?.avgDailyPnl;

  return `Generate a Vault Performance post with AGENT ANALYSIS.

═══ VAULT IDENTITY ═══
- Name: ${vault.name}
- Specialty: ${vault.specialty || 'Multi-category'}
- Status: ${vault.status || 'Active'}
- Trader label: ${tp.label || 'N/A'}
${vault.description ? `- Edge thesis: ${vault.description.substring(0, 200)}` : ''}

═══ VAULT FINANCIALS (our deployed capital) ═══
- Initial capital: ${perf.vaultCapital != null ? '$' + perf.vaultCapital.toLocaleString() : 'N/A'}
- Current size: ${perf.vaultCurrentSize != null ? '$' + perf.vaultCurrentSize.toLocaleString() : 'N/A'}
- Vault ROI: ${perf.vaultROI != null ? (perf.vaultROI > 0 ? '+' : '') + perf.vaultROI.toFixed(1) + '%' : 'N/A'}
- All-time PnL (trader): ${tp.totalPnlAllTime != null ? '$' + tp.totalPnlAllTime.toLocaleString() : 'N/A'}
- Realized PnL: ${tp.totalRealizedPnl != null ? '$' + tp.totalRealizedPnl.toLocaleString() : 'N/A'}
- Unrealized PnL: ${tp.totalUnrealizedPnl != null ? '$' + tp.totalUnrealizedPnl.toLocaleString() : 'N/A'}

═══ TRACKED TRADER SIGNAL (the edge we mirror) ═══
- Win rate: ${stats.winRate ? stats.winRate.toFixed(1) + '%' : 'N/A'}
- Profit factor: ${stats.profitFactor ? stats.profitFactor.toFixed(2) + 'x' : 'N/A'}
- Wins/Losses: ${stats.winsClosed || '?'}W / ${stats.lossesClosed || '?'}L (${stats.totalTrades || '?'} total)
- 7d PnL: ${tp.pnl7d != null ? '$' + tp.pnl7d.toLocaleString() : 'N/A'} | ROCE: ${tp.roce7d != null ? tp.roce7d.toFixed(1) + '%' : 'N/A'}
- 15d PnL: ${tp.pnl15d != null ? '$' + tp.pnl15d.toLocaleString() : 'N/A'} | ROCE: ${tp.roce15d != null ? tp.roce15d.toFixed(1) + '%' : 'N/A'}
- 30d PnL: ${perf.trader30dPnl != null ? '$' + perf.trader30dPnl.toLocaleString() : 'N/A'} | ROCE: ${perf.trader30dROCE != null ? perf.trader30dROCE.toFixed(1) + '%' : 'N/A'}
- Open positions: ${stats.openPositionCount || 0} (${stats.winningPositionCount || 0} winning, ${stats.losingPositionCount || 0} losing)
- Unrealized total: $${(stats.totalUnrealizedPnl || 0).toLocaleString()}

═══ TRADER PROFILE DETAILS ═══
- Strategy: ${tp.strategyLabel || 'N/A'}
- Volume label: ${tp.volumeLabel || 'N/A'}
- Edge hypothesis: ${tp.edgeHypothesis || 'N/A'}
- Edge type: ${tp.edgeType || 'N/A'}
- Sustainability: ${tp.sustainability || 'N/A'}
- Avg trade: $${tp.avgTradeSize?.toFixed(0) || 'N/A'}
- HC trades: ${tp.asymmetricTradesCount || 0} trades, $${tp.asymmetricVolume?.toLocaleString() || '0'} volume (${tp.asymmetricVolumePercent?.toFixed(0) || '0'}% of total)

═══ RISK & CONSISTENCY ═══
- Current streak: ${tp.currentStreak || 0} ${tp.currentStreakType || 'N/A'}
- Max drawdown (all-time): ${tp.maxDrawdownPercent != null ? tp.maxDrawdownPercent.toFixed(1) + '%' : 'N/A'}${tp.maxDrawdown ? ` ($${tp.maxDrawdown.toLocaleString()})` : ''}
- 30d max drawdown: ${tp.maxDrawdown30dPct != null ? Math.abs(tp.maxDrawdown30dPct).toFixed(1) + '%' : 'N/A'}
- Days winning rate: ${daysWonRate != null ? daysWonRate.toFixed(1) + '%' : 'N/A'}
- Avg daily PnL: ${avgDailyPnl != null ? '$' + avgDailyPnl.toFixed(0) : 'N/A'}
- Sortino ratio: ${sortinoRatio != null ? sortinoRatio.toFixed(2) : 'N/A'}
- Capital trend: ${tp.capitalTrend || 'N/A'}
- Drawdown trend: ${tp.drawdownTrend || 'N/A'}
- Trades/day: ${tp.tradesPerDay?.toFixed(1) || 'N/A'}
- Buy ratio: ${tp.buyRatio != null ? tp.buyRatio.toFixed(0) + '%' : 'N/A'}
- Insider probability: ${tp.insiderProbability || 'N/A'} (score: ${tp.insiderScore || 'N/A'})
${tp.insiderSignals?.length > 0 ? `- Insider signals: ${tp.insiderSignals.join(', ')}` : ''}
- Last active: ${tp.lastActiveDaysAgo != null ? (tp.lastActiveDaysAgo < 0.1 ? 'today' : tp.lastActiveDaysAgo.toFixed(1) + ' days ago') : 'N/A'}
${tp.roceTrend ? `- ROCE trend: 7d=${tp.roceTrend.d7?.toFixed(0) || '?'}%, 15d=${tp.roceTrend.d15?.toFixed(0) || '?'}%, 30d=${tp.roceTrend.d30?.toFixed(0) || '?'}% (${tp.roceTrend.direction || ''})` : ''}

${catBreakdown.length > 0 ? `═══ CATEGORY BREAKDOWN ═══
${catBreakdown.map((c: any) => `- ${c.category}${c.sub_league ? `/${c.sub_league}` : ''}: WR ${c.win_rate?.toFixed(1)}%, PnL $${c.total_pnl?.toLocaleString()}, ${c.closed_positions || '?'} trades${c.roce ? `, ROCE ${c.roce.toFixed(0)}%` : ''}`).join('\n')}` : ''}

${tp.strengthMarkets?.length > 0 ? `═══ BEST MARKETS ═══
${tp.strengthMarkets.slice(0, 3).map((m: any) => `- "${m.market || m.title}": PnL $${m.pnl?.toLocaleString()}`).join('\n')}` : ''}

═══ 24H ACTIVITY ═══
- Trades executed: ${activity.tradesExecuted || 0}
${activity.trades?.length > 0 ? activity.trades.map((t: any) => `- ${t.side} "${t.market?.substring(0, 50)}" ${t.outcome} @ $${t.price?.toFixed(2)}`).join('\n') : '- No new trades in last 24h'}

${tradeLines ? `═══ RECENT TRADES ═══\n${tradeLines}` : ''}

${positionLines ? `═══ WINNING OPEN POSITIONS ═══\n${positionLines}` : ''}

═══ NARRATIVE INSTRUCTIONS ═══
You have ALL the data. Write a professional fund update — ONE post for X + TG.

Pick the 3-5 most compelling metrics and tell the vault's story:
1. How is the vault performing? (ROI, PnL, multi-timeframe ROCE)
2. What edge is the tracked trader showing? (label, category strengths, insider signals, consistency)
3. What's happening now? (open positions, recent trades, streak, 24h activity)
4. Risk context? (drawdown, drawdown trend, sortino)

Use **bold** for key numbers. Bullets for data. No character limit.
End with "Track live → yieldr.org" CTA.

RULES:
- Only feature winning positions in detail
- If no positions/trades: "vault in scanning mode — agents hunting the next edge"
- If vault is down (negative 30d): be honest, show risk context, no spin
- Buy ratio: field is already %, do not multiply again
- Professional fund update tone — never shill
- Use emojis for structure (📊 💰 🤖 📈 🎯 etc.)`;
}
