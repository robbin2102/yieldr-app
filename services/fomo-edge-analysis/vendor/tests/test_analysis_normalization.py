import json
from pathlib import Path

from fomo_analysis.normalization import load_normalized_trades


def test_normalizes_atomic_and_solana_usd_amounts(tmp_path: Path) -> None:
    audit = {
        "evm_wallet": "0xabc", "solana_wallet": "SolWallet", "trades": [
            {"timestamp": "2026-01-01T00:00:00Z", "chain": "base", "side": "BUY", "token_symbol": "A", "token_address_or_mint": "0xToken", "token_amount": "10", "quote_symbol": None, "quote_amount": None, "transaction_id": "0x1", "fomo_evidence": "event"},
            {"timestamp": "2026-01-01T00:05:00Z", "chain": "solana", "side": "BUY", "token_symbol": "B", "token_address_or_mint": "Mint", "token_amount": "4", "quote_symbol": "USDC", "quote_amount": "12", "transaction_id": "sig", "fomo_evidence": "delta"},
        ]}
    priced = {"trades": [{**audit["trades"][0], "atomic_usd": "20", "amount_source": "receipt"}]}
    audit_path = tmp_path / "trades.json"
    priced_path = tmp_path / "priced.json"
    audit_path.write_text(json.dumps(audit))
    priced_path.write_text(json.dumps(priced))
    _, trades = load_normalized_trades(audit_path, priced_path)
    assert [str(trade.usd_notional) for trade in trades] == ["20", "12"]
    assert [str(trade.execution_price_usd) for trade in trades] == ["2", "3"]


def test_leg_indexes_are_unique_with_multiple_tokens_in_one_transaction(tmp_path: Path) -> None:
    common = {"timestamp": "2026-01-01T00:00:00Z", "chain": "base", "side": "BUY", "token_symbol": "A", "token_amount": "1", "quote_symbol": None, "quote_amount": None, "transaction_id": "0x1", "fomo_evidence": "event"}
    audit = {"evm_wallet": "0xabc", "solana_wallet": "SolWallet", "trades": [
        {**common, "token_address_or_mint": "0xToken1"},
        {**common, "token_address_or_mint": "0xToken2"},
    ]}
    path = tmp_path / "trades.json"
    path.write_text(json.dumps(audit))
    _, trades = load_normalized_trades(path)
    assert [row.leg_index for row in trades] == [0, 1]
    assert len({row.trade_id for row in trades}) == 2
