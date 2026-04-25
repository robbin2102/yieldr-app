/**
 * High Conviction Trade Alert Template
 * Generates posts about whale trades from top edge-ranked traders
 */

export function buildHighConvictionPrompt(trade: any): string {
  const winRate = trade.traderContext?.winRate || trade.traderWinRate;
  const pf = trade.traderContext?.profitFactor || trade.traderProfitFactor;
  const avgSize = trade.traderContext?.avgTradeSize;

  return `Generate a High Conviction Trade Alert post.

WHALE TRADE DETECTED:
- Market: "${trade.market}"
- Position: ${trade.outcome} @ $${trade.price?.toFixed(2)}
- Size: $${(trade.usdcValue || trade.usdcSize)?.toLocaleString()}
- vs Their Average: ${trade.sizeMultiplier?.toFixed(0)}x their normal trade${avgSize ? ` (avg $${avgSize?.toFixed(0)})` : ''}
- Conviction Level: ${trade.convictionLevel}

TRADER CREDENTIALS:
${winRate ? `- Win Rate: ${winRate?.toFixed(1)}%` : ''}
${pf ? `- Profit Factor: ${pf?.toFixed(2)}x` : ''}
- Specialty: ${trade.specialty || 'Unknown'}

FORMAT (3 lines with line breaks between them):
Line 1 (hook): "$X into [market] — Nx their normal size." Size and multiplier. Nothing else.
Line 2 (signal): What they're betting on and why this trader's track record makes it signal-worthy. One clean sentence.
Line 3 (CTA): A sharp question about the market outcome — not generic. E.g. "Does this trader know something the market doesn't?"

CONTENT RULES:
- Urgency must come from the data (trade size, multiplier, win rate) — not from words like "urgent" or "alert"
- Clarify the position clearly: "betting [X] will NOT happen" or "backing [X] at $0.XX"
- Pick ONE trader credential (win rate OR profit factor) — not both`;
}
