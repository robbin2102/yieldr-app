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

FORMAT (3 lines with line breaks between them):
Line 1 (hook): The single most interesting market signal — an odds move ("dropped from 45¢ to 13¢"), a volume spike, or smart money size. Make it concrete.
Line 2 (context): Connect the real-world event to the market. If smart money is positioned, one sentence on what they're backing and at what price.
Line 3 (CTA): A sharp question about the outcome — make the reader take a side. E.g. "At 13¢, is this priced right or is the market sleeping?"

CONTENT RULES:
- Don't show raw JSON outcomePrices — interpret them as actual odds in plain language
- Lead with price MOVEMENT if available (24h change) — movement is more compelling than a static price
- If no smart money positions, lead purely on the market signal`;
}
