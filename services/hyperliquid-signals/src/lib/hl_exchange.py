"""Hyperliquid exchange client — L2 book, order placement, fills, account state."""
import asyncio
import functools
import logging
import math

import aiohttp

from ..config import settings

logger = logging.getLogger(__name__)

_HL_MAINNET = "https://api.hyperliquid.xyz"
_HL_TESTNET = "https://api.hyperliquid-testnet.xyz"

# requests (used by the hyperliquid SDK's Exchange/Info classes) has no
# default timeout — a dead connection (e.g. after the host sleeps/wakes)
# can hang a thread forever, permanently stalling the bot_close_expired
# job (max_instances=1) and leaving expired positions OPEN. Patch every
# SDK HTTP call to time out.
_SDK_HTTP_TIMEOUT_S = 10


def api_url() -> str:
    return _HL_TESTNET if settings.bot_testnet else _HL_MAINNET


def _with_timeout(client):
    client.session.request = functools.partial(client.session.request, timeout=_SDK_HTTP_TIMEOUT_S)
    return client


async def get_all_mids() -> dict[str, float]:
    """Return coin → current mid price, from the same network the bot trades on.

    Unlike lib.hyperliquid.fetch_all_mids (always mainnet, used for cohort
    signal detection), this respects BOT_TESTNET so mark prices for open bot
    positions match the venue the position actually lives on.
    """
    async with aiohttp.ClientSession() as session:
        async with session.post(
            f"{api_url()}/info",
            json={"type": "allMids"},
            timeout=aiohttp.ClientTimeout(total=5),
        ) as resp:
            resp.raise_for_status()
            data = await resp.json(content_type=None)
    return {coin: float(px) for coin, px in data.items() if not coin.startswith("@")}


# ── L2 book (async) ───────────────────────────────────────────────────────────

async def get_l2_book(coin: str) -> dict:
    """Returns mid, best_bid, best_ask, spread_bps, bids/asks as (px, sz) lists."""
    async with aiohttp.ClientSession() as session:
        async with session.post(
            f"{api_url()}/info",
            json={"type": "l2Book", "coin": coin},
            timeout=aiohttp.ClientTimeout(total=5),
        ) as resp:
            resp.raise_for_status()
            book = await resp.json()

    # HL occasionally returns a JSON `null` body instead of a book on
    # testnet — book.get(...) on None raised an opaque "'NoneType' object
    # has no attribute 'get'" instead of the ValueError callers already
    # retry on below.
    levels = (book or {}).get("levels", [])
    if len(levels) < 2 or not levels[0] or not levels[1]:
        raise ValueError(f"Empty orderbook for {coin}")

    best_bid = float(levels[0][0]["px"])
    best_ask = float(levels[1][0]["px"])
    mid = (best_bid + best_ask) / 2.0

    return {
        "mid":        mid,
        "best_bid":   best_bid,
        "best_ask":   best_ask,
        "spread_bps": round((best_ask - best_bid) / mid * 10_000, 3),
        "bids":       [(float(b["px"]), float(b["sz"])) for b in levels[0]],
        "asks":       [(float(a["px"]), float(a["sz"])) for a in levels[1]],
    }


# ── Asset metadata cache ──────────────────────────────────────────────────────

_meta_cache: dict[str, dict] | None = None


async def get_asset_meta() -> dict[str, dict]:
    """Returns {coin: {szDecimals, maxLeverage}}. Cached for process lifetime."""
    global _meta_cache
    if _meta_cache is not None:
        return _meta_cache
    async with aiohttp.ClientSession() as session:
        async with session.post(
            f"{api_url()}/info",
            json={"type": "meta"},
            timeout=aiohttp.ClientTimeout(total=5),
        ) as resp:
            resp.raise_for_status()
            meta = await resp.json()
    _meta_cache = {
        a["name"]: {"szDecimals": a["szDecimals"], "maxLeverage": a.get("maxLeverage", 20)}
        for a in meta.get("universe", [])
    }
    logger.info("asset meta cached: %d coins", len(_meta_cache))
    return _meta_cache


# ── Account equity (async) ────────────────────────────────────────────────────

async def get_clearinghouse_state(address: str) -> dict | None:
    async with aiohttp.ClientSession() as session:
        async with session.post(
            f"{api_url()}/info",
            json={"type": "clearinghouseState", "user": address},
            timeout=aiohttp.ClientTimeout(total=5),
        ) as resp:
            if not resp.ok:
                return None
            return await resp.json()


async def get_account_equity() -> float | None:
    addr = settings.hl_wallet_address
    if not addr:
        return None
    state = await get_clearinghouse_state(addr)
    if state is None:
        return None
    try:
        return float(state["crossMarginSummary"]["accountValue"])
    except (KeyError, TypeError):
        return None


# ── Helpers ───────────────────────────────────────────────────────────────────

def round_sz(sz: float, sz_decimals: int) -> float:
    """Floor-round to prevent exceeding budget."""
    factor = 10 ** sz_decimals
    return math.floor(sz * factor) / factor


