/**
 * High Conviction Trade Alert Template
 * Generates posts about live copy trades executed by vault agents
 * Data source: poly-agent-trades / ahf-copyTrades (FILLED status)
 */

export function buildHighConvictionPrompt(trade: any): string {
  return `Generate a Live Copy Trade Alert post.

🔔 AGENT JUST COPIED THIS TRADE:
- Market: "${trade.market}"
- Position: ${trade.outcome} @ $${trade.traderPrice?.toFixed(2)}
- Trader's bet size: $${trade.traderBetUsdc?.toLocaleString()}
- Conviction ratio: ${trade.convictionRatio}x their avg bet${trade.avgBet ? ` (avg $${trade.avgBet?.toFixed(0)})` : ''}
- Side: ${trade.side}

OUR COPY:
- Executed size: $${trade.ourExecutedSize?.toLocaleString() || 'N/A'}
- Our price: $${trade.ourPrice?.toFixed(2) || 'N/A'}
${trade.slippageBps != null ? `- Slippage: ${trade.slippageBps}bps` : ''}
${trade.latencyMs != null ? `- Latency: ${trade.latencyMs}ms` : ''}

TRADER CREDENTIALS:
${trade.traderWinRate ? `- Win Rate: ${trade.traderWinRate?.toFixed(1)}%` : ''}
${trade.traderProfitFactor ? `- Profit Factor: ${trade.traderProfitFactor?.toFixed(2)}x` : ''}
- Specialty: ${trade.traderSpecialty || 'Unknown'}

NARRATIVE: This is a LIVE trade our agent just executed. Tell it like breaking news:
1. The agent detected a high-conviction move from a top trader
2. It executed the copy trade in real-time
3. Here's why this trader's conviction matters (their track record)

FORMAT:
X tweet: 3-4 lines with line breaks. Lead with the conviction signal ("${trade.convictionRatio}x normal size into [market]"). Show the agent working in real-time.
TG post: Full breakdown — the trade, the trader's edge, what the agent did, and what happens next.

CTA: Frame around the market question. Make readers take a side on the outcome.

CONTENT RULES:
- This is about the AGENT copying a trade LIVE — emphasize automation and speed
- Urgency must come from the data (conviction ratio, win rate) — not from words like "urgent" or "alert"
- Clarify the position: "betting [X] will NOT happen" or "backing [X] at $0.XX"
- Show one key trader credential (win rate OR profit factor) — not both
- Use ⚡ or 🤖 emoji for the automation angle
- No character limit — tell the full story`;
}
