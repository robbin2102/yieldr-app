import { ContentStyle, STYLE_DESCRIPTIONS } from '../styles';

function stripFinancials(doc: any): any {
  if (!doc) return doc;
  const copy = JSON.parse(JSON.stringify(doc));
  const EXCLUDED = [
    'avg_capital_deployed', 'avgCapitalDeployed',
    'capitalDeployed', 'capital_deployed',
    'vaultCapital', 'vault_capital',
    'vaultCurrentSize', 'vault_current_size',
    'currentSize', 'current_size',
    'totalDeposited', 'total_deposited',
    'totalWithdrawn', 'total_withdrawn',
    'tvl', 'TVL', 'aum', 'AUM',
    'periodPnl', 'period_pnl', 'pnl_30d',
    'totalPnl', 'total_pnl',
    'netDeposits', 'net_deposits',
    'balance', 'vaultBalance', 'vault_balance',
  ];
  function scrub(obj: any) {
    if (!obj || typeof obj !== 'object') return;
    for (const key of Object.keys(obj)) {
      if (EXCLUDED.includes(key)) delete obj[key];
      else if (typeof obj[key] === 'string' && /capital|deployed|vault.?size|balance|deposited/i.test(key)) delete obj[key];
      else if (typeof obj[key] === 'object') scrub(obj[key]);
    }
  }
  scrub(copy);
  return copy;
}

function getVaultCategory(vaultName: string): string | null {
  const lower = (vaultName || '').toLowerCase();
  if (lower.includes('nba')) return 'nba';
  if (lower.includes('soccer')) return 'soccer';
  if (lower.includes('geo') || lower.includes('politic')) return 'politics';
  return null;
}

function isRelevantToVault(marketTitle: string, category: string | null): boolean {
  if (!category) return true;
  const t = (marketTitle || '').toLowerCase();
  switch (category) {
    case 'nba': return /nba|basketball|lakers|celtics|warriors|bucks|heat|thunder|nuggets|cavaliers|knicks|76ers|nets|bulls|hawks|pistons|rockets|spurs|suns|kings|jazz|grizzlies|pelicans|magic|pacers|raptors|hornets|blazers|timberwolves|clippers|mavericks|wizards|draft|playoff|finals|mvp|all.?star/i.test(t);
    case 'soccer': return /soccer|football|premier|la liga|serie a|bundesliga|ligue 1|champions league|europa|uefa|fifa|epl|fc |united|city|arsenal|chelsea|liverpool|barcelona|madrid|bayern|psg|juventus|inter|milan|dortmund|atletico/i.test(t);
    case 'politics': return /politic|president|elect|congress|senate|vote|governor|trump|biden|party|democrat|republican|nato|iran|russia|ukraine|china|war|treaty|sanction|tariff|cabinet|supreme court|fed chair|vance|walz/i.test(t);
    default: return true;
  }
}

export function buildVaultPerformancePrompt(vault: any, style?: ContentStyle): string {
  const s = style || 'narrative';
  const perf = vault.performance || {};
  const posSummary = vault.positionSummary || {};
  const vaultCat = getVaultCategory(vault.name);

  const winningPositions = (vault.openPositions || [])
    .filter((p: any) => (p.unrealizedPnl || 0) > 0 && isRelevantToVault(p.market, vaultCat))
    .slice(0, 3);

  const recentTrades = (vault.recentTrades || [])
    .filter((t: any) => isRelevantToVault(t.market, vaultCat))
    .slice(0, 3);

  const cleanVaultDoc = stripFinancials(vault.vaultDoc);
  const cleanPositionsDoc = stripFinancials(vault.positionsDoc);

  return `Write a SHORT vault performance post for ${vault.name}.

${STYLE_DESCRIPTIONS[s]}

━━━ VAULT SNAPSHOT ━━━
Vault: ${vault.name} (${vault.specialty || 'Multi-category'})
ROI (capital-weighted return metric): ${perf.vaultROI != null ? (perf.vaultROI > 0 ? '+' : '') + perf.vaultROI.toFixed(1) + '%' : 'N/A'}
30d ROCE (return on capital employed, last 30 days): ${perf.periodROCE != null ? perf.periodROCE.toFixed(1) + '%' : 'N/A'}
Open positions: ${posSummary.openCount || 0} (${posSummary.winningCount || 0} winning, ${posSummary.losingCount || 0} losing)

${winningPositions.length ? `Winning open positions (${vault.specialty || 'core'} only):\n${winningPositions.map((p: any) =>
  `"${p.market?.substring(0, 65)}": ${p.outcome} — in at $${p.avgPrice?.toFixed(2)}, now $${p.curPrice?.toFixed(2)} (+${p.pnlPercent?.toFixed(0) || '?'}%)`
).join('\n')}` : ''}

${recentTrades.length ? `Recent closed trades (${vault.specialty || 'core'} only):\n${recentTrades.map((t: any) =>
  `"${t.market?.substring(0, 55)}": ${t.outcome} — ${(t.realizedPnl || 0) > 0 ? 'WIN' : 'LOSS'} (${t.status})`
).join('\n')}` : ''}

━━━ FULL DATA (pick what's compelling) ━━━
${JSON.stringify(cleanVaultDoc, null, 2)}

${cleanPositionsDoc ? JSON.stringify(cleanPositionsDoc, null, 2) : ''}

━━━ CRITICAL: DATA RULES ━━━
- ONLY state what the data above explicitly shows. Do NOT infer, assume, or editorialize beyond it.
- ROI and ROCE are specific metrics — report them as numbers. Do NOT interpret a negative ROI as "the vault is losing money overall" or "in loss since inception." A vault can have negative ROI but positive total PnL (realized + unrealized).
- If a vault has winning open positions, say so — those are real unrealized gains regardless of what the ROI metric shows.
- Do NOT assume or mention launch dates, inception dates, or timeframes unless the data explicitly includes them.
- Report each metric exactly as labeled. "30d ROCE: -165%" means the 30-day ROCE is -165%, not that the vault lost 165% of its money.
- When a metric is negative but open positions are winning, present both facts without contradiction.

━━━ WRITING NOTES ━━━
- KEEP IT SHORT: tweet under 150 words, telegram under 200 words
- Pick 3-4 key stats max — don't list every trade or metric
- NEVER mention dollar amounts for vault size, capital deployed, or total PnL — only ROI %, ROCE %, win rates
- Individual trade P&L in dollars is fine ("this position is up +$450")
- ONLY mention trades relevant to the vault's specialty (${vault.specialty || 'Multi-category'}) — ignore off-category trades
- For tweet: no links, no "yieldr.org", end with a question or short observation
- For telegram: end with "yieldr.org/vaults"`;
}

