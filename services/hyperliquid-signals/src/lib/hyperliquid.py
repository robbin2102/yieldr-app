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
    retries: int = 3,
) -> list[dict] | None:
    """Returns None (not []) on any failure — callers must treat that as
    "couldn't check this address this cycle" and skip it, not as "confirmed
    zero positions". Conflating the two previously meant a transient 429
    silently got written as a sentinel "trader is flat" snapshot doc."""
    async with semaphore:
        for attempt in range(1, retries + 1):
            try:
                async with session.post(
                    INFO_URL,
                    json={"type": "clearinghouseState", "user": address},
                    timeout=_POSITION_TIMEOUT,
                ) as resp:
                    if resp.status == 429:
                        wait = 2 ** attempt
                        logger.warning('"fetch_positions 429", "address": "%s", "attempt": %d, "sleep": %d',
                                       address, attempt, wait)
                        await asyncio.sleep(wait)
                        continue
                    resp.raise_for_status()
                    data = await resp.json(content_type=None)
                return data.get("assetPositions", [])
            except Exception as e:
                logger.warning('"fetch_positions error", "address": "%s", "error": "%s"', address, e)
                return None
        logger.warning('"fetch_positions giving up after %d retries (429)", "address": "%s"', retries, address)
        return None


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


async def fetch_all_mids(session: aiohttp.ClientSession) -> dict[str, float]:
    """Return coin → current mid price for every perp on Hyperliquid."""
    try:
        async with session.post(
            INFO_URL,
            json={"type": "allMids"},
            timeout=_POSITION_TIMEOUT,
        ) as resp:
            resp.raise_for_status()
            data = await resp.json(content_type=None)
        return {coin: float(px) for coin, px in data.items() if not coin.startswith("@")}
    except Exception as e:
        logger.warning('"fetch_all_mids error", "error": "%s"', e)
        return {}


async def fetch_candles(
    session: aiohttp.ClientSession,
    coin: str,
    interval: str,
    start_ms: int,
    end_ms: int,
    retries: int = 5,
) -> list[dict]:
    """Fetch historical candles for a coin. Retries on 429 with exponential backoff."""
    for attempt in range(1, retries + 1):
        try:
            async with session.post(
                INFO_URL,
                json={
                    "type": "candleSnapshot",
                    "req": {"coin": coin, "interval": interval, "startTime": start_ms, "endTime": end_ms},
                },
                timeout=aiohttp.ClientTimeout(total=60, connect=10),
            ) as resp:
                if resp.status == 429:
                    wait = 2 ** attempt
                    logger.warning('"fetch_candles 429", "coin": "%s", "attempt": %d, "sleep": %d', coin, attempt, wait)
                    await asyncio.sleep(wait)
                    continue
                resp.raise_for_status()
                return await resp.json(content_type=None)
        except asyncio.TimeoutError:
            logger.warning('"fetch_candles timeout", "coin": "%s", "attempt": %d', coin, attempt)
            await asyncio.sleep(2 ** attempt)
        except Exception as e:
            logger.warning('"fetch_candles error", "coin": "%s", "error": "%s"', coin, e)
            return []
    logger.warning('"fetch_candles giving up after %d retries", "coin": "%s"', retries, coin)
    return []
