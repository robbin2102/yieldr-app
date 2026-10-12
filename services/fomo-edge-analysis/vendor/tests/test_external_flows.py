from fomo_analysis.external_flows import extract_evm_external_flows


WALLET = "0x288c3eadfdbef55ac51fed48272c757a899d5045"

def transfer(tx, sender, recipient, token="0xabc", value="0x64"):
    return {
        "hash": tx, "uniqueId": f"{tx}:1", "from": sender, "to": recipient,
        "metadata": {"blockTimestamp": "2026-01-01T00:00:00.000Z"},
        "rawContract": {"address": token, "value": value, "decimal": "0x0"},
    }


def test_external_transfer_is_logged_but_fomo_transaction_is_excluded():
    settlement = "0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f"
    rows = [
        transfer("external", "0xsender", WALLET),
        transfer("fomo", settlement, WALLET),
        transfer("fomo", "0xbonus", WALLET, token="0xdef"),
    ]
    result = extract_evm_external_flows("base", rows, WALLET)
    assert len(result) == 1
    assert result[0].direction == "IN"
    assert str(result[0].quantity) == "100"