def round_px(px: float) -> float:
    """5 significant figures (Hyperliquid convention)."""
    if px <= 0:
        return px
    mag = math.floor(math.log10(abs(px)))
    return round(px, -mag + 4)


def extract_oid(sdk_result: dict) -> int | None:
    try:
        for s in sdk_result["response"]["data"]["statuses"]:
            if "resting" in s:
                return int(s["resting"]["oid"])
    except (KeyError, TypeError, ValueError):
        pass
    return None


# ── SDK wrappers (sync → asyncio.to_thread) ───────────────────────────────────

def _make_exchange():
    from eth_account import Account
    from hyperliquid.exchange import Exchange
    return _with_timeout(Exchange(Account.from_key(settings.hl_private_key), api_url()))


def _make_info():
    from hyperliquid.info import Info
    return _with_timeout(Info(api_url(), skip_ws=True))


def signing_address() -> str:
    """The address that HL_PRIVATE_KEY signs orders as — should match
    HL_WALLET_ADDRESS unless that key belongs to an API/agent wallet."""
    from eth_account import Account
    return Account.from_key(settings.hl_private_key).address


async def set_leverage(coin: str, leverage: int, is_cross: bool = True) -> dict:
    """Set leverage for a coin. Call once before first order on that coin."""
    def _set():
        return _make_exchange().update_leverage(leverage, coin, is_cross)
    result = await asyncio.to_thread(_set)
    logger.info("leverage set %s %dx cross=%s → %s", coin, leverage, is_cross, result.get("status"))
    return result


async def place_limit_order(
    coin: str,
    is_buy: bool,
    sz_usdc: float,
    limit_px: float,
    post_only: bool = True,
) -> tuple[dict, float, float]:
    """
    Place limit order. Returns (sdk_result, limit_px_used, sz_coin).
    post_only=True uses ALO (Add Liquidity Only — always maker).
    """
    meta = await get_asset_meta()
    sz_dec = meta.get(coin, {}).get("szDecimals", 4)
    px = round_px(limit_px)
    sz = round_sz(sz_usdc / px, sz_dec)
    if sz <= 0:
        raise ValueError(f"computed sz={sz} for {coin} at {px}")

    tif = "Alo" if post_only else "Gtc"

    def _place():
        return _make_exchange().order(coin, is_buy, sz, px, {"limit": {"tif": tif}})

    result = await asyncio.to_thread(_place)
    logger.info("order %s %s is_buy=%s sz=%.6f px=%.6g → %s",
                tif, coin, is_buy, sz, px, result.get("status"))
    return result, px, sz


async def cancel_order(coin: str, oid: int) -> dict:
    def _cancel():
        return _make_exchange().cancel(coin, oid)
    return await asyncio.to_thread(_cancel)


async def place_limit_order_close(
    coin: str,
    is_long: bool,
    sz_coin: float,
    limit_px: float,
    tif: str = "Alo",
) -> tuple[dict, float, float]:
    """Reduce-only limit order at limit_px to close a position.
    is_long=True → selling (is_buy=False). is_long=False → buying (is_buy=True).
    tif="Alo" (default) posts maker-only; tif="Ioc" crosses the book as a
    taker fallback to guarantee the exit fills.
    Returns (sdk_result, px_used, sz_used).
    """
    meta = await get_asset_meta()
    sz_dec = meta.get(coin, {}).get("szDecimals", 4)
    is_buy = not is_long  # sell to close long, buy to close short
    px = round_px(limit_px)
    sz = round_sz(sz_coin, sz_dec)
    if sz <= 0:
        raise ValueError(f"computed sz={sz} for close {coin}")

    def _place():
        return _make_exchange().order(
            coin, is_buy, sz, px, {"limit": {"tif": tif}}, reduce_only=True
        )
    result = await asyncio.to_thread(_place)
    logger.info("%s close %s is_buy=%s sz=%.6f px=%.6g → %s",
                tif, coin, is_buy, sz, px, result.get("status"))
    return result, px, sz


def extract_fill(sdk_result: dict) -> tuple[bool, float, float]:
    """Extract (filled, avg_px, sz) from an order response's "filled" status —
    used for IOC taker orders, which fill immediately rather than resting."""
    try:
        for s in sdk_result["response"]["data"]["statuses"]:
            if "filled" in s:
                f = s["filled"]
                return True, float(f["avgPx"]), float(f["totalSz"])
    except (KeyError, TypeError, ValueError):
        pass
    return False, 0.0, 0.0


async def get_open_orders(address: str | None = None) -> list[dict]:
    def _fetch():
        return _make_info().open_orders(address or settings.hl_wallet_address)
    return await asyncio.to_thread(_fetch) or []


async def get_user_fills(limit: int = 50, address: str | None = None) -> list[dict]:
    def _fetch():
        return _make_info().user_fills(address or settings.hl_wallet_address)
    fills = await asyncio.to_thread(_fetch)
    return (fills or [])[:limit]
