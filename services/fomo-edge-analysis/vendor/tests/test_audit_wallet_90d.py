from datetime import datetime, timezone

from scripts.audit_wallet_90d import iso_time, transfer_amount


def test_iso_time_accepts_alchemy_z_timestamp() -> None:
    assert iso_time("2026-09-07T00:00:00Z") == datetime(2026, 9, 7, tzinfo=timezone.utc)


def test_transfer_amount_fetches_and_caches_missing_decimals() -> None:
    class Rpc:
        calls = 0

        def call(self, method, params):
            self.calls += 1
            assert method == "eth_call"
            return "0x12"

    rpc = Rpc()
    transfer = {"rawContract": {"address": "0xToken", "value": "0xde0b6b3a7640000", "decimal": None}}
    cache = {}
    assert transfer_amount(transfer, rpc, cache) == "1"
    assert transfer_amount(transfer, rpc, cache) == "1"
    assert rpc.calls == 1
