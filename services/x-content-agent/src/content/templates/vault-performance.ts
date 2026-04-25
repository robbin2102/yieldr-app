/**
 * Vault Performance Template
 * Passes full vault doc + full positions doc to the LLM — no pre-filtering.
 * Agent picks the most compelling metrics for the fund update narrative.
 */

export function buildVaultPerformancePrompt(vault: any): string {
  const perf = vault.performance || {};
  const posSummary = vault.positionSummary || {};

  // Winning positions for highlight
  const winningPositions = (vault.openPositions || [])
    .filter((p: any) => (p.unrealizedPnl || 0) > 0)
    .slice(0, 5);

  const positionLines = winningPositions.map((p: any) =>
    `- "${p.market?.substring(0, 70)}": ${p.outcome} @ $${p.avgPrice?.toFixed(2)} → $${p.curPrice?.toFixed(2)}, unrealized +$${p.unrealizedPnl?.toLocaleString()}${p.pnlPercent ? ` (+${p.pnlPercent.toFixed(0)}%)` : ''}`
  ).join('\n');

  const recentTradeLines = (vault.recentTrades || []).slice(0, 5).map((t: any) =>
    `- "${t.market?.substring(0, 60)}": ${t.outcome}, size $${(t.size || 0).toLocaleString()}, PnL $${t.realizedPnl?.toFixed(0) || '?'} (${t.status})`
  ).join('\n');

  return `Generate a Vault Performance post with AGENT ANALYSIS.

═══ VAULT IDENTITY ═══
- Name: ${vault.name}
- Specialty: ${vault.specialty || 'Multi-category'}
- Status: ${vault.status || 'Active'}

═══ VAULT FINANCIALS ═══
- Initial capital deployed: ${perf.vaultCapital != null ? '$' + perf.vaultCapital.toLocaleString() : 'N/A'}
- Current vault size: ${perf.vaultCurrentSize != null ? '$' + perf.vaultCurrentSize.toLocaleString() : 'N/A'}
- Vault ROI: ${perf.vaultROI != null ? (perf.vaultROI > 0 ? '+' : '') + perf.vaultROI.toFixed(1) + '%' : 'N/A'}
- Period (${perf.period}) PnL: ${perf.periodPnl != null ? '$' + perf.periodPnl.toLocaleString() : 'N/A'}
- Period ROCE: ${perf.periodROCE != null ? perf.periodROCE.toFixed(1) + '%' : 'N/A'}

═══ POSITION SNAPSHOT ═══
- Open positions: ${posSummary.openCount || 0} (${posSummary.winningCount || 0} winning, ${posSummary.losingCount || 0} losing)
- Total unrealized PnL: $${(posSummary.totalUnrealizedPnl || 0).toLocaleString()}

${positionLines ? `═══ WINNING OPEN POSITIONS ═══\n${positionLines}` : ''}

${recentTradeLines ? `═══ RECENT CLOSED TRADES ═══\n${recentTradeLines}` : ''}

═══ FULL VAULT PROFILE (raw — pick what's compelling) ═══
${JSON.stringify(vault.vaultDoc, null, 2)}

${vault.positionsDoc ? `═══ FULL POSITIONS & TRADE DATA (raw — pick what's compelling) ═══
${JSON.stringify(vault.positionsDoc, null, 2)}` : ''}

═══ NARRATIVE INSTRUCTIONS ═══
You have the COMPLETE vault record + positions data above. Write a professional fund update — ONE post for X + TG.

Pick the 3-5 most compelling metrics and tell the vault's story:
1. How is the vault performing? (ROI, PnL, multi-timeframe ROCE from timeframePnL)
2. What edge is the tracked trader showing? (win_rate, profitFactor, category_breakdown, strategyLabel, insider signals)
3. What's happening now? (open positions, recent closed trades, currentStreak, HC trades)
4. Risk context? (maxDrawdown, drawdown_trend, tradingConsistency, dailyPnLByFrame)

Use **bold** for key numbers. Bullets for data. No character limit.
End with "Track live → yieldr.org" CTA.

RULES:
- Only feature winning positions in detail
- Include recent closed trades — both wins AND losses show transparency
- If no positions/trades: "vault in scanning mode — agents hunting the next edge"
- If vault is down (negative period PnL): be honest, show risk context, no spin
- Professional fund update tone — never shill
- Use emojis for structure (📊 💰 🤖 📈 🎯 etc.)`;
}
