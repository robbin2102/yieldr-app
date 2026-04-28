import { ContentStyle, STYLE_DESCRIPTIONS } from '../styles';

export function buildEdgePositionPrompt(position: any, style?: ContentStyle): string {
  const s = style || 'signal';

  const outcome = (position.outcome || '').toUpperCase();
  const plainEnglish = outcome === 'YES'
    ? `betting this WILL happen`
    : outcome === 'NO'
    ? `betting this will NOT happen`
    : `holding "${position.outcome}"`;

  return `Write a post about a live Polymarket position held by a top-ranked trader.

${STYLE_DESCRIPTIONS[s]}

━━━ THE POSITION ━━━
Market: "${position.title}"
The bet: ${plainEnglish}
Entry: $${position.avgPrice?.toFixed(2)} → now $${position.curPrice?.toFixed(2)}
Gain so far: +${position.percentPnl?.toFixed(1)}% (+$${position.cashPnl?.toFixed(0)})
Current value: $${position.currentValue?.toLocaleString() || 'N/A'}

━━━ THE TRADER ━━━
Rank: #${position.traderRank || '?'} on Polymarket
Win rate: ${position.traderWinRate?.toFixed(1) || 'N/A'}% | Profit factor: ${position.traderProfitFactor?.toFixed(2) || 'N/A'}x
Specialty: ${position.traderSpecialty || 'N/A'}
Strategy: ${position.traderStrategyLabel || 'N/A'}
Edge hypothesis: ${position.traderEdgeHypothesis || 'N/A'}
Avg trade size: $${position.traderAvgTradeSize?.toFixed(0) || 'N/A'}
${position.traderPnl30d != null ? `30d PnL: $${position.traderPnl30d.toLocaleString()}` : ''}
${position.traderRoce30d != null ? `30d ROCE: ${position.traderRoce30d.toFixed(0)}%` : ''}

━━━ WRITING NOTES ━━━
- Explain the market in one plain-English sentence (what is actually being predicted?)
- This is a SIGNAL post — Yieldr agents detected this position, not the vault copying it
- For the tweet: no links, end with a question that makes people want to reply
- For telegram: end with "Signal tracked live → yieldr.org/vaults"`;
}
