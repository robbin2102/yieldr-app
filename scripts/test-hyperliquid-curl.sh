#!/bin/bash

# Test Hyperliquid Data Accuracy
# Run these curl commands to verify data

USER="0x162cc7c861ebd0c06b3d72319201150482518185"
NOW=$(date +%s)000  # Current time in milliseconds
ONE_HOUR_AGO=$((NOW - 3600000))  # 1 hour ago

echo "🧪 Testing Hyperliquid Data Accuracy"
echo "User: $USER"
echo ""

# Test 1: User Fills (Last 1 Hour)
echo "📊 Test 1: User Fills (Last 1 Hour)"
echo "Time range: $(date -d @$((ONE_HOUR_AGO/1000)) -u +%Y-%m-%dT%H:%M:%SZ) to $(date -d @$((NOW/1000)) -u +%Y-%m-%dT%H:%M:%SZ)"
echo ""
echo "Fetching user fills..."

curl -s -X POST https://api.hyperliquid.xyz/info \
  -H "Content-Type: application/json" \
  -d "{
    \"type\": \"userFillsByTime\",
    \"user\": \"$USER\",
    \"startTime\": $ONE_HOUR_AGO,
    \"endTime\": $NOW,
    \"aggregateByTime\": true
  }" | jq '.' > /tmp/hyperliquid_fills.json

echo "Saved to /tmp/hyperliquid_fills.json"
echo ""

# Analyze fills
TOTAL_FILLS=$(jq 'length' /tmp/hyperliquid_fills.json)
echo "Total fills: $TOTAL_FILLS"

# Count wins/losses based on closedPnl
jq -r '.[] | select(.closedPnl != null and (.closedPnl | tonumber) != 0) |
  [.time, .coin, .dir, .closedPnl] | @tsv' /tmp/hyperliquid_fills.json | \
  awk -F'\t' '
    BEGIN {
      wins=0; losses=0; neutral=0; total_pnl=0;
      print "\n📈 Closing Fills:"
    }
    {
      timestamp=$1; coin=$2; dir=$3; pnl=$4;
      cmd="date -d @"(timestamp/1000)" -u +%Y-%m-%dT%H:%M:%SZ";
      cmd | getline date_str;
      close(cmd);

      printf "  %s | %s | %s | PnL: $%.2f\n", date_str, coin, dir, pnl;
      total_pnl += pnl;

      if (pnl > 0) wins++;
      else if (pnl < 0) losses++;
      else neutral++;
    }
    END {
      total = wins + losses + neutral;
      win_rate = total > 0 ? (wins / total) * 100 : 0;

      print "\n📊 Fill Analysis:"
      print "  Total Trades:", total
      print "  Wins:", wins
      print "  Losses:", losses
      print "  Neutral:", neutral
      printf "  Total PnL (from fills): $%.2f\n", total_pnl
      printf "  Win Rate: %.2f%%\n", win_rate
    }
  '

echo ""
echo "📊 Test 2: Portfolio API"
echo "Fetching portfolio data..."

curl -s -X POST https://api.hyperliquid.xyz/info \
  -H "Content-Type: application/json" \
  -d "{
    \"type\": \"portfolio\",
    \"user\": \"$USER\"
  }" | jq '.' > /tmp/hyperliquid_portfolio.json

echo "Saved to /tmp/hyperliquid_portfolio.json"
echo ""

# Parse portfolio data
echo "Day PnL History:"
jq -r '.[] | select(.[0] == "day") | .[1].pnlHistory |
  "  Data points: \(length)\n  Latest PnL: $\(last[1])\n  First PnL: $\(first[1])"' \
  /tmp/hyperliquid_portfolio.json

echo ""
echo "Account Value History:"
jq -r '.[] | select(.[0] == "day") | .[1].accountValueHistory |
  "  Data points: \(length)\n  Latest Value: $\(last[1])"' \
  /tmp/hyperliquid_portfolio.json

echo ""
echo "📊 Test 3: Historical Data Availability"
jq -r '
  .[] |
  select(.[0] == "allTime" or .[0] == "month" or .[0] == "week") |
  "  \(.[0]): \(.[1].pnlHistory | length) data points"
' /tmp/hyperliquid_portfolio.json

echo ""
echo "✅ Test Complete!"
echo ""
echo "To analyze further, check:"
echo "  - /tmp/hyperliquid_fills.json"
echo "  - /tmp/hyperliquid_portfolio.json"
