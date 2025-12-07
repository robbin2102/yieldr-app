# Polymarket Trade Monitor

Real-time monitoring script for tracking and analyzing trader activity on Polymarket.

## Overview

This script monitors wallet `0xecd55daa7c6900683b804d1d4db935fbfabe43f4` for new trades and provides comprehensive analytics to understand the trading strategy and automation patterns.

## Features

### Real-Time Monitoring
- ✅ Polls Polymarket API every 1 second for new trades
- ✅ Logs each trade immediately with full details
- ✅ Generates 60-second analytics summaries
- ✅ No data persistence (pure monitoring/analysis)

### Analytics Provided

#### 1. **Trade Logging**
Each new trade displays:
- 🟢/🔴 Buy/Sell indicator
- Timestamp (precise to milliseconds)
- Share count and price
- Market and outcome
- USD volume
- Transaction hash

#### 2. **Batch Processing Analysis**
- Detects trades executed at the same timestamp
- Shows batch grouping patterns
- Identifies simultaneous multi-position entries

#### 3. **Buy/Sell Volume**
- Total buys vs sells (count, shares, USD)
- Net position changes
- Trading direction bias

#### 4. **Market-by-Market Breakdown**
For each unique market/outcome:
- Buy activity (trades, shares, avg price, volume)
- Sell activity (trades, shares, avg price, volume)
- Net position (LONG/SHORT/FLAT)
- Sorted by net volume

#### 5. **Trading Velocity**
- Trades per minute
- Average time between trades
- Min/max intervals
- Identifies high-frequency patterns

#### 6. **Price Analysis**
- Average execution price
- Price range (min/max)
- Price distribution insights

#### 7. **Position Size Analysis**
- Average trade size
- Size range (min/max)
- Size distribution patterns

#### 8. **Strategy Insights**
Auto-detects:
- ✅ Batch execution patterns
- ✅ Directional bias (heavy buy/sell)
- ✅ High-frequency trading
- ✅ Single vs multi-market focus
- ✅ Hedging/scalping behavior
- ✅ Market-making patterns

## Usage

### Start Monitoring

```bash
npm run polymarket:monitor
```

### Stop Monitoring

Press `Ctrl+C` to stop. The script will show a summary:
- Total session duration
- Total trades detected

### Sample Output

```
====================================================================================================
🎯 POLYMARKET TRADE MONITOR - STARTED
====================================================================================================
Wallet: 0xecd55daa7c6900683b804d1d4db935fbfabe43f4
Poll Interval: 1000ms (1 second)
Summary Interval: 60000ms (60 seconds)
Started: 12/7/2025, 6:48:02 PM
====================================================================================================

⏳ Waiting for new trades...

🟢 TRADE #1 | 18:48:15.234
   BUY 1,500 shares @ $0.5234
   Market: Bitcoin Up/Down Dec 7 7:00PM-7:15PM ET
   Outcome: Up
   Volume: $785.10
   TX: 0x1234abcd...

🔴 TRADE #2 | 18:48:15.234
   SELL 800 shares @ $0.4876
   Market: Bitcoin Up/Down Dec 7 7:00PM-7:15PM ET
   Outcome: Down
   Volume: $390.08
   TX: 0x5678efgh...

====================================================================================================
📊 60-SECOND SUMMARY
====================================================================================================
Period: Last 60s | Total Session: 60s
Trades Detected: 12

🔄 BATCH PROCESSING:
   Unique timestamps: 3
   Batched executions: 2
   Batch details:
     Batch 1 @ 18:48:15: 4 trades
       - BUY 1500 Up @ $0.5234
       - SELL 800 Down @ $0.4876
       - BUY 2000 Up @ $0.5210
       - SELL 1200 Down @ $0.4920

💰 BUY/SELL ANALYSIS:
   Buys:  7 trades | 8,500 shares | $4,350.00
   Sells: 5 trades | 6,200 shares | $3,100.00
   Net:   +2 trades | +2,300 shares | $+1,250.00

📈 MARKET-BY-MARKET BREAKDOWN (2 unique positions):

   1. Bitcoin Up/Down Dec 7 7:00PM-7:15PM ET
      Outcome: Up
      Buys:  4 trades | 5,000 shares @ avg $0.5200 | $2,600.00
      Sells: 0 trades | 0 shares @ avg $0.0000 | $0.00
      Net:   +5,000 shares | $+2,600.00 (LONG)

   2. Bitcoin Up/Down Dec 7 7:00PM-7:15PM ET
      Outcome: Down
      Buys:  0 trades | 0 shares @ avg $0.0000 | $0.00
      Sells: 5 trades | 6,200 shares @ avg $0.5000 | $3,100.00
      Net:   -6,200 shares | $-3,100.00 (SHORT)

⏱️  TRADING VELOCITY:
   Trades per minute: 12.0
   Avg time between trades: 5.5s
   Min time between trades: 0s
   Max time between trades: 15s

💵 PRICE ANALYSIS:
   Avg price: $0.5123
   Price range: $0.4876 - $0.5234

📊 TRADE SIZE DISTRIBUTION:
   Avg size: 1,225 shares
   Size range: 800 - 2,000 shares

🧠 STRATEGY INSIGHTS:
   ✓ Uses batch execution (2 batches detected)
   ✓ Balanced buy/sell activity (58% buys)
   ✓ High-frequency trading (12 trades, avg 5.5s apart)
   ✓ Trading across 2 different markets
   ✓ Possible hedging/scalping detected (2 markets with both buys and sells)

====================================================================================================
```

## Understanding the Output

### Batch Trading
If you see multiple trades with the same timestamp, the trader is using batch execution - likely an automated system submitting multiple orders simultaneously.

### Hedging Patterns
When you see buys and sells on opposite outcomes (Up vs Down) of the same market, this indicates hedging or arbitrage strategies.

### High-Frequency Activity
- Trades every few seconds = algorithmic/automated trading
- Large batch sizes = capital-efficient execution
- Same markets repeatedly = focused strategy

### Net Position
- Positive net shares = building long position (bullish)
- Negative net shares = building short position (bearish)
- Zero net shares = scalping/market making

## Technical Details

### API Endpoint
- **URL**: `https://data-api.polymarket.com/activity`
- **Type**: TRADE (captures all buy/sell activity)
- **Rate**: 1 request per second
- **Limit**: 500 trades per request

### Performance
- Minimal memory footprint (no database writes)
- Real-time streaming output
- Efficient deduplication (tracks seen trade IDs)

### Error Handling
- Graceful API error recovery
- Continues monitoring on failures
- Shows error messages without crashing

## Use Cases

1. **Strategy Analysis**: Understand how professional traders operate
2. **Pattern Detection**: Identify algorithmic trading patterns
3. **Market Making**: Detect liquidity provision behavior
4. **Risk Management**: Monitor position sizing and hedging
5. **Performance Tracking**: Real-time P&L implications

## Notes

- This is a monitoring tool only - no data is saved to MongoDB
- Requires active internet connection to Polymarket API
- Press Ctrl+C to stop and see session summary
- Best run during active trading hours for the wallet
