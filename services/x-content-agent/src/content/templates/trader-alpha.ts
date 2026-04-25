/**
 * Trader Profile Alpha Template
 * Generates posts profiling top edge-ranked traders
 */

export function buildTraderAlphaPrompt(traderData: any): string {
  const t = traderData;
  const metrics = t.metrics || {};

  // Only show winning open positions
  const winningPositions = (t.topOpenPositions || [])
    .filter((p: any) => (p.percentPnl || p.cashPnl || 0) > 0 && p.curPrice < 0.99)
    .slice(0, 2);

  // Top HC trade
  const topTrade = (t.highConviction?.recentTrades || [])[0];

  // Top strength category
  const topStrength = (t.strengths || [])[0];

  return `Generate a Trader Profile Alpha post.

TRADER DATA:
- Specialty: ${t.specialty || 'Multi-category'}
- Win Rate: ${metrics.winRate?.toFixed(1)}% vs expected ${(t.edge?.expectedWinRate * 100)?.toFixed(1)}% (this gap IS the edge)
- Profit Factor: ${metrics.profitFactor?.toFixed(2)}x
- 30-day PnL: $${metrics.pnl30d?.toLocaleString() || metrics.netPnl?.toLocaleString()}
- 30-day ROCE: ${metrics.roce30d?.toFixed(0)}%
- Sample size: ${metrics.sampleSize} closed trades (statistical confidence: ${t.confidence})
- Strategy: ${t.strategyLabel || 'Unknown'}
- Insider signal: ${t.insider || 'none'}

${topStrength ? `TOP CATEGORY EDGE:
- ${topStrength.category}: ${topStrength.winRate?.toFixed(1)}% win rate across ${topStrength.trades} trades, $${topStrength.totalPnl?.toLocaleString()} PnL` : ''}

${topTrade ? `MOST RECENT HIGH CONVICTION TRADE:
- Market: "${topTrade.market?.substring(0, 60)}"
- Position: ${topTrade.outcome}
- Size: $${topTrade.usdcSize?.toLocaleString()} (${topTrade.sizeMultiplier?.toFixed(0)}x their typical trade)
- Price: $${topTrade.price?.toFixed(2)}` : ''}

${winningPositions.length > 0 ? `WINNING OPEN POSITIONS:
${winningPositions.map((p: any) => `- "${p.title?.substring(0, 50)}": ${p.outcome} @ $${p.avgPrice?.toFixed(2)} → $${p.curPrice?.toFixed(2)} (currently +${p.percentPnl?.toFixed(0)}%)`).join('\n')}` : ''}

FORMAT (strictly follow — 3 lines with line breaks):
Line 1 (hook): Single number that stops the scroll. Best candidates: ROCE%, win rate vs expected gap, or the HC trade size. Example structure: "X% ROCE in 30 days."
Line 2 (signal): What this trader is DOING right now — one specific position or recent trade. Be precise about the bet.
Line 3 (CTA): Sharp question specific to this trader's specialty. NOT "ask for more alpha" — ask something that makes traders think. E.g. "Are soccer markets the most mis-priced on Polymarket right now?"

CONTENT RULES:
- Pick max 2 numbers total across the whole tweet — discard the rest
- Only mention winning positions (positive PnL, curPrice < 0.99)
- Never use the phrase "turn X into reality" — say the actual win rate gap instead
- For positions, phrase them clearly: "betting [outcome] won't happen" not "No for X win"`;
}
