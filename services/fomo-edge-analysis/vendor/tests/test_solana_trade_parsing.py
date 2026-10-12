from scripts.parse_solana_trades import USDC_MINT, WSOL_MINT, trade_legs, wallet_token_deltas


WALLET = "Wallet111111111111111111111111111111111111"
TOKEN = "TokenMint111111111111111111111111111111111"


def balance(mint: str, amount: int, decimals: int) -> dict:
    return {
        "accountIndex": 1 if mint == TOKEN else 2,
        "mint": mint,
        "owner": WALLET,
        "programId": "TokenProgram",
        "uiTokenAmount": {"amount": str(amount), "decimals": decimals},
    }


def test_wallet_token_deltas_aggregate_by_owner_and_mint() -> None:
    transaction = {
        "meta": {
            "preTokenBalances": [balance(USDC_MINT, 10_000_000, 6)],
            "postTokenBalances": [
                balance(USDC_MINT, 5_000_000, 6),
                balance(TOKEN, 2_000_000_000, 9),
            ],
        }
    }
    deltas = wallet_token_deltas(transaction, WALLET)
    assert {item["mint"]: item["ui_delta"] for item in deltas} == {
        TOKEN: "2",
        USDC_MINT: "-5",
    }


def test_trade_leg_uses_opposite_quote_and_token_deltas() -> None:
    parsed = {
        "signature": "sig",
        "wallet_token_deltas": [
            {"mint": TOKEN, "raw_delta": "2000000000", "ui_delta": "2"},
            {"mint": USDC_MINT, "raw_delta": "-5000000", "ui_delta": "-5"},
        ],
    }
    legs = trade_legs(parsed)
    assert len(legs) == 1
    assert legs[0]["side"] == "BUY"
    assert legs[0]["quote_amount"] == "5"


def test_native_sol_purchase_uses_wallet_lamport_delta() -> None:
    parsed = {
        "signature": "sig",
        "wallet_lamport_delta": 86_581_034_826,
        "wallet_token_deltas": [
            {"mint": USDC_MINT, "raw_delta": "-9000000000", "ui_delta": "-9000"},
        ],
    }
    legs = trade_legs(parsed)
    assert len(legs) == 1
    assert legs[0]["side"] == "BUY"
    assert legs[0]["token_mint"] == WSOL_MINT
    assert legs[0]["token_amount"] == "86.581034826"
    assert legs[0]["native_lamport_balance"] is True
