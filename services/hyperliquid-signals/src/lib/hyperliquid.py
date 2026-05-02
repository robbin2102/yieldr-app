import logging
import asyncio
import aiohttp

logger = logging.getLogger(__name__)

LEADERBOARD_URL = "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard"
INFO_URL = "https://api.hyperliquid.xyz/info"

# The leaderboard payload is ~2MB — give it plenty of time
_LEADERBOARD_TIMEOUT = aiohttp.ClientTimeout(total=300, connect=15, sock_read=300)
_POSITION_TIMEOUT = aiohttp.ClientTimeout(total=20, connect=10)


async def fetch_leaderboard(session: aiohttp.ClientSession, retries: int = 3) -> list[dict]:
    last_exc: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            logger.info('"Fetching leaderboard", "attempt": %d', attempt)
            async with session.get(LEADERBOARD_URL, timeout=_LEADERBOARD_TIMEOUT) as resp:
                resp.raise_for_status()
                data = await resp.json(content_type=None)
            rows = data.get("leaderboardRows", [])
            logger.info('"Leaderboard fetched", "rows": %d', len(rows))
            return rows
        except Exception as e:
            last_exc = e
            logger.warning('"Leaderboard fetch failed", "attempt": %d, "error": "%s"', attempt, e)
            if attempt < retries:
                await asyncio.sleep(5 * attempt)
    raise RuntimeError(f"Leaderboard fetch failed after {retries} attempts") from last_exc


async def fetch_positions(
    session: aiohttp.ClientSession,
    address: str,
    semaphore: asyncio.Semaphore,
) -> list[dict]:
    async with semaphore:
        try:
            async with session.post(
                INFO_URL,
                json={"type": "clearinghouseState", "user": address},
                timeout=_POSITION_TIMEOUT,
            ) as resp:
                resp.raise_for_status()
                data = await resp.json(content_type=None)
            return data.get("assetPositions", [])
        except Exception as e:
            logger.warning('"fetch_positions error", "address": "%s", "error": "%s"', address, e)
            return []


async def fetch_funding_rates(session: aiohttp.ClientSession) -> dict[str, float]:
    """Return coin → current funding rate from Hyperliquid metaAndAssetCtxs."""
    try:
        async with session.post(
            INFO_URL,
            json={"type": "metaAndAssetCtxs"},
            timeout=_POSITION_TIMEOUT,
        ) as resp:
            resp.raise_for_status()
            data = await resp.json(content_type=None)
        meta, asset_ctxs = data[0], data[1]
        universe = meta.get("universe", [])
        result: dict[str, float] = {}
        for asset, ctx in zip(universe, asset_ctxs):
            try:
                result[asset["name"]] = float(ctx.get("funding", 0))
            except (KeyError, TypeError, ValueError):
                pass
        return result
    except Exception as e:
        logger.warning('"fetch_funding_rates error", "error": "%s"', e)
        return {}
