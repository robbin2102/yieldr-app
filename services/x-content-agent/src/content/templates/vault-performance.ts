/**
 * Vault Performance Template
 * Generates posts with agent analysis on vault metrics, positions, and recent activity
 */

export function buildVaultPerformancePrompt(vault: any): string {
  const perf = vault.performance || {};
  const stats = vault.stats || {};
  const activity = vault.activity24h || {};

  // Only winning positions
  const winningPositions = (vault.openPositions || [])
    .filter((p: any) => (p.unrealizedPnl || 0) > 0)
    .slice(0, 5);

  const losingPositions = (vault.openPositions || [])
    .filter((p: any) => (p.unrealizedPnl || 0) < 0);

  const recentTrades = (vault.recentTrades || []).slice(0, 5);

  const positionLines = winningPositions.map((p: any) =>
    `- "${p.market?.substring(0, 60)}": ${p.outcome} @ $${p.avgPrice?.toFixed(2)} → $${p.curPrice?.toFixed(2)}, unrealized +$${p.unrealizedPnl?.toLocaleString()}${p.pnlPercent ? ` (+${p.pnlPercent.toFixed(0)}%)` : ''}`
  ).join('\n');

  const tradeLines = recentTrades.map((t: any) =>
    `- "${t.market?.substring(0, 60)}": ${t.side} ${t.outcome} @ $${t.price?.toFixed(2)}, size $${(t.size || 0).toLocaleString()}${t.pnl ? ', PnL $' + t.pnl.toLocaleString() : ''}${t.reasoning ? '\n  Agent reasoning: "' + t.reasoning.substring(0, 120) + '"' : ''}`
  ).join('\n');

  return `Generate a Vault Performance post with AGENT ANALYSIS.

VAULT: ${vault.name}
${vault.description ? vault.description.substring(0, 150) : ''}
Status: ${vault.status || 'Active'}

PERFORMANCE (${perf.period || '30d'}):
- ROI: ${perf.roi != null ? (perf.roi > 0 ? '+' : '') + perf.roi.toFixed(1) + '%' : 'N/A'}
- PnL: ${perf.totalPnl != null ? '$' + perf.totalPnl.toLocaleString() : 'N/A'}
- Latest NAV: ${perf.latestNav != null ? '$' + perf.latestNav.toLocaleString() : 'N/A'}
- Total Trades: ${stats.totalTrades || 'N/A'}
- Win Rate: ${stats.winRate ? stats.winRate.toFixed(1) + '%' : 'N/A'}
- Open positions: ${stats.openPositionCount || vault.openPositions?.length || 0} (${stats.winningPositionCount || winningPositions.length} winning, ${losingPositions.length} losing)
- Total unrealized PnL: $${(stats.totalUnrealizedPnl || 0).toLocaleString()}

24H ACTIVITY:
- Trades executed: ${activity.tradesExecuted || 0}
${activity.trades?.length > 0 ? activity.trades.map((t: any) => `- ${t.side} "${t.market?.substring(0, 50)}" ${t.outcome} @ $${t.price?.toFixed(2)}`).join('\n') : '- No new trades in last 24h'}

${tradeLines ? `RECENT TRADES:\n${tradeLines}` : ''}

${positionLines ? `WINNING OPEN POSITIONS:\n${positionLines}` : ''}

AGENT ANALYSIS INSTRUCTIONS:
You are the vault's AI agent providing a performance update. Analyze the data and provide insight:
1. How is the vault performing vs last period? (ROI trend, PnL direction)
2. What's the current positioning? (number of positions, winning vs losing ratio)
3. What happened in the last 24h? (any new trades, position changes)
4. What's the biggest winning position and why it matters
5. If agent reasoning is available for any trade, quote it — this shows transparency

FORMAT:
X tweet: 3-5 lines with line breaks. Lead with the most interesting performance metric or position. Add context on what the agent is doing. Use 📊 or 🤖 emoji.
TG post: Full performance breakdown — metrics, positions, agent analysis paragraph, 24h activity. Use **bold** for numbers, bullet points for positions.

CTA: "Track live → yieldr.org" or invite questions about the vault's strategy.

CONTENT RULES:
- Only show winning positions in detail (mention losing count for transparency but don't detail)
- If agent reasoning is available, quote a SHORT phrase — transparency is Yieldr's biggest differentiator
- This should feel like a professional fund update, not a shill
- No character limit — give the full picture
- Use emojis for visual structure (📊 💰 🤖 📈 etc.)`;
}
