"""Sports indexer configuration — env vars and constants."""

import os
from pathlib import Path
from dotenv import load_dotenv

# Load env.local from project root (three levels up from src/)
_env_file = Path(__file__).resolve().parent.parent.parent.parent / "env.local"
load_dotenv(_env_file)

# API-Football
API_FOOTBALL_KEY = os.getenv("API_FOOTBALL_KEY", "")
API_FOOTBALL_BASE_URL = os.getenv("API_FOOTBALL_BASE_URL", "https://v3.football.api-sports.io")

# MongoDB
MONGODB_URI = os.getenv("MONGODB_URI", "")
MONGODB_DB = os.getenv("MONGODB_DB", "yieldr_sports")

# Polymarket
POLYMARKET_CLOB_URL = os.getenv("POLYMARKET_CLOB_URL", "https://clob.polymarket.com")
POLYMARKET_GAMMA_URL = os.getenv("POLYMARKET_GAMMA_URL", "https://gamma-api.polymarket.com")

# Leagues
PRIORITY_LEAGUES = [int(x) for x in os.getenv("PRIORITY_LEAGUES", "39").split(",")]
CURRENT_SEASON = int(os.getenv("CURRENT_SEASON", "2025"))

# Budget
MAX_TRACKED_MATCHES = int(os.getenv("MAX_TRACKED_MATCHES", "3"))
DAILY_API_LIMIT = int(os.getenv("DAILY_API_LIMIT", "95"))
AGENT_RESERVE = int(os.getenv("AGENT_RESERVE", "15"))
INDEXER_LIMIT = DAILY_API_LIMIT - AGENT_RESERVE  # 80

# Polling intervals
LIVE_POLL_INTERVAL_SEC = int(os.getenv("LIVE_POLL_INTERVAL_SEC", "900"))
POLYMARKET_POLL_INTERVAL_SEC = int(os.getenv("POLYMARKET_POLL_INTERVAL_SEC", "300"))
SCHEDULER_CHECK_INTERVAL_SEC = int(os.getenv("SCHEDULER_CHECK_INTERVAL_SEC", "300"))

# Server
PORT = int(os.getenv("PORT", "8080"))

# Known derbies (for match context)
KNOWN_DERBIES = {
    (42, 47): "North London Derby",       # Arsenal vs Tottenham
    (33, 34): "Manchester Derby",          # Man Utd vs Man City
    (40, 45): "Merseyside Derby",          # Liverpool vs Everton
    (49, 48): "West London Derby",         # Chelsea vs West Ham
    (42, 49): "London Derby",
    (47, 49): "London Derby",
}
