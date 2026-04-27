/**
 * Vault Performance Template
 * Passes full vault doc + full positions doc to the LLM — no pre-filtering.
 * Agent picks the most compelling metrics for the fund update narrative.
 */

function stripSensitiveFields(doc: any): any {
  if (!doc) return doc;
  const copy = JSON.parse(JSON.stringify(doc));
  const EXCLUDED = [
    'avg_capital_deployed', 'avgCapitalDeployed',
    'vaultCapital', 'vault_capital',
    'vaultCurrentSize', 'vault_current_size',
    'periodPnl', 'period_pnl', 'pnl_30d',
  ];
  function scrub(obj: any) {
    if (!obj || typeof obj !== 'object') return;
    for (const key of Object.keys(obj)) {
      if (EXCLUDED.includes(key)) {
        delete obj[key];
      } else if (typeof obj[key] === 'object') {
        scrub(obj[key]);
      }
    }
  }
  scrub(copy);
  return copy;
}

export function buildVaultPerformancePrompt(vault: any): string {
  const perf = vault.performance || {};
  const posSummary = vault.positionSummary || {};

  const winningPositions = (vault.openPositions || [])
    .filter((p: any) => (p.unrealizedPnl || 0) > 0)
    .slice(0, 5);

  const positionLines = winningPositions.map((p: any) =>
    `- "${p.market?.substring(0, 70)}": ${p.outcome} @ $${p.avgPrice?.toFixed(2)} → $${p.curPrice?.toFixed(2)}, unrealized +$${p.unrealizedPnl?.toLocaleString()}${p.pnlPercent ? ` (+${p.pnlPercent.toFixed(0)}%)` : ''}`
  ).join('\n');

  const recentTradeLines = (vault.recentTrades || []).slice(0, 5).map((t: any) =>
    `- "${t.market?.substring(0, 60)}": ${t.outcome}, size $${(t.size || 0).toLocaleString()}, PnL $${t.realizedPnl?.toFixed(0) || '?'} (${t.status})`
  ).join('\n');

  const cleanVaultDoc = stripSensitiveFields(vault.vaultDoc);
  const cleanPositionsDoc = stripSensitiveFields(vault.positionsDoc);

  return `Generate a Vault Performance post with AGENT ANALYSIS.

═══ VAULT IDENTITY ═══
- Name: ${vault.name}
- Specialty: ${vault.specialty || 'Multi-category'}
- Status: ${vault.status || 'Active'}

═══ VAULT FINANCIALS ═══
- Vault ROI: ${perf.vaultROI != null ? (perf.vaultROI > 0 ? '+' : '') + perf.vaultROI.toFixed(1) + '%' : 'N/A'}
- Period ROCE: ${perf.periodROCE != null ? perf.periodROCE.toFixed(1) + '%' : 'N/A'}

═══ POSITION SNAPSHOT ═══
- Open positions: ${posSummary.openCount || 0} (${posSummary.winningCount || 0} winning, ${posSummary.losingCount || 0} losing)
- Total unrealized PnL: $${(posSummary.totalUnrealizedPnl || 0).toLocaleString()}

${positionLines ? `═══ WINNING OPEN POSITIONS ═══\n${positionLines}` : ''}

${recentTradeLines ? `═══ RECENT CLOSED TRADES ═══\n${recentTradeLines}` : ''}

═══ FULL VAULT PROFILE (raw — pick what's compelling) ═══
${JSON.stringify(cleanVaultDoc, null, 2)}

${cleanPositionsDoc ? `═══ FULL POSITIONS & TRADE DATA (raw — pick what's compelling) ═══
${JSON.stringify(cleanPositionsDoc, null, 2)}` : ''}

═══ NARRATIVE INSTRUCTIONS ═══
You have the COMPLETE vault record + positions data above. Write a professional fund update — ONE post for X + TG.

Pick the 3-5 most compelling metrics and tell the vault's story:
1. How is the vault performing? (ROI, multi-timeframe ROCE from timeframePnL)
2. What edge is the tracked trader showing? (win_rate, profitFactor, category_breakdown, strategyLabel, insider signals)
3. What's happening now? (open positions, recent closed trades, currentStreak, HC trades)
4. Risk context? (maxDrawdown, drawdown_trend, tradingConsistency, dailyPnLByFrame)

Use **bold** for key numbers. Bullets for data. No character limit.
End with "Track live → yieldr.org/vaults" CTA.

RULES:
- NEVER mention capital deployed, vault size (in dollars), or PnL in dollar amounts — only use ROI %, ROCE %, and win rates
- Only feature winning positions in detail
- Include recent closed trades — both wins AND losses show transparency
- If no positions/trades: "vault in scanning mode — agents hunting the next edge"
- If vault is down (negative period PnL): be honest, show risk context, no spin
- Professional fund update tone — never shill
- Use emojis for structure (📊 💰 🤖 📈 🎯 etc.)`;
}
