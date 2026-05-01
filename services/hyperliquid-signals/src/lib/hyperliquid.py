import logging
import asyncio
import aiohttp

logger = logging.getLogger(__name__)

LEADERBOARD_URL = "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard"
INFO_URL = "https://api.hyperliquid.xyz/info"


async def fetch_leaderboard(session: aiohttp.ClientSession) -> list[dict]:
    async with session.get(LEADERBOARD_URL, timeout=aiohttp.ClientTimeout(total=30)) as resp:
        resp.raise_for_status()
        data = await resp.json(content_type=None)
    return data.get("leaderboardRows", [])


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
                timeout=aiohttp.ClientTimeout(total=15),
            ) as resp:
                resp.raise_for_status()
                data = await resp.json(content_type=None)
            return data.get("assetPositions", [])
        except Exception as e:
            logger.warning('"fetch_positions error", "address": "%s", "error": "%s"', address, e)
            return []
