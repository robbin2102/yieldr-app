/**
 * Trader Profile Alpha Template
 * Generates posts profiling top edge-ranked traders
 */

export function buildTraderAlphaPrompt(traderData: any): string {
  const t = traderData;
  const metrics = t.metrics || {};
  const positions = (t.topOpenPositions || []).slice(0, 3);
  const hcTrades = (t.highConviction?.recentTrades || []).slice(0, 2);
  const strengths = (t.strengths || []).slice(0, 2);

  return `Generate a Trader Profile Alpha post for X.

TRADER DATA:
- Wallet: ${t.wallet?.substring(0, 8)}...${t.wallet?.substring(t.wallet.length - 4)}
- Label: ${t.label || 'Anonymous Edge Trader'}
- Specialty: ${t.specialty || 'Multi-category'}
- Win Rate: ${metrics.winRate?.toFixed(1)}%
- Profit Factor: ${metrics.profitFactor?.toFixed(2)}
- Net PnL: $${metrics.netPnl?.toLocaleString()}
- Avg Trade Size: $${metrics.avgTradeSize?.toLocaleString()}
- Total Trades: ${metrics.closedPositionsCount}

TOP STRENGTHS:
${strengths.map((s: any) => `- ${s.category}: ${s.winRate?.toFixed(1)}% win rate, $${s.totalPnl?.toLocaleString()} PnL`).join('\n') || 'N/A'}

CURRENT OPEN POSITIONS:
${positions.map((p: any) => `- ${p.title?.substring(0, 50)}: ${p.outcome} @ $${p.avgPrice?.toFixed(2)} → $${p.curPrice?.toFixed(2)} (${p.percentPnl > 0 ? '+' : ''}${p.percentPnl?.toFixed(1)}%)`).join('\n') || 'No open positions'}

RECENT HIGH CONVICTION TRADES:
${hcTrades.map((h: any) => `- ${h.market?.substring(0, 50)}: ${h.outcome} for $${h.usdcSize?.toLocaleString()} (${h.sizeMultiplier?.toFixed(0)}x avg size)`).join('\n') || 'None recent'}

Create a compelling post that:
1. Highlights this trader's edge and specialty
2. Shares specific numbers (win rate, PnL, profit factor)
3. Mentions a current position or recent high conviction trade
4. Ends with a question driving engagement
5. Ends with varied CTA inviting users to ask @yieldrdotorg for more trader alpha
6. Max 280 characters`;
}
