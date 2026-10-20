/**
 * Vault Performance Template
 * Generates posts highlighting vault metrics and recent trades
 */

export function buildVaultPerformancePrompt(vault: any): string {
  const perf = vault.performance || {};
  const stats = vault.stats || {};
  const trades = (vault.recentTrades || []).slice(0, 3);
  const positions = (vault.openPositions || []).slice(0, 3);

  const tradeLines = trades.map((t: any) =>
    `- ${t.market?.substring(0, 40)}: ${t.side} ${t.outcome || ''} @ $${t.price?.toFixed(2)}, PnL: ${t.pnl ? '$' + t.pnl.toLocaleString() : 'open'}${t.reasoning ? ' | Reason: ' + t.reasoning.substring(0, 60) : ''}`
  ).join('\n');

  const positionLines = positions.map((p: any) =>
    `- ${p.market?.substring(0, 40)}: ${p.outcome} (unrealized: $${p.unrealizedPnl?.toLocaleString()})`
  ).join('\n');

  return `Generate a Vault Performance post for X.

VAULT: ${vault.name}
${vault.description || ''}

PERFORMANCE (${perf.period || '30d'}):
- ROI: ${perf.roi ? (perf.roi > 0 ? '+' : '') + perf.roi.toFixed(1) + '%' : 'N/A'}
- Total PnL: ${perf.totalPnl ? '$' + perf.totalPnl.toLocaleString() : 'N/A'}
- NAV: ${perf.latestNav ? '$' + perf.latestNav.toLocaleString() : 'N/A'}

STATS:
- Total Trades: ${stats.totalTrades || 'N/A'}
- Win Rate: ${stats.winRate ? stats.winRate.toFixed(1) + '%' : 'N/A'}
- Subscribers: ${stats.subscribers || 'N/A'}

RECENT TRADES:
${tradeLines || 'No recent trades'}

OPEN POSITIONS:
${positionLines || 'No open positions'}

Create a compelling vault performance post that:
1. Highlights the vault's ROI and key metrics
2. Mentions a specific recent trade with the agent's reasoning
3. Shows transparency (real numbers, real trades)
4. Ends with a question driving engagement
5. Ends with varied CTA inviting users to ask @yieldrdotorg about this vault's performance
6. Max 280 characters`;
}
