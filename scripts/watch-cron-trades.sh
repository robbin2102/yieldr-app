#!/bin/bash
# Auto-refreshing trade monitor for Avantis cron job
# Refreshes every 3 minutes (180 seconds)

API_URL="https://yieldr-app.vercel.app/api/avantis/cron-history"

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Store all trades seen in this session
SESSION_HISTORY_FILE="/tmp/avantis_session_history.json"
touch "$SESSION_HISTORY_FILE"

# Function to convert UTC to IST
utc_to_ist() {
  local utc_time="$1"
  # Extract date and time parts
  local date_part=$(echo "$utc_time" | cut -d'T' -f1)
  local time_part=$(echo "$utc_time" | cut -d'T' -f2 | cut -d'.' -f1)

  # Convert to IST (UTC+5:30)
  date -d "$date_part $time_part UTC + 5 hours 30 minutes" "+%H:%M:%S" 2>/dev/null || echo "$time_part"
}

iteration=0

while true; do
  iteration=$((iteration + 1))
  clear
  echo -e "${BLUE}════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════${NC}"
  echo -e "${YELLOW}                                        AVANTIS TRADES MONITOR - AUTO REFRESH (3min)                                        ${NC}"
  echo -e "${CYAN}                                        Session: $iteration | Timezone: IST (India Standard Time)                                        ${NC}"
  echo -e "${BLUE}════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════${NC}"

  # Fetch data
  DATA=$(curl -s "$API_URL")

  # Display summary
  echo -e "\n${YELLOW}SUMMARY:${NC}"
  LAST_UPDATED=$(echo "$DATA" | jq -r '.summary.lastUpdated')
  LAST_UPDATED_IST=$(utc_to_ist "$LAST_UPDATED")
  echo "$DATA" | jq -r --arg time "$LAST_UPDATED_IST" '.summary | "  Last Updated: \($time) IST  |  Total Trades (Last Hour): \(.totalTrades)  |  Time Range: \(.timeRange)"'

  echo -e "\n${YELLOW}CRON WINDOWS (Vercel runs every 10 minutes):${NC}"
  echo "$DATA" | jq -r '.summary.cronWindows[] |
    "  " + (.windowStart | split("T")[1] | split(".")[0]) + " → " + (.windowEnd | split("T")[1] | split(".")[0]) + " UTC  |  Total: " + (.count | tostring) + "  (✅ " + (.opens | tostring) + " OPEN, ❌ " + (.closes | tostring) + " CLOSE)"'

  echo -e "\n${BLUE}════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════${NC}"
  echo -e "${YELLOW}LATEST TRADES (Last 60 minutes):${NC}"
  echo ""

  # Create detailed table with IST time
  CURRENT_TRADES=$(echo "$DATA" | jq -r '
    ["TIME (IST)", "TYPE", "PAIR", "DIR", "WALLET", "COLLAT", "SIZE", "LEV", "ENTRY", "EXIT", "TP", "SL", "PNL", "ROI%", "ORDER ID"],
    ["──────────", "─────", "───────", "─────", "──────────", "──────", "──────", "───", "────────", "────────", "────────", "────────", "───────", "─────", "────────"],
    (.trades[] | [
      .timestamp,
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
  ')

  # Convert UTC times to IST in the output
  while IFS=$'\t' read -r time type pair dir wallet collat size lev entry exit tp sl pnl roi orderid; do
    if [[ "$time" != "TIME (IST)" && "$time" != "──────────" ]]; then
      ist_time=$(utc_to_ist "$time")
      printf "%-10s\t%-5s\t%-7s\t%-5s\t%-10s\t%-6s\t%-6s\t%-3s\t%-8s\t%-8s\t%-8s\t%-8s\t%-7s\t%-5s\t%-8s\n" \
        "$ist_time" "$type" "$pair" "$dir" "$wallet" "$collat" "$size" "$lev" "$entry" "$exit" "$tp" "$sl" "$pnl" "$roi" "$orderid"
    else
      printf "%-10s\t%-5s\t%-7s\t%-5s\t%-10s\t%-6s\t%-6s\t%-3s\t%-8s\t%-8s\t%-8s\t%-8s\t%-7s\t%-5s\t%-8s\n" \
        "$time" "$type" "$pair" "$dir" "$wallet" "$collat" "$size" "$lev" "$entry" "$exit" "$tp" "$sl" "$pnl" "$roi" "$orderid"
    fi
  done <<< "$CURRENT_TRADES" | column -t

  # Append new trades to session history
  echo "$DATA" | jq -r '.trades[]' >> "$SESSION_HISTORY_FILE"

  # Display session history
  echo ""
  echo -e "${BLUE}════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════${NC}"
  echo -e "${YELLOW}SESSION HISTORY (All trades seen since start):${NC}"
  echo ""

  # Get unique trades from session history
  HISTORY_COUNT=$(cat "$SESSION_HISTORY_FILE" | jq -s 'unique_by(.orderId) | length' 2>/dev/null || echo "0")
  echo -e "${CYAN}Total unique trades captured this session: $HISTORY_COUNT${NC}"
  echo ""

  cat "$SESSION_HISTORY_FILE" | jq -s 'unique_by(.orderId) | sort_by(.timestamp) | reverse | .[] |
    [
      .timestamp,
      (if .eventType == "OPEN" then "✅ OPEN" else "❌ CLOSE" end),
      .pairSymbol,
      .direction,
      (.trader | split("")[:10] | join("")) + "...",
      (if .collateralUsdc then (.collateralUsdc | tostring) else "-" end),
      (if .positionSizeUsdc then (.positionSizeUsdc | tostring) else "-" end),
      (if .leverage then (.leverage | tostring) + "x" else "-" end),
      (if .pnlUsdc then ("$" + (.pnlUsdc | tonumber | . * 100 | round / 100 | tostring)) else "-" end),
      (if .roi then ((.roi | tonumber | . * 100 | round / 100 | tostring) + "%") else "-" end),
      .orderId
    ] | @tsv
  ' 2>/dev/null | while IFS=$'\t' read -r time type pair dir wallet collat size lev pnl roi orderid; do
    ist_time=$(utc_to_ist "$time")
    printf "%-10s\t%-7s\t%-7s\t%-5s\t%-10s\t%-6s\t%-6s\t%-3s\t%-7s\t%-5s\t%-8s\n" \
      "$ist_time" "$type" "$pair" "$dir" "$wallet" "$collat" "$size" "$lev" "$pnl" "$roi" "$orderid"
  done | head -20 | column -t

  echo ""
  echo -e "${BLUE}════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════${NC}"

  # Countdown timer
  for i in {180..1}; do
    mins=$((i / 60))
    secs=$((i % 60))
    printf "\r${YELLOW}Next refresh in: %02d:%02d${NC} (Press Ctrl+C to stop)  " $mins $secs
    sleep 1
  done
  echo ""
done
