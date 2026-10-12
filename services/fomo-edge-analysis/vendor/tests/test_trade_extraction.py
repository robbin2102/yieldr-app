from scripts.extract_fomo_trades import (
    ENTRYPOINT_V08,
    USER_OPERATION_EVENT,
    decode_user_operation,
)


WALLET = "0xdbea0f1d234240e8f8a884cf0461371b3ec2dbcc"


def padded_address(address: str) -> str:
    return "0x" + "0" * 24 + address[2:]


def word(value: int) -> str:
    return f"{value:064x}"


def test_decode_user_operation_indexes_wallet_as_sender() -> None:
    receipt = {
        "logs": [
            {
                "address": ENTRYPOINT_V08,
                "topics": [
                    USER_OPERATION_EVENT,
                    "0x" + "ab" * 32,
                    padded_address(WALLET),
                    padded_address("0x0000000000000000000000000000000000000000"),
                ],
                "data": "0x" + word(7) + word(1) + word(0) + word(12345),
            }
        ]
    }
    result = decode_user_operation(receipt, WALLET)
    assert result is not None
    assert result["sender"] == WALLET
    assert result["success"] is True
    assert result["nonce"] == "7"
    assert result["actual_gas_used"] == "12345"
