/**
 * Trader Profile Alpha Template
 * Generates narrative-style posts profiling top edge-ranked traders
 * Supports daily rotation (1/4, 2/4, 3/4, 4/4)
 */

export function buildTraderAlphaPrompt(traderData: any, opts?: { rotation?: number; totalTraders?: number }): string {
  const t = traderData;
  const metrics = t.metrics || {};
  const rotation = opts?.rotation;
  const totalTraders = opts?.totalTraders || 4;

  // Only show winning open positions
  const winningPositions = (t.topOpenPositions || [])
    .filter((p: any) => (p.percentPnl || p.cashPnl || 0) > 0 && p.curPrice < 0.99)
    .slice(0, 3);

  // Top HC trade
  const topTrade = (t.highConviction?.recentTrades || [])[0];

  // Top strength categories
  const topStrengths = (t.strengths || []).slice(0, 3);

  // Edge gap (actual win rate vs expected)
  const winRateGap = metrics.winRate && t.edge?.expectedWinRate
    ? (metrics.winRate - t.edge.expectedWinRate * 100).toFixed(1)
    : null;

  return `Generate a Trader Profile Alpha post — tell a STORY about this trader's edge.
${rotation ? `\n🔄 ROTATION: This is trader ${rotation}/${totalTraders} in today's series. Mention this naturally, e.g. "Today's edge profile (${rotation}/${totalTraders})" or "Profile ${rotation} of ${totalTraders}"` : ''}

TRADER DATA:
- Specialty: ${t.specialty || 'Multi-category'}
- Win Rate: ${metrics.winRate?.toFixed(1)}%${t.edge?.expectedWinRate ? ` vs expected ${(t.edge.expectedWinRate * 100).toFixed(1)}%` : ''}${winRateGap ? ` (${winRateGap}pp edge gap — this IS the edge)` : ''}
- Profit Factor: ${metrics.profitFactor?.toFixed(2)}x
- 30-day PnL: $${metrics.pnl30d?.toLocaleString() || metrics.netPnl?.toLocaleString()}
- 30-day ROCE: ${metrics.roce30d?.toFixed(0)}%
- Sample size: ${metrics.sampleSize} closed trades
- Statistical confidence: ${t.confidence || 'confirmed'}
- P-value: ${t.edge?.pVal != null ? t.edge.pVal.toFixed(6) : 'N/A'}
- Strategy: ${t.strategyLabel || 'Unknown'}
- Insider signal: ${t.insider || 'none'}
- Avg trade size: $${metrics.avgTradeSize?.toFixed(0) || 'N/A'}

${topStrengths.length > 0 ? `CATEGORY STRENGTHS:
${topStrengths.map((s: any) => `- ${s.category}: ${s.winRate?.toFixed(1)}% WR across ${s.trades} trades → $${s.totalPnl?.toLocaleString()} PnL`).join('\n')}` : ''}

${topTrade ? `MOST RECENT HIGH CONVICTION TRADE:
- Market: "${topTrade.market?.substring(0, 80)}"
- Position: ${topTrade.outcome}
- Size: $${topTrade.usdcSize?.toLocaleString()} (${topTrade.sizeMultiplier?.toFixed(0)}x their typical trade)
- Entry price: $${topTrade.price?.toFixed(2)}` : ''}

${winningPositions.length > 0 ? `CURRENTLY WINNING POSITIONS:
${winningPositions.map((p: any) => `- "${p.title?.substring(0, 60)}": ${p.outcome} @ $${p.avgPrice?.toFixed(2)} → now $${p.curPrice?.toFixed(2)} (+${p.percentPnl?.toFixed(0)}%)`).join('\n')}` : ''}

NARRATIVE INSTRUCTIONS:
Write ONE compelling post — investigative, story-driven, data-rich. This goes on both X and TG.
- Hook: lead with the single most striking metric
- Story: what makes this trader unusual, where they find alpha, what they're doing now
- Use **bold** for 2-4 key numbers (win rate, PnL, edge gap, conviction size)
- Bullet points for category strengths and positions
- Short punchy sentences — tell a story, not a data dump
- No character limit

CTA (critical — always include):
End with a variation of: "Want to know the edge of any Polymarket trader? Drop a wallet address in the comments 👇"

CONTENT RULES:
- Only mention winning positions (positive PnL, curPrice < 0.99)
- Never use "turn X into reality"
- Phrase positions clearly: "betting this won't happen" not "No for X win"
- Use emojis naturally (📊 🎯 🔥 💰 ⚡ 🏀 ⚽ 🌍 etc.)`;
}
