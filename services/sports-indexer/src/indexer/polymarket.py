"""Polymarket Gamma API client — free, no auth, no rate limit.

Polymarket has season-long outright markets (league winner, top scorer, etc.)
but typically NOT individual match markets for football/soccer.
"""

import logging
from datetime import datetime, timezone
import httpx
from src.config import POLYMARKET_GAMMA_URL

logger = logging.getLogger(__name__)

# Keywords to identify football/soccer events
FOOTBALL_KEYWORDS = [
    "premier league", "champions league", "la liga", "bundesliga",
    "serie a", "ligue 1", "europa league", "world cup", "euro 2",
    "fa cup", "carabao", "efl",
    # Team names
    "arsenal", "liverpool", "chelsea", "manchester", "tottenham",
    "barcelona", "real madrid", "bayern", "juventus", "psg",
    "inter milan", "ac milan", "napoli", "dortmund",
]


class PolymarketClient:
    """Fetches prediction market data from Polymarket's Gamma API."""

    def __init__(self):
        self._client = httpx.AsyncClient(timeout=15.0)
        self.gamma_url = POLYMARKET_GAMMA_URL

    async def close(self):
        await self._client.aclose()

    async def _fetch_events(self, limit: int = 100, offset: int = 0) -> list:
        """Fetch active events from Gamma API."""
        try:
            resp = await self._client.get(
                f"{self.gamma_url}/events",
                params={
                    "active": True,
                    "closed": False,
                    "limit": limit,
                    "offset": offset,
                },
            )
            if resp.status_code != 200:
                logger.warning(f"Polymarket fetch events failed: {resp.status_code}")
                return []
            return resp.json()
        except Exception as e:
            logger.error(f"Polymarket fetch events error: {e}")
            return []

    async def search_football_markets(self) -> list:
        """Fetch all active football/soccer markets from Polymarket.

        Since the API doesn't support text search without auth, we fetch
        events in batches and filter client-side by football keywords.
        """
        football_events = []
        for offset in range(0, 300, 100):
            events = await self._fetch_events(limit=100, offset=offset)
            if not events:
                break
            for event in events:
                title = (event.get("title") or "").lower()
                if any(kw in title for kw in FOOTBALL_KEYWORDS):
                    football_events.append(event)
        logger.info(f"Found {len(football_events)} football markets on Polymarket")
        return football_events

    async def search_markets(self, query: str, limit: int = 5) -> list:
        """Search for markets matching a text query (client-side filtering).

        Fetches active events and filters by whether the query terms
        appear in the event title.
        """
        query_lower = query.lower()
        query_words = query_lower.split()
        matched = []

        for offset in range(0, 300, 100):
            events = await self._fetch_events(limit=100, offset=offset)
            if not events:
                break
            for event in events:
                title = (event.get("title") or "").lower()
                if all(word in title for word in query_words):
                    matched.append(event)
                    if len(matched) >= limit:
                        return matched
        return matched

    async def get_event_by_slug(self, slug: str) -> dict | None:
        """Fetch a specific event by its slug."""
        try:
            resp = await self._client.get(f"{self.gamma_url}/events/slug/{slug}")
            if resp.status_code != 200:
                return None
            return resp.json()
        except Exception as e:
            logger.error(f"Polymarket get_event error: {e}")
            return None

    async def get_market(self, condition_id: str) -> dict | None:
        """Get a specific market by condition ID."""
        try:
            resp = await self._client.get(f"{self.gamma_url}/markets/{condition_id}")
            if resp.status_code != 200:
                return None
            return resp.json()
        except Exception as e:
            logger.error(f"Polymarket get_market error: {e}")
            return None

    def find_best_match(self, events: list, home_name: str, away_name: str) -> dict | None:
        """Find the event that best matches a fixture by team names."""
        home_lower = home_name.lower()
        away_lower = away_name.lower()

        for event in events:
            title = (event.get("title") or "").lower()
            if home_lower in title and away_lower in title:
                return event
            # Try shorter name forms
            home_short = home_lower.split()[-1]  # "Arsenal" from "Arsenal FC"
            away_short = away_lower.split()[-1]
            if home_short in title and away_short in title:
                return event
        return None

    def extract_prices(self, event: dict) -> dict:
        """Extract moneyline / totals / spread prices from event markets."""
        result = {
            "market_id": event.get("id"),
            "slug": event.get("slug"),
            "title": event.get("title"),
            "moneyline": {},
            "totals": {},
            "spreads": {},
            "player_props": [],
            "volume": 0,
            "last_updated": datetime.now(timezone.utc),
        }

        markets = event.get("markets", [])
        total_volume = 0

        for market in markets:
            title = (market.get("question") or market.get("groupItemTitle") or "").lower()
            outcomes = market.get("outcomes", [])
            outcome_prices = market.get("outcomePrices", [])

            # Parse prices
            prices = {}
            if outcome_prices and outcomes:
                str_prices = outcome_prices if isinstance(outcome_prices, list) else []
                for i, outcome in enumerate(outcomes):
                    if i < len(str_prices):
                        try:
                            prices[outcome.lower()] = float(str_prices[i])
                        except (ValueError, TypeError):
                            pass

            vol = float(market.get("volume", 0) or 0)
            total_volume += vol

            # Classify market type
            if any(kw in title for kw in ["winner", "win", "moneyline", "match result"]):
                if "home" in prices or "yes" in prices:
                    result["moneyline"] = {
                        "home_price": prices.get("home") or prices.get("yes"),
                        "away_price": prices.get("away") or prices.get("no"),
                    }
                elif len(prices) >= 2:
                    keys = list(prices.keys())
                    result["moneyline"] = {
                        "home_price": prices.get(keys[0]),
                        "away_price": prices.get(keys[1]) if len(keys) > 1 else None,
                    }
            elif "over" in title or "under" in title or "total" in title or "goals" in title:
                result["totals"] = {
                    "over_25_price": prices.get("over") or prices.get("yes"),
                    "under_25_price": prices.get("under") or prices.get("no"),
                }
            elif "spread" in title or "handicap" in title:
                result["spreads"] = prices
            elif "scorer" in title or "goal" in title:
                for name, price in prices.items():
                    result["player_props"].append({
                        "player": name,
                        "market": title,
                        "price": price,
                    })

        result["volume"] = total_volume
        return result

    def extract_outright_prices(self, event: dict) -> dict:
        """Extract prices from season-long outright markets (league winner, top scorer, etc.)."""
        result = {
            "market_id": event.get("id"),
            "slug": event.get("slug"),
            "title": event.get("title"),
            "outcomes": [],
            "volume": 0,
            "last_updated": datetime.now(timezone.utc),
        }

        markets = event.get("markets", [])
        total_volume = 0

        for market in markets:
            question = market.get("question") or market.get("groupItemTitle") or ""
            outcomes = market.get("outcomes", [])
            outcome_prices = market.get("outcomePrices", [])

            prices = {}
            if outcome_prices and outcomes:
                str_prices = outcome_prices if isinstance(outcome_prices, list) else []
                for i, outcome in enumerate(outcomes):
                    if i < len(str_prices):
                        try:
                            prices[outcome] = float(str_prices[i])
                        except (ValueError, TypeError):
                            pass

            vol = float(market.get("volume", 0) or 0)
            total_volume += vol

            if prices:
                result["outcomes"].append({
                    "question": question,
                    "prices": prices,
                    "volume": vol,
                })

        result["volume"] = total_volume
        return result

    async def get_match_data(self, home_name: str, away_name: str) -> dict | None:
        """Full pipeline: search → find best match → extract prices.

        Note: Polymarket typically doesn't have individual match markets
        for football. This will return None in most cases.
        """
        events = await self.search_markets(f"{home_name} {away_name}", limit=5)
        if not events:
            # Try shorter names
            short_query = f"{home_name.split()[-1]} {away_name.split()[-1]}"
            events = await self.search_markets(short_query, limit=5)
        if not events:
            return None

        best = self.find_best_match(events, home_name, away_name)
        if not best:
            return None

        return self.extract_prices(best)
