#!/bin/bash
# Diagnostic curl commands for Polymarket API investigation

WALLET_KCH="0x6a72f61820b26b1fe4d956e17b6dc2a1ea3033ee"
WALLET_PIMPING="0x1af1dfc2c523af1d7551597c985277cd11b30f7b"

echo "=============================================="
echo "TEST 1: /positions API for kch123"
echo "=============================================="
echo "Command: curl 'https://data-api.polymarket.com/positions?user=$WALLET_KCH&sizeThreshold=0.1&limit=100'"
echo ""
curl -s "https://data-api.polymarket.com/positions?user=$WALLET_KCH&sizeThreshold=0.1&limit=100" | jq 'length as $total | {
  total_positions: $total,
  positions: [.[] | {
    title: .title[0:50],
    outcome: .outcome,
    curPrice: .curPrice,
    size: .size,
    currentValue: .currentValue,
    cashPnl: .cashPnl,
    initialValue: .initialValue
  }] | sort_by(-.currentValue) | .[0:10]
}'

echo ""
echo "=============================================="
echo "TEST 2: /positions API WITHOUT sizeThreshold"
echo "=============================================="
echo "Command: curl 'https://data-api.polymarket.com/positions?user=$WALLET_KCH&limit=100'"
echo ""
curl -s "https://data-api.polymarket.com/positions?user=$WALLET_KCH&limit=100" | jq 'length as $total | {
  total_positions: $total,
  positions: [.[] | {
    title: .title[0:50],
    curPrice: .curPrice,
    currentValue: .currentValue
  }] | sort_by(-.currentValue) | .[0:10]
}'

echo ""
echo "=============================================="
echo "TEST 3: Check for resolved positions (100¢)"
echo "=============================================="
curl -s "https://data-api.polymarket.com/positions?user=$WALLET_KCH&limit=500" | jq '[.[] | select(.curPrice > 0.99)] | {
  resolved_wins_count: length,
  positions: [.[] | {title: .title[0:50], curPrice: .curPrice, currentValue: .currentValue}]
}'

echo ""
echo "=============================================="
echo "TEST 4: Check for resolved positions (0¢)"
echo "=============================================="
curl -s "https://data-api.polymarket.com/positions?user=$WALLET_KCH&limit=500" | jq '[.[] | select(.curPrice < 0.01)] | {
  resolved_losses_count: length,
  positions: [.[] | {title: .title[0:50], curPrice: .curPrice, initialValue: .initialValue}]
}'

echo ""
echo "=============================================="
echo "TEST 5: /v1/closed-positions for kch123 (30 days)"
echo "=============================================="
THIRTY_DAYS_AGO=$(( $(date +%s) - 2592000 ))
echo "Command: curl 'https://data-api.polymarket.com/v1/closed-positions?user=$WALLET_KCH&limit=50&sortBy=TIMESTAMP&sortDirection=DESC'"
echo ""
curl -s "https://data-api.polymarket.com/v1/closed-positions?user=$WALLET_KCH&limit=50&sortBy=TIMESTAMP&sortDirection=DESC" | jq '{
  total: length,
  total_pnl: [.[].realizedPnl] | add,
  wins: [.[] | select(.realizedPnl >= 0)] | length,
  losses: [.[] | select(.realizedPnl < 0)] | length,
  top_10: [.[] | {title: .title[0:40], realizedPnl: .realizedPnl}] | sort_by(-.realizedPnl | fabs) | .[0:10]
}'

echo ""
echo "=============================================="
echo "TEST 6: Check /activity API for recent trades"
echo "=============================================="
curl -s "https://data-api.polymarket.com/activity?user=$WALLET_KCH&limit=20&sortBy=TIMESTAMP&sortDirection=DESC" | jq '[.[] | {
  type: .type,
  side: .side,
  title: .title[0:40],
  outcome: .outcome,
  price: .price,
  usdcSize: .usdcSize,
  timestamp: .timestamp
}]'

echo ""
echo "=============================================="
echo "TEST 7: Pimping - /positions API"
echo "=============================================="
curl -s "https://data-api.polymarket.com/positions?user=$WALLET_PIMPING&limit=100" | jq '{
  total: length,
  by_price_range: {
    active: [.[] | select(.curPrice >= 0.01 and .curPrice <= 0.99)] | length,
    resolved_loss: [.[] | select(.curPrice < 0.01)] | length,
    resolved_win: [.[] | select(.curPrice > 0.99)] | length
  },
  positions: [.[] | {title: .title[0:40], curPrice: .curPrice, currentValue: .currentValue, initialValue: .initialValue}]
}'

echo ""
echo "=============================================="
echo "TEST 8: Check if there's a different endpoint"
echo "=============================================="
echo "Trying /profit endpoint..."
curl -s "https://data-api.polymarket.com/profit?user=$WALLET_KCH" | head -c 500
echo ""
echo ""
echo "Trying /pnl endpoint..."
curl -s "https://data-api.polymarket.com/pnl?user=$WALLET_KCH" | head -c 500
echo ""
echo ""
echo "Trying /portfolio endpoint..."
curl -s "https://data-api.polymarket.com/portfolio?user=$WALLET_KCH" | head -c 500
echo ""

echo ""
echo "=============================================="
echo "DONE - Please share the output above"
echo "=============================================="
