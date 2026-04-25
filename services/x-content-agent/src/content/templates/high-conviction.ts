/**
 * High Conviction Trade Alert Template
 * Generates posts about significant trader moves detected by our agents
 * Framed as ALPHA DISCOVERY — never as copy trading
 */

export function buildHighConvictionPrompt(trade: any): string {
  const hasConviction = trade.convictionRatio != null && trade.convictionRatio > 1;

  const sizeInfo = hasConviction
    ? `${trade.convictionRatio}x their normal bet size ($${(trade.traderBetUsdc || 0).toLocaleString()} vs avg $${(trade.avgBet || 0).toFixed(0)})`
    : `$${(trade.traderBetUsdc || 0).toLocaleString()}`;

  // Interpret the position clearly
  const outcomeStr = trade.outcome || '';
  const sideStr = (trade.side || 'BUY').toUpperCase();
  let positionInterpretation = '';
  if (sideStr === 'BUY' && /^yes$/i.test(outcomeStr)) {
    positionInterpretation = `Betting this WILL happen`;
  } else if (sideStr === 'BUY' && /^no$/i.test(outcomeStr)) {
    positionInterpretation = `Betting this will NOT happen`;
  } else if (sideStr === 'SELL' && /^no$/i.test(outcomeStr)) {
    positionInterpretation = `Closing their "No" position — taking profits or flipping bullish`;
  } else if (sideStr === 'SELL' && /^yes$/i.test(outcomeStr)) {
    positionInterpretation = `Exiting their "Yes" position — taking profits or turning bearish`;
  } else {
    positionInterpretation = `${sideStr} ${outcomeStr}`;
  }

  return `Generate an Alpha Signal post about a significant trader move our agents detected.

SIGNAL DETECTED:
- Market: "${trade.market}"
- Move: ${sideStr} ${outcomeStr} @ $${trade.traderPrice?.toFixed(2) || 'N/A'}
- Position interpretation: ${positionInterpretation}
- Size: ${sizeInfo}
${trade.traderWinRate ? `- Trader win rate: ${trade.traderWinRate.toFixed(1)}%` : ''}
${trade.traderProfitFactor ? `- Trader profit factor: ${trade.traderProfitFactor.toFixed(2)}x` : ''}
- Trader specialty: ${trade.traderSpecialty || 'Multi-category'}

${trade.filledUsdc ? `EXECUTION DATA:\n- Fill size: $${trade.filledUsdc.toLocaleString()}\n- Fill price: $${trade.avgFillPrice?.toFixed(2) || 'N/A'}\n- Latency: ${trade.totalLatencyMs || 'N/A'}ms` : ''}

NARRATIVE INSTRUCTIONS:
Tell this as an ALPHA DISCOVERY story. Our agents scan 30K+ traders 24/7. They just detected something interesting:

1. What is the market about? Give 1 sentence of real-world context (what event is being predicted)
2. What did the trader do? A significant move — explain the bet in plain English
3. Why does this matter? Connect the trader's track record to why this signal is worth watching
4. What's your take? End with a question that makes readers think about the outcome

CRITICAL FRAMING RULES:
- We DISCOVER alpha and SHARE signals — we are NOT a copy trade product
- Never say "our agent copied" or "we executed" or "vault mirrored"
- Frame as: "Our agents detected..." or "A top-ranked trader just..." or "Signal from our quant screens..."
- The trade is the TRADER'S move. We're the intelligence layer that found it.
- Explain the bet in plain English — not "BUY No" but "betting this won't happen"
- If SELL side: explain it's an EXIT, not a new position

FORMAT — ONE post for both X and TG:
- Hook line with emoji — the market signal, not the dollar amount
- Use **bold** for 2-4 key numbers (conviction ratio, bet size, win rate)
- Bullet points for key data points
- Tell the full story — no character limit
- End with a question that drives replies and a yieldr.org CTA`;
}
