import json
from decimal import Decimal

from scripts.enrich_recent_amounts import (
    SETTLEMENT,
    amount_candidates,
    decode_dynamic_json,
    settlement_stablecoin,
    transfer,
)
from scripts.inspect_transactions import TRANSFER_TOPIC


def _topic(address: str) -> str:
    return "0x" + "0" * 24 + address[2:]


def _transfer(index: int, token: str, sender: str, receiver: str, raw: int):
    return {
        "logIndex": hex(index),
        "address": token,
        "topics": [TRANSFER_TOPIC, _topic(sender), _topic(receiver)],
        "data": hex(raw),
    }


def test_decode_dynamic_json() -> None:
    payload = json.dumps({"Source": "relay-fomo", "AmountOutUSD": "10.50"}, separators=(",", ":")).encode()
    padding = b"\0" * ((32 - len(payload) % 32) % 32)
    encoded = (32).to_bytes(32) + len(payload).to_bytes(32) + payload + padding
    assert decode_dynamic_json("0x" + encoded.hex())["AmountOutUSD"] == "10.50"


def test_amount_candidates_keeps_atomic_and_fee_comparisons() -> None:
    result = amount_candidates(Decimal("100"))
    assert result["atomic_usd"] == "100"
    assert result["minus_0_442_percent"] == "99.558000"
    assert result["grossed_up_0_442_percent"] == "100.443962"


def test_base_settlement_stablecoin_fallback_uses_nearest_leg() -> None:
    wallet = "0x" + "1" * 40
    token = "0x" + "2" * 40
    usdc = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
    receipt = {"logs": [
        _transfer(10, usdc, "0x" + "3" * 40, SETTLEMENT, 12_500_000),
        _transfer(12, token, SETTLEMENT, wallet, 100),
    ]}
    trade = {"chain": "base", "side": "BUY", "token_address_or_mint": token}
    amount, source, _ = settlement_stablecoin(receipt, trade, wallet)
    assert amount == Decimal("12.5")
    assert source == "receipt.nearest_settlement_stablecoin_transfer"


def test_transfer_accepts_empty_hex_data() -> None:
    log=_transfer(1,"0x"+"2"*40,"0x"+"3"*40,"0x"+"4"*40,0)
    log["data"]="0x"
    assert transfer(log)["raw_amount"]==0
