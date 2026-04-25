/**
 * Markets Alpha Template
 * Generates posts connecting trending topics to Polymarket markets + top trader positions
 */

export function buildMarketsAlphaPrompt(data: {
  markets: any[];
  traderPositions?: any[];
  trendKeyword?: string;
}): string {
  const { markets, traderPositions, trendKeyword } = data;

  const topMarket = markets[0];
  const otherMarkets = markets.slice(1, 3);

  const marketLine = topMarket
    ? `- "${topMarket.question?.substring(0, 70)}"
  Volume: $${topMarket.volume?.toLocaleString()} | Current odds: ${topMarket.outcomePrices} | 24h move: ${topMarket.oneDayPriceChange ? (topMarket.oneDayPriceChange > 0 ? '+' : '') + (topMarket.oneDayPriceChange * 100).toFixed(1) + '%' : 'flat'}`
    : 'No markets found';

  const otherLines = otherMarkets.map((m: any) =>
    `- "${m.question?.substring(0, 60)}" | $${m.volume?.toLocaleString()} vol`
  ).join('\n');

  // Only winning trader positions
  const winningPositions = (traderPositions || [])
    .filter((p: any) => (p.percentPnl || 0) > 0)
    .slice(0, 2)
    .map((p: any) =>
      `- ${p.traderEdge?.winRate?.toFixed(0)}% WR trader: ${p.outcome} @ $${p.avgPrice?.toFixed(2)}, up ${p.percentPnl?.toFixed(0)}%`
    ).join('\n');

  return `Generate a Markets Alpha post.

${trendKeyword ? `TRENDING NOW: "${trendKeyword}"` : ''}

TOP MATCHING POLYMARKET:
${marketLine}

${otherMarkets.length > 0 ? `RELATED MARKETS:\n${otherLines}` : ''}

${winningPositions ? `SMART MONEY POSITIONING (edge-ranked traders currently winning in this market):
${winningPositions}` : ''}

IMPORTANT RULES:
- Lead with the most interesting market signal — an odds move, volume spike, or smart money position
- Connect the real-world event to the market odds in one crisp sentence
- If smart money is positioned, mention it as a signal — not a recommendation
- End with a question that makes people think about the outcome`;
}
