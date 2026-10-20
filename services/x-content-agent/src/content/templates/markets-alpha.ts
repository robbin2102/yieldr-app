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

  const marketLines = markets.slice(0, 3).map((m: any) =>
    `- "${m.question?.substring(0, 60)}" | Volume: $${m.volume?.toLocaleString()} | Odds: ${m.outcomePrices || 'N/A'} | 24h change: ${m.oneDayPriceChange ? (m.oneDayPriceChange > 0 ? '+' : '') + m.oneDayPriceChange.toFixed(1) + '%' : 'N/A'}`
  ).join('\n');

  const positionLines = (traderPositions || []).slice(0, 3).map((p: any) =>
    `- Trader ${p.wallet?.substring(0, 8)}... (${p.traderEdge?.winRate?.toFixed(0)}% WR, ${p.traderEdge?.profitFactor?.toFixed(1)} PF): ${p.outcome} @ $${p.avgPrice?.toFixed(2)}, holding $${p.currentValue?.toLocaleString()}`
  ).join('\n');

  return `Generate a Markets Alpha post for X.

${trendKeyword ? `TRENDING TOPIC: "${trendKeyword}"` : ''}

MATCHING POLYMARKET MARKETS:
${marketLines || 'No matching markets found'}

TOP EDGE TRADERS POSITIONED IN THESE MARKETS:
${positionLines || 'No edge trader positions found'}

Create a compelling post that:
1. Connects the trending topic or market to prediction market alpha
2. Shares specific odds and volumes
3. If top traders are positioned, highlight their conviction
4. Frames it as actionable intelligence
5. Ends with a question or poll driving engagement
6. Ends with varied CTA inviting users to ask @yieldrdotorg for more market alpha
7. Max 280 characters`;
}