export function buildCombinedVaultPrompt(vaults: any[], style?: ContentStyle): string {
  const s = style || 'narrative';

  const vaultBlocks = vaults.map((vault) => {
    const perf = vault.performance || {};
    const posSummary = vault.positionSummary || {};
    const vaultCat = getVaultCategory(vault.name);

    const winningPositions = (vault.openPositions || [])
      .filter((p: any) => (p.unrealizedPnl || 0) > 0 && isRelevantToVault(p.market, vaultCat))
      .slice(0, 2);

    const recentTrades = (vault.recentTrades || [])
      .filter((t: any) => isRelevantToVault(t.market, vaultCat))
      .slice(0, 2);

    const cleanVaultDoc = stripFinancials(vault.vaultDoc);

    return `
▸ ${vault.name} (${vault.specialty || 'Multi-category'})
  ROI (capital-weighted return metric): ${perf.vaultROI != null ? (perf.vaultROI > 0 ? '+' : '') + perf.vaultROI.toFixed(1) + '%' : 'N/A'}
  30d ROCE (return on capital employed, last 30 days): ${perf.periodROCE != null ? perf.periodROCE.toFixed(1) + '%' : 'N/A'}
  Open: ${posSummary.openCount || 0} positions (${posSummary.winningCount || 0}W / ${posSummary.losingCount || 0}L)
${winningPositions.length ? `  Best open positions:\n${winningPositions.map((p: any) =>
  `    "${p.market?.substring(0, 55)}": ${p.outcome} — $${p.avgPrice?.toFixed(2)} → $${p.curPrice?.toFixed(2)} (+${p.pnlPercent?.toFixed(0) || '?'}%)`
).join('\n')}` : ''}
${recentTrades.length ? `  Recent closed trades:\n${recentTrades.map((t: any) =>
  `    "${t.market?.substring(0, 50)}": ${(t.realizedPnl || 0) > 0 ? 'WIN' : 'LOSS'}`
).join('\n')}` : ''}
${cleanVaultDoc ? `  Extra: ${JSON.stringify(cleanVaultDoc).substring(0, 300)}` : ''}`;
  }).join('\n');

  return `Write a combined vault update covering ALL vaults below in a single post.

${STYLE_DESCRIPTIONS[s]}

━━━ ALL VAULTS ━━━
${vaultBlocks}

━━━ CRITICAL: DATA RULES ━━━
- ONLY state what the data above explicitly shows. Do NOT infer, assume, or editorialize beyond it.
- ROI and ROCE are specific metrics — report them as numbers. Do NOT interpret a negative ROI as "the vault is losing money overall" or "in loss since inception." A vault can have negative ROI but positive total PnL (realized + unrealized).
- If a vault has winning open positions, say so — those are real unrealized gains regardless of what the ROI metric shows.
- Do NOT assume or mention launch dates, inception dates, or timeframes unless the data explicitly includes them.
- Report each metric exactly as labeled. "30d ROCE: -165%" means the 30-day return on capital employed is -165%, not that the vault lost 165% of its money.
- When a metric is negative but open positions are winning, present both facts without contradiction.

━━━ WRITING NOTES ━━━
- KEEP IT SHORT: tweet under 200 words, telegram under 250 words
- Cover all 3 vaults — give each vault 2-3 lines with its headline stat and best position
- NEVER mention dollar amounts for vault size, capital deployed, or total PnL — only ROI %, ROCE %, win rates
- Individual trade P&L in dollars is fine
- Structure: brief intro line → vault 1 → vault 2 → vault 3 → one-line closing
- For tweet: no links, end with a question or observation
- For telegram: end with "yieldr.org/vaults"`;
}
