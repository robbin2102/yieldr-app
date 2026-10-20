/**
 * High Conviction Trade Alert Template
 * Generates posts about whale trades from top edge traders
 */

export function buildHighConvictionPrompt(trade: any): string {
  return `Generate a High Conviction Trade Alert post for X.

WHALE TRADE DETECTED:
- Trader: ${trade.traderLabel || trade.wallet?.substring(0, 8) + '...' + trade.wallet?.substring(trade.wallet.length - 4)}
- Market: "${trade.market}"
- Position: ${trade.outcome} @ $${trade.price?.toFixed(2)}
- Size: $${trade.usdcValue?.toLocaleString()}
- Size vs Average: ${trade.sizeMultiplier?.toFixed(0)}x their normal trade size
- Conviction Level: ${trade.convictionLevel}

TRADER EDGE:
- Win Rate: ${trade.traderContext?.winRate?.toFixed(1)}%
- Profit Factor: ${trade.traderContext?.profitFactor?.toFixed(2)}
- Avg Trade Size: $${trade.traderContext?.avgTradeSize?.toLocaleString()}

Create an urgent, data-driven alert post that:
1. Leads with the whale trade signal (size, multiplier)
2. Shows the trader's edge credentials
3. Names the specific market and position
4. Creates urgency without hype
5. Ends with a question driving engagement
6. Ends with varied CTA inviting users to ask @yieldrdotorg for more whale alerts
7. Max 280 characters`;
}
