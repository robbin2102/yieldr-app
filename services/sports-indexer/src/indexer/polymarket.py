"""Polymarket CLOB client — free, no auth, no rate limit."""

import logging
from datetime import datetime, timezone
import httpx
from src.config import POLYMARKET_GAMMA_URL

logger = logging.getLogger(__name__)


class PolymarketClient:
    """Fetches prediction market data from Polymarket's Gamma API."""

    def __init__(self):
        self._client = httpx.AsyncClient(timeout=15.0)
        self.gamma_url = POLYMARKET_GAMMA_URL

    async def close(self):
        await self._client.aclose()

    async def search_markets(self, query: str, limit: int = 5) -> list:
        """Search Polymarket for sports markets matching a query.

        Use team names or match description, e.g. "Arsenal Manchester United".
        """
        try:
            resp = await self._client.get(
                f"{self.gamma_url}/events",
                params={"title": query, "limit": limit, "active": True, "closed": False},
            )
            if resp.status_code != 200:
                logger.warning(f"Polymarket search failed: {resp.status_code}")
                return []
            return resp.json()
        except Exception as e:
            logger.error(f"Polymarket search error: {e}")
            return []

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
                # Player prop
                for name, price in prices.items():
                    result["player_props"].append({
                        "player": name,
                        "market": title,
                        "price": price,
                    })

        result["volume"] = total_volume
        return result

    async def get_match_data(self, home_name: str, away_name: str) -> dict | None:
        """Full pipeline: search → find best match → extract prices."""
        query = f"{home_name} {away_name}"
        events = await self.search_markets(query)
        if not events:
            # Try shorter query
            events = await self.search_markets(
                f"{home_name.split()[-1]} {away_name.split()[-1]}"
            )
        if not events:
            return None

        best = self.find_best_match(events, home_name, away_name)
        if not best:
            return None

        return self.extract_prices(best)
