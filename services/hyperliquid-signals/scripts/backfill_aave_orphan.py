"""One-off backfill for the orphaned AAVE leg (~0.16, entry ~67.006) that was
never written to ANY bot_positions document.

Root cause (fixed alongside this script in execution_bot.py): the entry
order-retry loop only ever stored the LATEST attempt's oid in
entry_order_id, overwriting earlier attempts. If an earlier attempt's order
filled "late" — after _get_fill reported "not filled" and we issued a (no-op)
cancel — that fill's oid was lost entirely. backfill_positions.py matches by
entry_order_id, so it could only recover the leg whose oid happened to be the
one left in the doc (the ~67.066 leg); this ~67.006 leg has no oid recorded
anywhere.

This script finds that orphan directly: an "Open Short"/"Open Long" AAVE fill
whose oid is not referenced by ANY existing AAVE bot_positions doc, and
inserts a new OPEN row for it, copying strategy/leverage/size_usdc/env from
the sibling AAVE position that *was* tracked.

Usage:
    python -m scripts.backfill_aave_orphan [--apply]
    (without --apply, only prints what WOULD be inserted)
"""
import asyncio
import sys
from datetime import datetime, timezone, timedelta

sys.path.insert(0, ".")
from src.config import settings  # noqa: E402
from src.db import get_db  # noqa: E402
from src.lib import hl_exchange as ex  # noqa: E402
from src.api.trade_alerts import STRATEGY_META  # noqa: E402

COIN = "AAVE"


async def main(apply: bool) -> None:
    db = get_db()
    fills = await ex.get_user_fills(300)
    coin_fills = [f for f in fills if f.get("coin") == COIN]

    known_oids: set[int] = set()
    sibling = None
    async for pos in db.bot_positions.find({"coin": COIN}):
        oids = pos.get("entry_order_ids") or []
        if pos.get("entry_order_id"):
            oids = [*oids, pos["entry_order_id"]]
        for oid in oids:
            try:
                known_oids.add(int(oid))
            except (TypeError, ValueError):
                pass
        if sibling is None and pos.get("status") in ("OPEN", "CLOSED"):
            sibling = pos

    print(f"Known AAVE oids in bot_positions: {known_oids}")
    if sibling:
        print(f"Sibling AAVE doc: _id={sibling['_id']} status={sibling['status']} "
              f"strategy={sibling.get('strategy')} entry_px={sibling.get('entry_px')}")

    opens = [f for f in coin_fills if str(f.get("dir", "")).startswith("Open")]
    orphans = [f for f in opens if int(f.get("oid", -1)) not in known_oids]

    if not orphans:
        print("No orphan AAVE 'Open' fills found — nothing to backfill.")
        return

    for f in orphans:
        side = "SHORT" if str(f["dir"]).endswith("Short") else "LONG"
        entry_px = float(f["px"])
        size_coin = float(f["sz"])
        entry_ts = datetime.utcfromtimestamp(int(f["time"]) / 1000)
        oid = int(f["oid"])

        strategy = sibling.get("strategy") if sibling else "WHALE_SCALEUP_4H"
        leverage = sibling.get("leverage") if sibling else 10
        size_usdc = sibling.get("size_usdc") if sibling else round(entry_px * size_coin, 2)
        env = sibling.get("env") if sibling else ("testnet" if settings.bot_testnet else "mainnet")
        hold_hours = STRATEGY_META.get(strategy, {}).get("hold_hours") or 4
        hold_until = entry_ts + timedelta(hours=hold_hours)

        print(f"\nOrphan fill: oid={oid} dir={f['dir']} side={side} entry_px={entry_px} "
              f"size_coin={size_coin} entry_ts={entry_ts}")
        print(f"  -> insert OPEN strategy={strategy} leverage={leverage} "
              f"size_usdc={size_usdc} env={env} hold_until={hold_until}")

        if apply:
            now = datetime.now(timezone.utc)
            await db.bot_positions.insert_one({
                "strategy": strategy, "coin": COIN, "side": side,
                "status": "OPEN", "signal_px": entry_px, "alert_id": None,
                "size_usdc": size_usdc, "size_coin": size_coin,
                "leverage": leverage, "env": env,
                "entry_order_id": str(oid), "entry_order_ids": [str(oid)],
                "entry_px": entry_px, "entry_ts": entry_ts,
                "hold_until": hold_until, "exit_order_id": None, "exit_px": None,
                "exit_ts": None, "exit_reason": None, "return_pct": None,
                "pnl_usdc": None, "fees_usdc": None,
                "skip_reason": "backfilled_orphan_leg",
                "agent_call_id": None, "created_at": now, "updated_at": now,
            })
            print("  -> inserted OPEN")

    if not apply:
        print("\n(dry run — re-run with --apply to write these changes)")


if __name__ == "__main__":
    asyncio.run(main(apply="--apply" in sys.argv))
