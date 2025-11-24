#!/bin/bash
# Trade monitor - Last 24 hours of trades, refreshes every 60 seconds

API_URL="https://yieldr-app.vercel.app/api/avantis/recent-trades"
HOURS=24
REFRESH_INTERVAL=60  # seconds

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Convert UTC to IST
utc_to_ist() {
  local utc_time="$1"
  local date_part=$(echo "$utc_time" | cut -d'T' -f1)
  local time_part=$(echo "$utc_time" | cut -d'T' -f2 | cut -d'.' -f1)
  date -d "$date_part $time_part UTC + 5 hours 30 minutes" "+%Y-%m-%d %H:%M:%S" 2>/dev/null || echo "$utc_time"
}

while true; do
  clear

  echo -e "${BLUE}═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════${NC}"
  echo -e "${YELLOW}                                                      AVANTIS TRADES - LAST 24 HOURS${NC}"
  echo -e "${CYAN}                                           Auto-refresh: ${REFRESH_INTERVAL}s | Timezone: IST | Database: historicaltrades${NC}"
  echo -e "${BLUE}═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════${NC}"

  # Fetch data
  DATA=$(curl -s "$API_URL?hours=$HOURS")

  if [ -z "$DATA" ] || [ "$DATA" == "null" ]; then
    echo -e "\n${RED}❌ Failed to fetch data${NC}"
    sleep $REFRESH_INTERVAL
    continue
  fi

  # Summary
  TRADE_COUNT=$(echo "$DATA" | jq -r '.data.count // 0')
  OPEN_COUNT=$(echo "$DATA" | jq -r '[.data.trades[] | select(.eventType == "OPEN")] | length')
  CLOSE_COUNT=$(echo "$DATA" | jq -r '[.data.trades[] | select(.eventType == "CLOSE")] | length')
  LAST_UPDATED=$(echo "$DATA" | jq -r '.data.lastUpdated // "N/A"')
  LAST_UPDATED_IST=$(utc_to_ist "$LAST_UPDATED")

  echo -e "\n${CYAN}Last Updated: ${LAST_UPDATED_IST} IST  |  Total: ${TRADE_COUNT}  |  ✅ OPEN: ${OPEN_COUNT}  |  ❌ CLOSE: ${CLOSE_COUNT}${NC}\n"

  # Table header
  printf "${YELLOW}%-20s %-7s %-9s %-6s %-8s %-8s %-5s %-9s %-9s %-9s %-9s %-11s %-9s %-11s %-15s${NC}\n" \
    "DATETIME (IST)" "TYPE" "PAIR" "DIR" "SIZE" "COLLAT" "LEV" "ENTRY" "EXIT" "TP" "SL" "PNL" "ROI%" "ORDER ID" "WALLET"

  printf "%-20s %-7s %-9s %-6s %-8s %-8s %-5s %-9s %-9s %-9s %-9s %-11s %-9s %-11s %-15s\n" \
    "───────────────────" "──────" "────────" "─────" "───────" "───────" "────" "────────" "────────" "────────" "────────" "──────────" "────────" "──────────" "──────────────"

  # Display trades
  echo "$DATA" | jq -r '.data.trades[] | [
    .timestamp,
    .eventType,
    .pairSymbol,
    .direction,
    (.positionSizeUsdc // 0),
    (.collateralUsdc // 0),
    (.leverage // 0),
    (.openPrice // 0),
    (.closePrice // 0),
    (.tp // 0),
    (.sl // 0),
    (.pnlUsdc // 0),
    (.roi // 0),
    .orderId,
    .trader
  ] | @tsv' | while IFS=$'\t' read -r timestamp eventType pair direction size collat lev entry exit tp sl pnl roi orderId trader; do

    # Convert to IST
    ist_time=$(utc_to_ist "$timestamp")

    # Format numbers
    size_fmt=$(printf "%.0f" "$size" 2>/dev/null || echo "-")
    collat_fmt=$(printf "%.0f" "$collat" 2>/dev/null || echo "-")
    lev_fmt=$([ "$lev" != "0" ] && echo "${lev}x" || echo "-")
    entry_fmt=$([ "$entry" != "0" ] && printf "%.2f" "$entry" 2>/dev/null || echo "-")
    exit_fmt=$([ "$exit" != "0" ] && printf "%.2f" "$exit" 2>/dev/null || echo "-")
    tp_fmt=$([ "$tp" != "0" ] && printf "%.2f" "$tp" 2>/dev/null || echo "-")
    sl_fmt=$([ "$sl" != "0" ] && printf "%.2f" "$sl" 2>/dev/null || echo "-")
    pnl_fmt=$([ "$pnl" != "0" ] && printf "\$%.2f" "$pnl" 2>/dev/null || echo "-")
    roi_fmt=$([ "$roi" != "0" ] && printf "%.2f%%" "$roi" 2>/dev/null || echo "-")
    wallet_short="${trader:0:6}..${trader: -4}"

    # Color by type
    if [ "$eventType" == "OPEN" ]; then
      type_color="${GREEN}OPEN${NC}   "
    else
      type_color="${RED}CLOSE${NC}  "
    fi

    printf "%-20s ${type_color} %-9s %-6s %-8s %-8s %-5s %-9s %-9s %-9s %-9s %-11s %-9s %-11s %-15s\n" \
      "$ist_time" "$pair" "$direction" "$size_fmt" "$collat_fmt" "$lev_fmt" \
      "$entry_fmt" "$exit_fmt" "$tp_fmt" "$sl_fmt" "$pnl_fmt" "$roi_fmt" "$orderId" "$wallet_short"

  done

  echo ""
  echo -e "${BLUE}═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════${NC}"
  echo -e "${YELLOW}Next refresh in ${REFRESH_INTERVAL} seconds...${NC} (Press Ctrl+C to stop)"

  sleep $REFRESH_INTERVAL
done
