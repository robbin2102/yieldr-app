import { ContentStyle, STYLE_DESCRIPTIONS } from '../styles';

function stripFinancials(doc: any): any {
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
      if (EXCLUDED.includes(key)) delete obj[key];
      else if (typeof obj[key] === 'object') scrub(obj[key]);
    }
  }
  scrub(copy);
  return copy;
}

export function buildVaultPerformancePrompt(vault: any, style?: ContentStyle): string {
  const s = style || 'narrative';
  const perf = vault.performance || {};
  const posSummary = vault.positionSummary || {};

  const winningPositions = (vault.openPositions || [])
    .filter((p: any) => (p.unrealizedPnl || 0) > 0)
    .slice(0, 4);

  const recentTrades = (vault.recentTrades || []).slice(0, 5);

  const cleanVaultDoc = stripFinancials(vault.vaultDoc);
  const cleanPositionsDoc = stripFinancials(vault.positionsDoc);

  return `Write a vault performance post for ${vault.name}.

${STYLE_DESCRIPTIONS[s]}

━━━ VAULT SNAPSHOT ━━━
Vault: ${vault.name} (${vault.specialty || 'Multi-category'})
ROI since launch: ${perf.vaultROI != null ? (perf.vaultROI > 0 ? '+' : '') + perf.vaultROI.toFixed(1) + '%' : 'N/A'}
30d ROCE: ${perf.periodROCE != null ? perf.periodROCE.toFixed(1) + '%' : 'N/A'}
Open positions: ${posSummary.openCount || 0} (${posSummary.winningCount || 0} winning, ${posSummary.losingCount || 0} losing)

${winningPositions.length ? `Winning positions:\n${winningPositions.map((p: any) =>
  `"${p.market?.substring(0, 65)}": ${p.outcome} — in at $${p.avgPrice?.toFixed(2)}, now $${p.curPrice?.toFixed(2)} (+${p.pnlPercent?.toFixed(0) || '?'}%)`
).join('\n')}` : ''}

${recentTrades.length ? `Recent closed trades:\n${recentTrades.map((t: any) =>
  `"${t.market?.substring(0, 55)}": ${t.outcome} — ${(t.realizedPnl || 0) > 0 ? 'WIN' : 'LOSS'} (${t.status})`
).join('\n')}` : ''}

━━━ FULL DATA (pick what's compelling) ━━━
${JSON.stringify(cleanVaultDoc, null, 2)}

${cleanPositionsDoc ? JSON.stringify(cleanPositionsDoc, null, 2) : ''}

━━━ WRITING NOTES ━━━
- NEVER mention dollar amounts for vault size or capital deployed — only ROI %, ROCE %, win rates
- Individual trade P&L in dollars is fine ("this position is up +$450")
- If the vault is down: say it plainly — "rough month" beats spin. Readers respect honesty.
- Lead with the most human-readable insight — not the first number in the data
- For tweet: no links, no "yieldr.org", end with a question or observation
- For telegram: end with "Track live → yieldr.org/vaults"`;
}
