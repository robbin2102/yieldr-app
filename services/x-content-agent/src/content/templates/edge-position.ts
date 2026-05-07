import { ContentStyle, STYLE_DESCRIPTIONS } from '../styles';

const CATEGORY_HOOKS: Record<string, string> = {
  NBA: `- Frame around the game/series context — who's playing, what's at stake, why the timing matters
- Use basketball language naturally (matchup, series lead, sweep, upset)
- Hook: "This trader just loaded up on [team] before Game X..."`,
  Soccer: `- Reference the competition context (league, cup, qualifying, derby)
- Use football language (fixture, clean sheet, form, away record)
- Hook: "A top Polymarket wallet just bet big on [team/outcome]..."`,
  Politics: `- Frame around the political event or timeline (election, vote, policy decision)
- Reference the stakes or what changes if the outcome hits
- Hook: "Someone with a 70%+ win rate just made a bold call on [event]..."`,
};

export function buildEdgePositionPrompt(position: any, style?: ContentStyle, category?: string): string {
  const s = style || 'signal';

  const outcome = (position.outcome || '').toUpperCase();
  const plainEnglish = outcome === 'YES'
    ? `betting this WILL happen`
    : outcome === 'NO'
    ? `betting this will NOT happen`
    : `holding "${position.outcome}"`;

  const categoryHook = category && CATEGORY_HOOKS[category]
    ? `\n━━━ CATEGORY HOOK (${category}) ━━━\n${CATEGORY_HOOKS[category]}\n`
    : '';

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
${categoryHook}
━━━ WRITING NOTES ━━━
- KEEP IT SHORT: tweet under 100 words, telegram under 130 words
- Explain the market in one plain-English sentence (what is actually being predicted?)
- This is a SIGNAL post — Yieldr agents detected this position, not the vault copying it
- For the tweet: no links, end with a question that makes people want to reply
- For telegram: end with "Signal tracked live → yieldr.org/vaults"`;
}
