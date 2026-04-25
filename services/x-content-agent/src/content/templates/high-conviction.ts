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

IMPORTANT RULES:
- Lead with the SIZE of the trade and the multiplier — that's the signal
- One sentence on what the trader is betting ON specifically
- One sentence on the trader's credentials (win rate or profit factor — pick one)
- The urgency should be real data, not hype words
- End with a sharp question — what does this trader know?`;
}
