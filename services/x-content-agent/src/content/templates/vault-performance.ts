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

  // Format vault-specific vs trader-signal metrics clearly
  const vaultCapital = perf.vaultCapital;
  const vaultCurrentSize = perf.vaultCurrentSize;
  const vaultROI = perf.vaultROI;
  const trader30dPnl = perf.trader30dPnl;
  const trader30dROCE = perf.trader30dROCE;

  return `Generate a Vault Performance post with AGENT ANALYSIS.

VAULT: ${vault.name}
${vault.description ? vault.description.substring(0, 150) : ''}
Status: ${vault.status || 'Active'}

VAULT FINANCIALS (our deployed capital):
- Vault initial capital: ${vaultCapital != null ? '$' + vaultCapital.toLocaleString() : 'N/A'}
- Vault current size: ${vaultCurrentSize != null ? '$' + vaultCurrentSize.toLocaleString() : 'N/A'}
- Vault ROI: ${vaultROI != null ? (vaultROI > 0 ? '+' : '') + vaultROI.toFixed(1) + '%' : 'N/A'}

TRACKED TRADER SIGNAL QUALITY (the edge we mirror):
- Win rate: ${stats.winRate ? stats.winRate.toFixed(1) + '%' : 'N/A'}
- Profit factor: ${stats.profitFactor ? stats.profitFactor.toFixed(2) + 'x' : 'N/A'}
- Wins/Losses: ${stats.winsClosed || '?'}W / ${stats.lossesClosed || '?'}L
- 30d PnL (trader): ${trader30dPnl != null ? '$' + trader30dPnl.toLocaleString() : 'N/A'}
- 30d ROCE (trader): ${trader30dROCE != null ? trader30dROCE.toFixed(0) + '%' : 'N/A'}
- Open positions: ${stats.openPositionCount || 0} (${stats.winningPositionCount || 0} winning)

24H ACTIVITY:
- Trades executed: ${activity.tradesExecuted || 0}
${activity.trades?.length > 0 ? activity.trades.map((t: any) => `- ${t.side} "${t.market?.substring(0, 50)}" ${t.outcome} @ $${t.price?.toFixed(2)}`).join('\n') : '- No new trades in last 24h'}

${tradeLines ? `RECENT TRADES:\n${tradeLines}` : ''}

${positionLines ? `WINNING OPEN POSITIONS:\n${positionLines}` : ''}

AGENT ANALYSIS INSTRUCTIONS — write ONE post (X + TG):
1. Lead with the vault ROI or win rate (most compelling number)
2. Explain the tracked trader's edge (win rate, PF) and what positions the vault holds
3. What happened in the last 24h?
4. Professional fund update tone — honest, data-first, never shill

FORMAT:
- Use **bold** for 3-4 key numbers
- Bullet points for positions and activity
- No character limit — full picture
- End with "Track live → yieldr.org" CTA

CONTENT RULES:
- Only show winning positions in detail
- If no positions/trades: "vault is in scanning mode — agents hunting the next edge"
- If vault is down: be honest, show win rate/PF context, no spin
- Use emojis for visual structure (📊 💰 🤖 📈 etc.)`;
}
