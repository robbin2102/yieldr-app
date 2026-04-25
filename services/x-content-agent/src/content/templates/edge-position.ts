/**
 * Edge Position Alpha Template
 *
 * Generates posts about the best live positions held by edge-ranked traders.
 * Framed as alpha discovery — "what is a top trader holding right now?"
 * Never framed as copy trading.
 */

export function buildEdgePositionPrompt(position: any): string {
  const gainPct = position.percentPnl?.toFixed(1);
  const cashGain = position.cashPnl?.toLocaleString();
  const currentValue = position.currentValue?.toLocaleString();
  const avgPrice = position.avgPrice?.toFixed(2);
  const curPrice = position.curPrice?.toFixed(2);

  // Interpret the position in plain English
  let outcomeInterpretation = '';
  const outcome = (position.outcome || '').toUpperCase();
  if (outcome === 'YES') {
    outcomeInterpretation = `They're betting this WILL happen`;
  } else if (outcome === 'NO') {
    outcomeInterpretation = `They're betting this will NOT happen`;
  } else {
    outcomeInterpretation = `Holding "${position.outcome}"`;
  }

  return `Generate an Alpha Signal post about a compelling live position held by a top-ranked Polymarket trader.

═══ THE POSITION ═══
- Market: "${position.title}"
- Outcome held: ${position.outcome}
- Plain-English: ${outcomeInterpretation}
- Entered at: $${avgPrice} → now worth $${curPrice}
- Gain: +${gainPct}% (+$${cashGain} in cash)
- Current position value: $${currentValue || 'N/A'}

═══ THE TRADER ═══
- Specialty: ${position.traderSpecialty || 'Multi-category'}
- Rank: #${position.traderRank || '?'} by statistical edge
- Win rate: ${position.traderWinRate?.toFixed(1) || 'N/A'}%
- Profit factor: ${position.traderProfitFactor?.toFixed(2) || 'N/A'}x
- Strategy: ${position.traderStrategyLabel || 'N/A'}
- Edge hypothesis: ${position.traderEdgeHypothesis || 'N/A'}
- Avg trade size: $${position.traderAvgTradeSize?.toFixed(0) || 'N/A'}
- Sustainability: ${position.traderSustainability || 'N/A'}
${position.traderPnl30d != null ? `- 30d PnL: $${position.traderPnl30d.toLocaleString()}` : ''}
${position.traderRoce30d != null ? `- 30d ROCE: ${position.traderRoce30d.toFixed(0)}%` : ''}

═══ NARRATIVE INSTRUCTIONS ═══
Tell this as an ALPHA DISCOVERY story. Our agents scan thousands of Polymarket traders 24/7. Right now, one of the top edge-ranked traders is sitting on a compelling open position.

1. What is this market about? (1 sentence real-world context)
2. What is the trader holding and why does it matter? (bet in plain English + gain so far)
3. Why should readers pay attention? (connect trader's track record — WR, PF, rank, edge — to why this signal is credible)
4. What could drive further upside or risk? (1-2 sentence forward-looking take)

CRITICAL FRAMING RULES:
- We DISCOVER alpha and SHARE signals — we are NOT a copy trade product
- Never say "our agent copied" or "we mirrored" or "vault executed"
- Frame as: "Our agents detected..." / "A top-ranked trader is currently holding..." / "Signal from our quant screens..."
- The position belongs to THE TRADER. We're the intelligence layer that surfaced it.
- Explain the position in plain English — not "holding YES" but "betting this will happen"

FORMAT — ONE post for both X and TG:
- Hook line with emoji — lead with the signal, not the dollar amount
- Use **bold** for 3-5 key numbers (% gain, win rate, PF, rank)
- Bullets for key data points
- Tell the full story — no artificial character limit
- End with a question that drives engagement, then "Track live → yieldr.org"`;
}
