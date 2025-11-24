#!/bin/bash
# Real-time trade monitor showing last 50 trades from database
# Auto-refreshes every 10 seconds to catch new cron job updates

API_URL="https://yieldr-app.vercel.app/api/avantis/recent-trades"
LIMIT=50
REFRESH_INTERVAL=10  # seconds

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
NC='\033[0m' # No Color

# Function to convert UTC to IST
utc_to_ist() {
  local utc_time="$1"
  local date_part=$(echo "$utc_time" | cut -d'T' -f1)
  local time_part=$(echo "$utc_time" | cut -d'T' -f2 | cut -d'.' -f1)

  # Convert to IST (UTC+5:30)
  date -d "$date_part $time_part UTC + 5 hours 30 minutes" "+%m-%d %H:%M:%S" 2>/dev/null || echo "$date_part $time_part"
}

iteration=0

while true; do
  iteration=$((iteration + 1))
  clear

  echo -e "${BLUE}════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════${NC}"
  echo -e "${YELLOW}                                   AVANTIS RECENT TRADES - LAST 50 EVENTS (Auto-refresh: ${REFRESH_INTERVAL}s)${NC}"
  echo -e "${CYAN}                                   Session: $iteration | Timezone: IST | Database: historicaltrades${NC}"
  echo -e "${BLUE}════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════${NC}"

  # Fetch data
  DATA=$(curl -s "$API_URL?limit=$LIMIT")

  # Check if request was successful
  if [ -z "$DATA" ] || [ "$DATA" == "null" ]; then
    echo -e "\n${RED}❌ Failed to fetch data from API${NC}"
    echo -e "${YELLOW}Retrying in ${REFRESH_INTERVAL} seconds...${NC}\n"
    sleep $REFRESH_INTERVAL
    continue
  fi

  # Extract summary
  TRADE_COUNT=$(echo "$DATA" | jq -r '.data.count // 0')
  LAST_UPDATED=$(echo "$DATA" | jq -r '.data.lastUpdated // "N/A"')
  LAST_UPDATED_IST=$(utc_to_ist "$LAST_UPDATED")

  echo -e "\n${YELLOW}SUMMARY:${NC}"
  echo -e "  ${CYAN}Total Trades Shown:${NC} $TRADE_COUNT"
  echo -e "  ${CYAN}Last Database Query:${NC} $LAST_UPDATED_IST IST"
  echo -e "  ${CYAN}Cron Job:${NC} Vercel updates every 10 minutes"

  # Count OPEN vs CLOSE
  OPEN_COUNT=$(echo "$DATA" | jq -r '[.data.trades[] | select(.eventType == "OPEN")] | length')
  CLOSE_COUNT=$(echo "$DATA" | jq -r '[.data.trades[] | select(.eventType == "CLOSE")] | length')

  echo -e "  ${GREEN}✅ OPEN:${NC} $OPEN_COUNT  ${RED}❌ CLOSE:${NC} $CLOSE_COUNT"

  echo -e "\n${BLUE}════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════${NC}"
  echo -e "${YELLOW}RECENT TRADES TABLE:${NC}"
  echo ""

  # Create table header
  printf "${MAGENTA}%-16s  %-6s  %-8s  %-5s  %-12s  %-7s  %-7s  %-4s  %-9s  %-9s  %-9s  %-9s  %-10s  %-8s  %-10s${NC}\n" \
    "TIME (IST)" "TYPE" "PAIR" "DIR" "WALLET" "COLLAT" "SIZE" "LEV" "ENTRY" "EXIT" "TP" "SL" "PNL" "ROI%" "ORDER ID"
  printf "%-16s  %-6s  %-8s  %-5s  %-12s  %-7s  %-7s  %-4s  %-9s  %-9s  %-9s  %-9s  %-10s  %-8s  %-10s\n" \
    "────────────────" "──────" "────────" "─────" "────────────" "───────" "───────" "────" "─────────" "─────────" "─────────" "─────────" "──────────" "────────" "──────────"

  # Process and display trades
  echo "$DATA" | jq -r '.data.trades[] |
    [
      .timestamp,
      .eventType,
      .pairSymbol,
      .direction,
      .trader,
      (.collateralUsdc // 0),
      (.positionSizeUsdc // 0),
      (.leverage // 0),
      (.openPrice // 0),
      (.closePrice // 0),
      (.tp // 0),
      (.sl // 0),
      (.pnlUsdc // 0),
      (.roi // 0),
      .orderId
    ] | @tsv
  ' | while IFS=$'\t' read -r timestamp eventType pair direction trader collat size lev entry exit tp sl pnl roi orderId; do

    # Convert timestamp to IST
    ist_time=$(utc_to_ist "$timestamp")

    # Truncate wallet address
    wallet_short="${trader:0:6}...${trader: -4}"

    # Format numbers
    collat_fmt=$(printf "%.0f" "$collat" 2>/dev/null || echo "-")
    size_fmt=$(printf "%.0f" "$size" 2>/dev/null || echo "-")
    lev_fmt=$([ "$lev" != "0" ] && echo "${lev}x" || echo "-")
    entry_fmt=$([ "$entry" != "0" ] && printf "%.2f" "$entry" 2>/dev/null || echo "-")
    exit_fmt=$([ "$exit" != "0" ] && printf "%.2f" "$exit" 2>/dev/null || echo "-")
    tp_fmt=$([ "$tp" != "0" ] && printf "%.2f" "$tp" 2>/dev/null || echo "-")
    sl_fmt=$([ "$sl" != "0" ] && printf "%.2f" "$sl" 2>/dev/null || echo "-")
    pnl_fmt=$([ "$pnl" != "0" ] && printf "\$%.2f" "$pnl" 2>/dev/null || echo "-")
    roi_fmt=$([ "$roi" != "0" ] && printf "%.2f%%" "$roi" 2>/dev/null || echo "-")

    # Color code by event type
    if [ "$eventType" == "OPEN" ]; then
      type_display="${GREEN}✅OPEN${NC} "
    else
      type_display="${RED}❌CLOSE${NC}"
    fi

    # Print row
    printf "%-16s  ${type_display}  %-8s  %-5s  %-12s  %-7s  %-7s  %-4s  %-9s  %-9s  %-9s  %-9s  %-10s  %-8s  %-10s\n" \
      "$ist_time" "$pair" "$direction" "$wallet_short" "$collat_fmt" "$size_fmt" "$lev_fmt" \
      "$entry_fmt" "$exit_fmt" "$tp_fmt" "$sl_fmt" "$pnl_fmt" "$roi_fmt" "$orderId"

  done

  echo ""
  echo -e "${BLUE}════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════${NC}"

  # Countdown timer
  for i in $(seq $REFRESH_INTERVAL -1 1); do
    printf "\r${YELLOW}Next refresh in: %02d seconds${NC} (Press Ctrl+C to stop)  " $i
    sleep 1
  done
  echo ""
done
