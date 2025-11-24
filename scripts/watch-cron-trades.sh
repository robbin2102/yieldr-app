#!/bin/bash
# Auto-refreshing trade monitor for Avantis cron job
# Refreshes every 3 minutes (180 seconds)

API_URL="https://yieldr-app.vercel.app/api/avantis/cron-history"

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

while true; do
  clear
  echo -e "${BLUE}════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════${NC}"
  echo -e "${YELLOW}                                        AVANTIS TRADES MONITOR - AUTO REFRESH (3min)${NC}"
  echo -e "${BLUE}════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════${NC}"

  # Fetch data
  DATA=$(curl -s "$API_URL")

  # Display summary
  echo -e "\n${YELLOW}SUMMARY:${NC}"
  echo "$DATA" | jq -r '.summary | "  Last Updated: \(.lastUpdated | split("T")[1] | split(".")[0]) UTC  |  Total Trades: \(.totalTrades)  |  Time Range: \(.timeRange)"'

  echo -e "\n${YELLOW}CRON WINDOWS:${NC}"
  echo "$DATA" | jq -r '.summary.cronWindows[] | "  \(.windowStart | split("T")[1] | split(".")[0]) → \(.windowEnd | split("T")[1] | split(".")[0])  |  Total: \(.count)  (✅ \(.opens) OPEN, ❌ \(.closes) CLOSE)"'

  echo -e "\n${BLUE}════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════${NC}"
  echo -e "${YELLOW}TRADES DETAIL TABLE:${NC}"
  echo ""

  # Create detailed table
  echo "$DATA" | jq -r '
    ["TIME", "TYPE", "PAIR", "DIR", "WALLET", "COLLAT", "SIZE", "LEV", "ENTRY", "EXIT", "TP", "SL", "PNL", "ROI%", "ORDER ID"],
    ["──────────", "─────", "───────", "─────", "──────────", "──────", "──────", "───", "────────", "────────", "────────", "────────", "───────", "─────", "────────"],
    (.trades[] | [
      (.timestamp | split("T")[1] | split(".")[0]),
      (if .eventType == "OPEN" then "✅ OPEN" else "❌ CLOSE" end),
      .pairSymbol,
      .direction,
      (.trader | split("")[:10] | join("")) + "...",
      (if .collateralUsdc then (.collateralUsdc | tostring) else "-" end),
      (if .positionSizeUsdc then (.positionSizeUsdc | tostring) else "-" end),
      (if .leverage then (.leverage | tostring) + "x" else "-" end),
      (if .openPrice then (.openPrice | tonumber | . * 100 | round / 100 | tostring) else "-" end),
      (if .closePrice then (.closePrice | tonumber | . * 100 | round / 100 | tostring) else "-" end),
      (if .tp then (.tp | tonumber | . * 100 | round / 100 | tostring) else "-" end),
      (if .sl then (.sl | tonumber | . * 100 | round / 100 | tostring) else "-" end),
      (if .pnlUsdc then ("$" + (.pnlUsdc | tonumber | . * 100 | round / 100 | tostring)) else "-" end),
      (if .roi then ((.roi | tonumber | . * 100 | round / 100 | tostring) + "%") else "-" end),
      .orderId
    ])
    | @tsv
  ' | column -t -s $'\t'

  echo ""
  echo -e "${BLUE}════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════${NC}"
  echo -e "${YELLOW}Next refresh in 3 minutes...${NC} (Press Ctrl+C to stop)"
  echo ""

  # Wait 3 minutes
  sleep 180
done
