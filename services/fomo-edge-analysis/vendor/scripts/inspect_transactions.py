"""Fetch transaction, receipt, and call-trace evidence for selected hashes."""

from __future__ import annotations

import argparse
from typing import Any

from scripts.rpc_utils import RpcClient, load_config, save_json


TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"


def topic_address(topic: str) -> str:
    return "0x" + topic[-40:].lower()


def summarize_receipt(receipt: dict[str, Any], wallet: str) -> dict[str, Any]:
    wallet_transfers = []
    for log in receipt.get("logs", []):
        topics = log.get("topics", [])
        if len(topics) < 3 or topics[0].lower() != TRANSFER_TOPIC:
            continue
        from_address = topic_address(topics[1])
        to_address = topic_address(topics[2])
        if wallet not in (from_address, to_address):
            continue
        wallet_transfers.append(
            {
                "log_index": int(log["logIndex"], 16),
                "token": log["address"].lower(),
                "from": from_address,
                "to": to_address,
                "raw_value": str(int(log.get("data", "0x0"), 16)),
            }
        )
    return {
        "status": int(receipt["status"], 16),
        "block_number": int(receipt["blockNumber"], 16),
        "transaction_from": receipt["from"].lower(),
        "transaction_to": (receipt.get("to") or "").lower(),
        "gas_used": int(receipt["gasUsed"], 16),
        "log_count": len(receipt.get("logs", [])),
        "wallet_erc20_transfers": wallet_transfers,
    }


def inspect(rpc: RpcClient, tx_hash: str, wallet: str) -> dict[str, Any]:
    transaction = rpc.call("eth_getTransactionByHash", [tx_hash])
    receipt = rpc.call("eth_getTransactionReceipt", [tx_hash])
    if not transaction or not receipt:
        raise RuntimeError(f"Transaction not found on {rpc.name}: {tx_hash}")
    try:
        trace = rpc.call("debug_traceTransaction", [tx_hash, {"tracer": "callTracer"}])
        trace_error = None
    except RuntimeError as exc:
        trace = None
        trace_error = str(exc)
    return {
        "hash": tx_hash,
        "transaction": transaction,
        "receipt": receipt,
        "trace": trace,
        "trace_error": trace_error,
        "summary": {
            "from": transaction["from"].lower(),
            "to": (transaction.get("to") or "").lower(),
            "input_selector": transaction.get("input", "")[:10],
            "transaction_type": int(transaction.get("type", "0x0"), 16),
            "has_authorization_list": bool(transaction.get("authorizationList")),
            **summarize_receipt(receipt, wallet),
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("chain", choices=("base", "robinhood"))
    parser.add_argument("hashes", nargs="+")
    args = parser.parse_args()
    chains, wallet = load_config()
    rpc = RpcClient(chains[args.chain], timeout=60)
    results = [inspect(rpc, tx_hash, wallet) for tx_hash in args.hashes]
    path = save_json(f"experiment4_{args.chain}_transactions.json", results)
    for result in results:
        summary = result["summary"]
        print(
            f"{args.chain} {result['hash']}: from={summary['from']} "
            f"to={summary['to']} selector={summary['input_selector']} "
            f"wallet_transfers={len(summary['wallet_erc20_transfers'])} "
            f"trace={'yes' if result['trace'] else 'no'}"
        )
    print(f"saved {path.relative_to(path.parent.parent)}")


if __name__ == "__main__":
    main()
