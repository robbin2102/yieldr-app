/**
 * High Conviction Trade Alert Template
 * Generates posts about live copy trades executed by vault agents
 * Data source: ahf-copyTrades / poly-agent-trades (FILLED status)
 */

export function buildHighConvictionPrompt(trade: any): string {
  const hasConviction = trade.convictionRatio != null && trade.convictionRatio > 1;
  const convictionLine = hasConviction
    ? `- Conviction ratio: ${trade.convictionRatio}x their avg bet${trade.avgBet ? ` (avg $${trade.avgBet.toFixed(0)})` : ''}`
    : `- Trade size: $${(trade.traderBetUsdc || 0).toLocaleString()}`;

  const hookGuidance = hasConviction
    ? `"${trade.convictionRatio}x normal size into [market]" — lead with the conviction multiplier`
    : `"$${(trade.traderBetUsdc || 0).toLocaleString()} into [market]" — lead with the dollar size`;

  return `Generate a Live Copy Trade Alert post.

⚡ AGENT JUST COPIED THIS TRADE:
- Market: "${trade.market}"
- Position: ${trade.outcome} @ $${trade.traderPrice?.toFixed(2) || 'N/A'}
${convictionLine}
- Side: ${trade.side || 'BUY'}

OUR COPY EXECUTION:
${trade.ourExecutedSize ? `- Executed size: $${trade.ourExecutedSize.toLocaleString()}` : '- Size: vault-optimized allocation'}
${trade.ourPrice ? `- Our fill price: $${trade.ourPrice.toFixed(2)}` : ''}
${trade.slippageBps != null ? `- Slippage: ${trade.slippageBps}bps` : ''}
${trade.latencyMs != null ? `- Latency: ${trade.latencyMs}ms` : ''}

TRADER CREDENTIALS:
${trade.traderWinRate ? `- Win Rate: ${trade.traderWinRate.toFixed(1)}%` : '- Win rate: tracking'}
${trade.traderProfitFactor ? `- Profit Factor: ${trade.traderProfitFactor.toFixed(2)}x` : ''}
- Specialty: ${trade.traderSpecialty || 'Multi-category'}

NARRATIVE: This is a LIVE trade our vault agent just executed. Tell it like breaking news:
1. The agent detected a high-conviction move from a trader it tracks
2. It executed the copy trade in real-time
3. Here's why this specific market/bet matters right now

FORMAT:
X tweet: 3-4 lines with line breaks. Hook: ${hookGuidance}. Show the agent working in real-time. Use ⚡ emoji.
TG post: Full breakdown with **bold** numbers. The trade, what the agent did, the market context.

CTA: Frame around the market question itself. Make readers take a side on the outcome.

CONTENT RULES:
- Emphasize the AGENT copying a trade LIVE — automation and speed
- Urgency from data only — never words like "urgent" or "alert" or "breaking"
- Clarify the position: "betting [X] will NOT happen" or "backing [X] at $0.XX"
- Pick ONE trader credential — not both win rate and profit factor
- If conviction ratio is available and > 1x, lead with it. Otherwise lead with $ size.
- Use ⚡ or 🤖 emoji for the automation angle`;
}
