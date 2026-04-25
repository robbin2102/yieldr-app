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

  const recentTrades = (vault.recentTrades || []).slice(0, 5);

  const positionLines = winningPositions.map((p: any) =>
    `- "${p.market?.substring(0, 60)}": ${p.outcome} @ $${p.avgPrice?.toFixed(2)} → $${p.curPrice?.toFixed(2)}, unrealized +$${p.unrealizedPnl?.toLocaleString()}${p.pnlPercent ? ` (+${p.pnlPercent.toFixed(0)}%)` : ''}`
  ).join('\n');

  const tradeLines = recentTrades.map((t: any) =>
    `- "${t.market?.substring(0, 60)}": ${t.side} ${t.outcome} @ $${t.price?.toFixed(2)}, size $${(t.size || 0).toLocaleString()}`
  ).join('\n');

  return `Generate a Vault Performance post with AGENT ANALYSIS.

VAULT: ${vault.name}
${vault.description ? vault.description.substring(0, 150) : ''}
Specialty: ${vault.specialty || 'Multi-category'}
Status: ${vault.status || 'Active'}

PERFORMANCE (${perf.period || '30d'}):
- ROI: ${perf.roi != null ? (perf.roi > 0 ? '+' : '') + perf.roi.toFixed(1) + '%' : 'N/A'}
- Total PnL: ${perf.totalPnl != null ? '$' + perf.totalPnl.toLocaleString() : 'N/A'}
- Unrealized PnL: ${perf.unrealizedPnl != null ? '$' + perf.unrealizedPnl.toLocaleString() : 'N/A'}
- Capital deployed: ${perf.capitalDeployed ? '$' + perf.capitalDeployed.toLocaleString() : 'N/A'}
- Vault size: ${perf.vaultSize ? '$' + perf.vaultSize.toLocaleString() : 'N/A'}

STATS:
- Win rate: ${stats.winRate ? stats.winRate.toFixed(1) + '%' : 'N/A'}
- Profit factor: ${stats.profitFactor ? stats.profitFactor.toFixed(2) + 'x' : 'N/A'}
- Wins/Losses: ${stats.winsClosed || '?'}W / ${stats.lossesClosed || '?'}L
- Open positions: ${stats.openPositionCount || 0} (${stats.winningPositionCount || 0} winning, ${stats.losingPositionCount || 0} losing)
- Unrealized PnL: $${(stats.totalUnrealizedPnl || 0).toLocaleString()}

24H ACTIVITY:
- Trades executed: ${activity.tradesExecuted || 0}
${activity.trades?.length > 0 ? activity.trades.map((t: any) => `- ${t.side} "${t.market?.substring(0, 50)}" ${t.outcome} @ $${t.price?.toFixed(2)}`).join('\n') : '- No new trades in last 24h'}

${tradeLines ? `RECENT TRADES:\n${tradeLines}` : ''}

${positionLines ? `WINNING OPEN POSITIONS:\n${positionLines}` : ''}

AGENT ANALYSIS INSTRUCTIONS:
You are providing a vault performance update. Analyze the data:
1. How is the vault performing? (ROI, PnL, win rate)
2. What's the current positioning? (positions breakdown)
3. What happened recently? (24h activity, latest trades)
4. What's the edge? (specialty, strategy insight)

FORMAT:
X post: 3-5 lines, PLAIN TEXT only — no **bold** markdown (doesn't render on X). Use CAPS or emojis for emphasis. Lead with the most interesting metric or position. Use 📊 or 🤖 emoji.
TG post: Full performance breakdown with **bold** numbers, bullet points for positions. Professional fund update tone.

CTA: "Track live → yieldr.org" or invite questions about the vault strategy.

CONTENT RULES:
- Only show winning positions in detail
- If there are no positions or trades, acknowledge it honestly ("vault is in scanning mode")
- This should feel like a professional fund update, not a shill
- No character limit — give the full picture
- Use emojis for visual structure (📊 💰 🤖 📈 etc.)`;
}
