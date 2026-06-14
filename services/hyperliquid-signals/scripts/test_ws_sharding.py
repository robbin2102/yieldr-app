"""Test whether Hyperliquid's "Cannot track more than 30 total users" limit is
per-connection or per-IP.

Opens N separate websocket connections (separate `Info` instances) from this
one process/IP, shards a set of Q1 cohort addresses ~25 per connection, and
subscribes to `userFills` for each address plus `allMids` as a liveness probe
per connection.

If the limit is per-connection: every address on every connection should
receive its userFills snapshot, and allMids should keep arriving on all
connections.

If the limit is per-IP (shared across connections): only the first ~30
addresses across ALL connections (in subscribe order) will receive snapshots,
and/or later connections may get disconnected/throttled.

Usage:
    python -m scripts.test_ws_sharding [num_connections] [per_connection] [duration_s]
    (defaults: 2 connections, 25 addresses each, 45s)
"""
import asyncio
import sys
import time

sys.path.insert(0, ".")
from src.db import get_db  # noqa: E402
from src.lib.hl_exchange import api_url  # noqa: E402


async def main(num_conns: int, per_conn: int, duration_s: int) -> None:
    from hyperliquid.info import Info

    db = get_db()
    cursor = db.hl_signals_traders.find(
        {"cohort_status": "active", "skill_quartile": 1}, {"address": 1}
    ).limit(num_conns * per_conn)
    addrs = [doc["address"] async for doc in cursor]
    print(f"Fetched {len(addrs)} addresses, want {num_conns * per_conn} "
          f"({num_conns} conns x {per_conn} addrs)")

    if len(addrs) < num_conns * per_conn:
        print("WARNING: fewer addresses available than requested — shrinking shards")

    shards = [addrs[i * per_conn:(i + 1) * per_conn] for i in range(num_conns)]

    snapshots: dict[str, bool] = {a: False for a in addrs}
    mids_count: dict[int, int] = {i: 0 for i in range(num_conns)}

    def on_user_fills(addr, msg):
        try:
            if msg["data"].get("isSnapshot"):
                snapshots[addr] = True
        except (KeyError, TypeError):
            pass

    def on_all_mids(conn_idx, _msg):
        mids_count[conn_idx] += 1

    infos = []
    for i, shard in enumerate(shards):
        print(f"\n--- Connection {i}: connecting, subscribing {len(shard)} addresses ---")
        info = Info(api_url(), skip_ws=False)
        infos.append(info)
        try:
            info.subscribe({"type": "allMids"}, lambda msg, idx=i: on_all_mids(idx, msg))
        except Exception as e:
            print(f"  allMids subscribe failed: {e}")

        for addr in shard:
            try:
                info.subscribe({"type": "userFills", "user": addr},
                                lambda msg, a=addr: on_user_fills(a, msg))
            except Exception as e:
                print(f"  subscribe failed for {addr}: {e}")

    print(f"\nWaiting {duration_s}s for snapshots + allMids...")
    for elapsed in range(0, duration_s, 5):
        await asyncio.sleep(5)
        got = sum(1 for v in snapshots.values() if v)
        print(f"  t={elapsed+5:>3}s  snapshots: {got}/{len(addrs)}  "
              f"allMids per conn: {mids_count}")

    print("\n=== RESULTS ===")
    for i, shard in enumerate(shards):
        got = sum(1 for a in shard if snapshots[a])
        print(f"Connection {i}: {got}/{len(shard)} addresses got userFills snapshot, "
              f"allMids messages received: {mids_count[i]}")
        if got < len(shard):
            missing = [a for a in shard if not snapshots[a]]
            print(f"  missing: {missing}")

    for info in infos:
        try:
            info.disconnect_websocket()
        except Exception:
            pass


if __name__ == "__main__":
    num_conns    = int(sys.argv[1]) if len(sys.argv) > 1 else 2
    per_conn     = int(sys.argv[2]) if len(sys.argv) > 2 else 25
    duration_s   = int(sys.argv[3]) if len(sys.argv) > 3 else 45
    asyncio.run(main(num_conns, per_conn, duration_s))
