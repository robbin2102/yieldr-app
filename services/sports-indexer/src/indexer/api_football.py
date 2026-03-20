"""API-Football client with request counting and budget awareness."""

import logging
from datetime import datetime, timezone
import httpx
from src.config import API_FOOTBALL_KEY, API_FOOTBALL_BASE_URL

logger = logging.getLogger(__name__)


class APIFootballClient:
    """Async client for api-sports.io with per-request logging to MongoDB."""

    def __init__(self, db):
        self.db = db
        self.base_url = API_FOOTBALL_BASE_URL
        self.headers = {"x-apisports-key": API_FOOTBALL_KEY}
        self._client = httpx.AsyncClient(
            base_url=self.base_url,
            headers=self.headers,
            timeout=30.0,
        )

    async def close(self):
        await self._client.aclose()

    async def _request(self, endpoint: str, params: dict, phase: str = "") -> dict | None:
        """Make a request and log it. Returns response dict or None on error."""
        from src.indexer.budget import BudgetTracker
        tracker = BudgetTracker(self.db)
        if not await tracker.can_make_request():
            logger.warning(f"Budget exhausted — skipping {endpoint}")
            return None

        try:
            resp = await self._client.get(endpoint, params=params)
            status = resp.status_code
            data = resp.json() if status == 200 else {}
        except Exception as e:
            logger.error(f"API-Football request failed: {endpoint} — {e}")
            status = 500
            data = {}

        # Log the request
        daily_count = await tracker.get_today_count() + 1
        await self.db.request_log.insert_one({
            "timestamp": datetime.now(timezone.utc),
            "endpoint": endpoint,
            "params": params,
            "source": "indexer",
            "phase": phase,
            "status_code": status,
            "daily_count": daily_count,
        })

        if status != 200:
            logger.error(f"API-Football {endpoint} returned {status}")
            return None

        errors = data.get("errors")
        if errors:
            logger.error(f"API-Football errors: {errors}")
            return None

        return data

    # ── Discovery ──

    async def get_fixtures_by_date(self, league_id: int, season: int, date: str, phase: str = "discovery") -> list:
        """Get fixtures for a specific date. date format: YYYY-MM-DD"""
        data = await self._request("/fixtures", {
            "league": league_id, "season": season, "date": date
        }, phase=phase)
        return data.get("response", []) if data else []

    async def get_fixtures_by_round(self, league_id: int, season: int, round_str: str, phase: str = "discovery") -> list:
        """Get fixtures for a specific round."""
        data = await self._request("/fixtures", {
            "league": league_id, "season": season, "round": round_str
        }, phase=phase)
        return data.get("response", []) if data else []

    async def get_next_fixtures(self, league_id: int, season: int, count: int = 10, phase: str = "discovery") -> list:
        """Get next N upcoming fixtures for a league."""
        data = await self._request("/fixtures", {
            "league": league_id, "season": season, "next": count
        }, phase=phase)
        return data.get("response", []) if data else []

    # ── Standings ──

    async def get_standings(self, league_id: int, season: int, phase: str = "phase_1") -> list:
        """Get league standings."""
        data = await self._request("/standings", {
            "league": league_id, "season": season
        }, phase=phase)
        if not data:
            return []
        resp = data.get("response", [])
        if resp and resp[0].get("league", {}).get("standings"):
            return resp[0]["league"]["standings"][0]
        return []

    # ── Team Form ──

    async def get_team_fixtures(self, team_id: int, season: int, last: int = 10, phase: str = "phase_1") -> list:
        """Get last N fixtures for a team (includes basic stats)."""
        data = await self._request("/fixtures", {
            "team": team_id, "season": season, "last": last
        }, phase=phase)
        return data.get("response", []) if data else []

    # ── Head to Head ──

    async def get_h2h(self, team1_id: int, team2_id: int, last: int = 20, phase: str = "phase_1") -> list:
        """Get head-to-head results."""
        data = await self._request("/fixtures/headtohead", {
            "h2h": f"{team1_id}-{team2_id}", "last": last
        }, phase=phase)
        return data.get("response", []) if data else []

    # ── Injuries ──

    async def get_injuries(self, fixture_id: int, phase: str = "phase_1") -> list:
        """Get injuries for a specific fixture."""
        data = await self._request("/injuries", {
            "fixture": fixture_id
        }, phase=phase)
        return data.get("response", []) if data else []

    # ── Predictions ──

    async def get_predictions(self, fixture_id: int, phase: str = "phase_1") -> dict | None:
        """Get API predictions for a fixture."""
        data = await self._request("/predictions", {
            "fixture": fixture_id
        }, phase=phase)
        resp = data.get("response", []) if data else []
        return resp[0] if resp else None

    # ── Odds (bookmaker odds from API-Football) ──

    async def get_odds(self, fixture_id: int, phase: str = "phase_1") -> list:
        """Get bookmaker odds for a fixture."""
        data = await self._request("/odds", {
            "fixture": fixture_id
        }, phase=phase)
        return data.get("response", []) if data else []

    # ── Lineups ──

    async def get_lineups(self, fixture_id: int, phase: str = "phase_2") -> list:
        """Get lineups for a fixture (available ~1hr before kickoff)."""
        data = await self._request("/fixtures/lineups", {
            "fixture": fixture_id
        }, phase=phase)
        return data.get("response", []) if data else []

    # ── Live Match Statistics ──

    async def get_fixture_statistics(self, fixture_id: int, phase: str = "phase_3") -> list:
        """Get live match statistics."""
        data = await self._request("/fixtures/statistics", {
            "fixture": fixture_id
        }, phase=phase)
        return data.get("response", []) if data else []

    # ── Live Fixture Status ──

    async def get_fixture(self, fixture_id: int, phase: str = "phase_3") -> dict | None:
        """Get single fixture details (score, status, events)."""
        data = await self._request("/fixtures", {
            "id": fixture_id
        }, phase=phase)
        resp = data.get("response", []) if data else []
        return resp[0] if resp else None
