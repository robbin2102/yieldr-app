/**
 * Vault Performance Template
 * Generates posts highlighting vault metrics and recent trades
 */

export function buildVaultPerformancePrompt(vault: any): string {
  const perf = vault.performance || {};
  const stats = vault.stats || {};
  const trades = (vault.recentTrades || []).filter((t: any) => t.market).slice(0, 2);
  const positions = (vault.openPositions || [])
    .filter((p: any) => (p.unrealizedPnl || 0) > 0)
    .slice(0, 2);

  const tradeLines = trades.map((t: any) =>
    `- "${t.market?.substring(0, 45)}": ${t.side} ${t.outcome} @ $${t.price?.toFixed(2)}${t.pnl ? ', PnL $' + t.pnl.toLocaleString() : ''}${t.reasoning ? '\n  Agent reasoning: "' + t.reasoning.substring(0, 80) + '"' : ''}`
  ).join('\n');

  const positionLines = positions.map((p: any) =>
    `- "${p.market?.substring(0, 45)}": ${p.outcome}, unrealized +$${p.unrealizedPnl?.toLocaleString()}`
  ).join('\n');

  return `Generate a Vault Performance post.

VAULT: ${vault.name}
${vault.description ? vault.description.substring(0, 100) : ''}

PERFORMANCE (${perf.period || '30d'}):
- ROI: ${perf.roi != null ? (perf.roi > 0 ? '+' : '') + perf.roi.toFixed(1) + '%' : 'N/A'}
- PnL: ${perf.totalPnl != null ? '$' + perf.totalPnl.toLocaleString() : 'N/A'}
- Trades: ${stats.totalTrades || 'N/A'} | Win Rate: ${stats.winRate ? stats.winRate.toFixed(1) + '%' : 'N/A'}

${tradeLines ? `RECENT AGENT TRADES:\n${tradeLines}` : ''}
${positionLines ? `WINNING OPEN POSITIONS:\n${positionLines}` : ''}

FORMAT (3 lines with line breaks between them):
Line 1 (hook): The ROI number or a single striking trade stat. "+X% in 30 days." or "$X PnL from Y trades."
Line 2 (signal): Either a specific recent trade with brief reasoning, OR one winning open position. Show the agent WORKING — not just stats.
Line 3 (CTA): A question about the strategy or vault — invite people to ask how it works. E.g. "How does an AI decide when to go 3x size on a geopolitics market?"

CONTENT RULES:
- If agent reasoning is available, quote a SHORT phrase in quotes — transparency is Yieldr's biggest differentiator
- Only show winning trades/positions
- "Track live" and "Early Access" are strong CTAs for TG posts when vault data is compelling`;
}
