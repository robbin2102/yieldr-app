/**
 * Trader Profile Alpha Template
 * Dumps all available trader data to the LLM agent for narrative generation
 * Agent picks the most compelling metrics for the story
 */

export function buildTraderAlphaPrompt(traderData: any, opts?: { rotation?: number; totalTraders?: number }): string {
  const t = traderData;
  const metrics = t.metrics || {};
  const edge = t.edge || {};
  const rotation = opts?.rotation;
  const totalTraders = opts?.totalTraders || 4;

  // Only show winning open positions
  const winningPositions = (t.topOpenPositions || [])
    .filter((p: any) => (p.percentPnl || p.cashPnl || 0) > 0 && p.curPrice < 0.99)
    .slice(0, 5);

  const losingPositions = (t.topOpenPositions || [])
    .filter((p: any) => (p.percentPnl || p.cashPnl || 0) < 0)
    .slice(0, 3);

  // HC trades
  const hcTrades = (t.highConviction?.recentTrades || []).slice(0, 3);

  // Strengths & weaknesses
  const strengths = (t.strengths || []).slice(0, 5);
  const weaknesses = (t.weaknesses || []).slice(0, 3);

  // Edge gap
  const winRateGap = metrics.winRate && edge.expectedWinRate
    ? (metrics.winRate - edge.expectedWinRate * 100).toFixed(1)
    : null;

  // Category breakdown
  const catBreakdown = (t.categoryBreakdown || []).slice(0, 6);

  return `Generate a Trader Profile Alpha post — tell a STORY about this trader's edge.
${rotation ? `\n🔄 ROTATION: Trader ${rotation}/${totalTraders} in today's series. Mention naturally.` : ''}

═══ CORE IDENTITY ═══
- Rank: #${t.rank}
- Specialty: ${t.specialty || 'Multi-category'}
- Strategy: ${t.strategyLabel || 'Unknown'}
- Volume label: ${t.volumeLabel || 'N/A'}
- Account age: ${t.accountAgeDays ? t.accountAgeDays + ' days' : 'N/A'}
- Last active: ${t.lastActiveDaysAgo != null ? t.lastActiveDaysAgo + ' days ago' : 'N/A'}
${t.xUsername ? `- X handle: @${t.xUsername}` : ''}

═══ EDGE METRICS ═══
- Win Rate: ${metrics.winRate?.toFixed(1)}%${edge.expectedWinRate ? ` vs expected ${(edge.expectedWinRate * 100).toFixed(1)}%` : ''}${winRateGap ? ` → ${winRateGap}pp EDGE GAP` : ''}
- P-value: ${edge.pValue != null ? edge.pValue.toFixed(6) : 'N/A'}
- Edge magnitude: ${edge.magnitude != null ? (edge.magnitude * 100).toFixed(1) + 'pp' : 'N/A'}
- Edge score: ${edge.score?.toFixed(2) || 'N/A'}
- Confidence: ${t.confidence || 'confirmed'}
- Edge type: ${t.edgeType || 'N/A'}
- Edge hypothesis: ${t.edgeHypothesis || 'N/A'}
- Sustainability: ${t.sustainability || 'N/A'}

═══ PERFORMANCE ═══
- Profit Factor: ${metrics.profitFactor?.toFixed(2)}x
- 30d PnL: $${metrics.pnl30d?.toLocaleString() || 'N/A'}
- 30d ROCE: ${metrics.roce30d?.toFixed(0)}%
- All-time PnL: $${metrics.totalPnlAllTime?.toLocaleString() || 'N/A'}
- Unrealized PnL: $${metrics.totalUnrealizedPnl?.toLocaleString() || 'N/A'}
- Sample size: ${metrics.sampleSize} closed trades
- Trades/day: ${metrics.tradesPerDay?.toFixed(1) || 'N/A'}
- Buy ratio: ${metrics.buyRatio != null ? (metrics.buyRatio * 100).toFixed(0) + '%' : 'N/A'}

═══ RISK & CONSISTENCY ═══
- Days won rate: ${metrics.daysWonRate != null ? metrics.daysWonRate.toFixed(1) + '%' : 'N/A'}
- Sortino ratio: ${metrics.sortino?.toFixed(2) || 'N/A'}
- Max drawdown: ${t.maxDrawdownPercent != null ? t.maxDrawdownPercent.toFixed(1) + '%' : 'N/A'}${t.maxDrawdown ? ` ($${t.maxDrawdown.toLocaleString()})` : ''}
- 30d max drawdown: ${t.maxDrawdown30dPct != null ? t.maxDrawdown30dPct.toFixed(1) + '%' : 'N/A'}
- Capital trend: ${t.capitalTrend || 'N/A'}
- Drawdown trend: ${t.drawdownTrend || 'N/A'}
- Current streak: ${t.currentStreak || 0} ${t.currentStreakType || 'N/A'}
${t.roceTrend ? `- ROCE trend: 7d=${t.roceTrend.d7?.toFixed(0) || '?'}%, 15d=${t.roceTrend.d15?.toFixed(0) || '?'}%, 30d=${t.roceTrend.d30?.toFixed(0) || '?'}%` : ''}

═══ TRADE SIZING ═══
- Avg trade: $${metrics.avgTradeSize?.toFixed(0) || 'N/A'}
- Median trade: $${metrics.medianTradeSize?.toFixed(0) || 'N/A'}
- Max trade: $${metrics.maxTradeSize?.toLocaleString() || 'N/A'}
- HC trades: ${t.highConviction?.count || 0} trades, $${t.highConviction?.volume?.toLocaleString() || '0'} volume (${t.highConviction?.volumePercent?.toFixed(0) || '0'}% of total)

═══ INSIDER SIGNAL ═══
- Insider: ${t.insider || 'none'}
- Insider score: ${t.insiderScore || 'N/A'}

${catBreakdown.length > 0 ? `═══ CATEGORY BREAKDOWN ═══
${catBreakdown.map((c: any) => `- ${c.category}: WR ${c.win_rate?.toFixed(1)}%, PnL $${c.total_pnl?.toLocaleString()}, ${c.closed_positions || '?'} trades, capital $${(c.capital_deployed || c.capitalDeployed || 0).toLocaleString()}${c.roce ? `, ROCE ${c.roce.toFixed(0)}%` : ''}`).join('\n')}` : ''}

${strengths.length > 0 ? `═══ STRENGTHS ═══
${strengths.map((s: any) => `- ${s.category}: ${s.winRate?.toFixed(1)}% WR across ${s.trades} trades → $${s.totalPnl?.toLocaleString()} PnL`).join('\n')}` : ''}

${weaknesses.length > 0 ? `═══ WEAKNESSES ═══
${weaknesses.map((w: any) => `- ${w.category}: ${w.winRate?.toFixed(1)}% WR, $${w.totalPnl?.toLocaleString()} PnL`).join('\n')}` : ''}

${t.strengthMarkets?.length > 0 ? `═══ BEST MARKETS ═══
${t.strengthMarkets.slice(0, 3).map((m: any) => `- "${m.market || m.title}": ${m.outcome}, PnL $${m.pnl?.toLocaleString()}`).join('\n')}` : ''}

${hcTrades.length > 0 ? `═══ RECENT HIGH CONVICTION TRADES ═══
${hcTrades.map((h: any) => `- "${h.market?.substring(0, 80)}": ${h.outcome} for $${h.usdcSize?.toLocaleString()} (${h.sizeMultiplier?.toFixed(1)}x avg) @ $${h.price?.toFixed(2)}`).join('\n')}` : ''}

${winningPositions.length > 0 ? `═══ WINNING OPEN POSITIONS ═══
${winningPositions.map((p: any) => `- "${p.title?.substring(0, 60)}": ${p.outcome} @ $${p.avgPrice?.toFixed(2)} → $${p.curPrice?.toFixed(2)} (+${p.percentPnl?.toFixed(0)}%)`).join('\n')}` : ''}

═══ NARRATIVE INSTRUCTIONS ═══
You have ALL the data. Pick the 3-5 most compelling metrics and tell a STORY:
- What's the single most striking thing about this trader? (lead with it)
- Where do they find alpha? (categories, strategy, timing)
- What are they doing NOW? (positions, recent HC trades, streak)
- What can we learn? (edge hypothesis, sustainability)

Write ONE post for X + TG. Use **bold** for key numbers. Bullets for data. Emojis for energy.
No character limit.

CTA: End with "Drop a wallet address below 👇" or similar engagement driver.

RULES:
- Only feature winning positions
- Phrase bets clearly in plain English
- Use emojis naturally (📊 🎯 🔥 💰 ⚡ 🏀 ⚽ 🌍 etc.)`;
}
