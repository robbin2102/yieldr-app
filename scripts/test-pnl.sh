#!/bin/bash

# DrPufferfish wallet
WALLET="0xdb27bf2ac5d428a9c63dbc914611036855a6c56e"

# Time filter (30 days ago in Unix seconds)
NOW=$(date +%s)
START_TS=$((NOW - 30*24*60*60))

echo "=== P&L Analysis for $WALLET ==="
echo "Time window: Last 30 days (since $START_TS)"
echo ""

# 1. Fetch activities (first 500)
echo "=== ACTIVITIES (first 500) ==="
curl -s "https://data-api.polymarket.com/activity?user=$WALLET&limit=500&offset=0&sortBy=TIMESTAMP&sortDirection=DESC" | jq '
  . as $all |
  {
    total_count: ($all | length),
    buys: [.[] | select(.type == "TRADE" and .side == "BUY")] | {count: length, total_usdc: (map(.usdcSize) | add)},
    sells: [.[] | select(.type == "TRADE" and .side == "SELL")] | {count: length, total_usdc: (map(.usdcSize) | add)},
    redeems: [.[] | select(.type == "REDEEM")] | {count: length, total_usdc: (map(.usdcSize) | add)},
    splits: [.[] | select(.type == "SPLIT")] | length,
    merges: [.[] | select(.type == "MERGE")] | length,
    sample_buy: [.[] | select(.type == "TRADE" and .side == "BUY")][0] | {conditionId, outcome, size, price, usdcSize},
    sample_redeem: [.[] | select(.type == "REDEEM")][0] | {conditionId, outcome, size, usdcSize}
  }
'

echo ""
echo "=== OPEN POSITIONS (all) ==="
curl -s "https://data-api.polymarket.com/positions?user=$WALLET&sizeThreshold=0.1&limit=500" | jq '
  . as $all |
  {
    total_count: ($all | length),
    open_positions: [.[] | select(.curPrice >= 0.001 and .curPrice <= 0.99)] | {count: length, total_value: (map(.currentValue) | add), unrealized_pnl: (map(.cashPnl) | add)},
    resolved_losses: [.[] | select(.curPrice < 0.001)] | {count: length, total_initial: (map(.initialValue) | add)},
    resolved_wins: [.[] | select(.curPrice > 0.99)] | {count: length, total_current: (map(.currentValue) | add), total_initial: (map(.initialValue) | add)},
    sample_resolved_win: [.[] | select(.curPrice > 0.99)][0] | {conditionId, outcome, size, curPrice, currentValue, initialValue}
  }
'

echo ""
echo "=== CLOSED POSITIONS (redeemed, last 30d) ==="
curl -s "https://data-api.polymarket.com/v1/closed-positions?user=$WALLET&limit=500&sortBy=TIMESTAMP&sortDirection=DESC" | jq --argjson start "$START_TS" '
  [.[] | select(.timestamp >= $start)] as $filtered |
  {
    total_in_30d: ($filtered | length),
    total_realized_pnl: ($filtered | map(.realizedPnl) | add),
    wins: [.[] | select(.realizedPnl >= 0)] | {count: length, total: (map(.realizedPnl) | add)},
    losses: [.[] | select(.realizedPnl < 0)] | {count: length, total: (map(.realizedPnl) | add)},
    sample: $filtered[0] | {title, outcome, realizedPnl, timestamp}
  }
'

echo ""
echo "=== P&L CALCULATION ==="
echo "Formula: netPnl = cashIn + unredeemedWinValue - cashOut"
echo ""
echo "Polymarket shows: \$2,064,530.62 (Past Month)"
