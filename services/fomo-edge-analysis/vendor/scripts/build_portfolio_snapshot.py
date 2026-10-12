"""Build a live wallet valuation and 30-day FIFO P&L reconciliation."""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any

from fomo_analysis.coingecko import (
    COINGECKO_NETWORKS,
    CoinGeckoError,
    CoinGeckoOnchainClient,
    discover_network,
)
from fomo_analysis.config import load_analytics_config
from fomo_analysis.external_flows import (
    extract_external_flows,
    extract_solana_fomo_internal_funding,
    wallet_token_deltas_after,
)
from fomo_analysis.mongo_repository import MongoAnalysisRepository
from fomo_analysis.normalization import load_normalized_trades
from fomo_analysis.portfolio_accounting import (
    build_fifo_period_metrics,
    build_window_pnl_snapshot,
    rolling_trade_funding,
)
from scripts.rpc_utils import RpcClient, load_config, load_solana_config
from scripts.parse_solana_trades import WSOL_MINT


TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"


def evm_balances(rpc: RpcClient, wallet: str) -> list[dict[str, Any]]:
    raw = []
    page_key = None
    while True:
        params: list[Any] = [wallet, "erc20"]
        if page_key:
            params.append({"pageKey": page_key})
        result = rpc.call("alchemy_getTokenBalances", params)
        raw.extend(result.get("tokenBalances", []))
        page_key = result.get("pageKey")
        if not page_key:
            break
    nonzero = [row for row in raw if int(row.get("tokenBalance") or "0x0", 16)]
    metadata = []
    for start in range(0, len(nonzero), 50):
        group = nonzero[start : start + 50]
        metadata.extend(rpc.batch_call(
            "alchemy_getTokenMetadata",
            [[row["contractAddress"]] for row in group],
        ))
    result = []
    for raw_row, details in zip(nonzero, metadata, strict=True):
        decimals = details.get("decimals") if details else None
        if decimals is None:
            continue
        result.append({
            "token_address": raw_row["contractAddress"].lower(),
            "quantity": Decimal(int(raw_row["tokenBalance"], 16)) / (Decimal(10) ** decimals),
            "decimals": decimals,
            "symbol": details.get("symbol"),
            "name": details.get("name"),
        })
    return result


def solana_balances(rpc: RpcClient, wallet: str) -> list[dict[str, Any]]:
    totals: dict[str, dict[str, Any]] = {}
    for program in (TOKEN_PROGRAM, TOKEN_2022_PROGRAM):
        response = rpc.call("getTokenAccountsByOwner", [
            wallet, {"programId": program}, {"encoding": "jsonParsed"},
        ])
        for account in response.get("value", []):
            info = account["account"]["data"]["parsed"]["info"]
            mint = info["mint"]
            amount = info["tokenAmount"]
            item = totals.setdefault(mint, {
                "token_address": mint, "quantity": Decimal("0"),
                "decimals": int(amount["decimals"]), "symbol": None, "name": None,
            })
            item["quantity"] += Decimal(amount["uiAmountString"])
    native = rpc.call("getBalance", [wallet]).get("value", 0)
    if native:
        item = totals.setdefault(WSOL_MINT, {
            "token_address": WSOL_MINT, "quantity": Decimal("0"),
            "decimals": 9, "symbol": "SOL", "name": "Solana",
        })
        item["quantity"] += Decimal(native) / Decimal(1_000_000_000)
    return [row for row in totals.values() if row["quantity"] > 0]


def current_prices(
    addresses: dict[str, list[str]], client: CoinGeckoOnchainClient
) -> tuple[dict[tuple[str, str], Decimal], dict[str, str], list[dict[str, Any]]]:
    network_ids = dict(COINGECKO_NETWORKS)
    network = discover_network(client.all_networks(), ("robinhood", "robinhood chain"))
    if network is None:
        raise RuntimeError("CoinGecko network discovery did not return Robinhood Chain")
    network_ids["robinhood"] = network["id"]
    prices: dict[tuple[str, str], Decimal] = {}
    errors = []
    for chain, chain_addresses in addresses.items():
        unique = list(dict.fromkeys(chain_addresses))
        # The simple-price endpoint currently enforces 30 even when the
        # tokens/multi endpoint permits larger batches for the configured key.
        simple_price_batch_size = min(30, client.max_multi_tokens)
        for start in range(0, len(unique), simple_price_batch_size):
            group = unique[start : start + simple_price_batch_size]
            try:
                body = client.simple_prices_by_network_id(network_ids[chain], group)
                returned = body.get("data", {}).get("attributes", {}).get("token_prices", {})
                by_normalized = {str(key).lower(): value for key, value in returned.items()}
                for address in group:
                    value = returned.get(address)
                    if value is None:
                        value = by_normalized.get(address.lower())
                    if value is not None:
                        prices[(chain, address)] = Decimal(str(value))
            except CoinGeckoError as exc:
                errors.append({"chain": chain, "token_count": len(group), "error": str(exc)})
    return prices, network_ids, errors


def _serialize_adjustment(row) -> dict[str, Any]:
    return {
        "event_id": row.event_id, "chain": row.chain,
        "token_address": row.token_address, "timestamp": row.timestamp.isoformat(),
        "direction": row.direction, "quantity": format(row.quantity, "f"),
        "classification": row.classification,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("audit_json", type=Path)
    parser.add_argument("--days", type=int, default=30)
    parser.add_argument("--fomo-ui-portfolio-usd", type=Decimal)
    parser.add_argument("--fomo-ui-pnl-usd", type=Decimal)
    parser.add_argument("--persist", action="store_true")
    args = parser.parse_args()
    audit_path = args.audit_json
    priced_path = audit_path.parent / "recent_priced_trades.json"
    raw_path = audit_path.parent / "raw.json"
    audit, trades = load_normalized_trades(audit_path, priced_path)
    raw = json.loads(raw_path.read_text(encoding="utf-8"))
    chains, _ = load_config()
    solana_config, _ = load_solana_config()

    balances: dict[str, list[dict[str, Any]]] = {}
    rpc_metrics = {}
    for chain in ("base", "robinhood", "bnb"):
        rpc = RpcClient(chains[chain], timeout=90)
        balances[chain] = evm_balances(rpc, audit["evm_wallet"])
        rpc_metrics[chain] = {"http_requests": rpc.request_count, "seconds": round(rpc.elapsed_seconds, 3)}
    solana_rpc = RpcClient(solana_config, timeout=90)
    balances["solana"] = solana_balances(solana_rpc, audit["solana_wallet"])
    rpc_metrics["solana"] = {"http_requests": solana_rpc.request_count, "seconds": round(solana_rpc.elapsed_seconds, 3)}

    addresses = {chain: [row["token_address"] for row in rows] for chain, rows in balances.items()}
    config = load_analytics_config()
    client = CoinGeckoOnchainClient(
        config.coingecko_api_key, plan=config.coingecko_api_plan,
        min_interval_seconds=0.21 if config.coingecko_api_plan == "pro" else 0.65,
    )
    prices, network_ids, price_errors = current_prices(addresses, client)
    external = extract_external_flows(raw, audit["evm_wallet"], audit["solana_wallet"])
    internal_funding = extract_solana_fomo_internal_funding(
        raw.get("solana", []), audit["solana_wallet"]
    )
    valuation_time = datetime.now(timezone.utc)
    cutoff = valuation_time - timedelta(days=args.days)
    interval_days = (1, 7, 30, 60, 90)
    interval_snapshots = {
        days: build_window_pnl_snapshot(
            trades, valuation_time - timedelta(days=days), prices,
            valuation_time=valuation_time, inventory_adjustments=external,
        )
        for days in interval_days
    }
    snapshot = interval_snapshots.get(args.days) or build_window_pnl_snapshot(
        trades, cutoff, prices,
        valuation_time=valuation_time, inventory_adjustments=external,
    )
    interval_funding = {
        days: rolling_trade_funding(
            trades, window_start=valuation_time - timedelta(days=days)
        )
        for days in interval_days
    }
    funding = interval_funding.get(args.days) or rolling_trade_funding(
        trades, window_start=cutoff
    )
    symbols = {}
    for trade in trades:
        if trade.token_symbol:
            symbols[(trade.chain, trade.token_address)] = trade.token_symbol

    actual_positions = []
    ledger_positions = {
        (row["chain"], row["token_address"]): row
        for row in snapshot["open_positions"]
    }
    total_value = priced_value = Decimal("0")
    for chain, rows in balances.items():
        for row in rows:
            if not row.get("symbol"):
                row["symbol"] = symbols.get((chain, row["token_address"]))
            price = prices.get((chain, row["token_address"]))
            value = row["quantity"] * price if price is not None else None
            if value is not None:
                total_value += value
                if value >= Decimal("0.01"):
                    priced_value += value
            ledger = ledger_positions.get((chain, row["token_address"]), {})
            verified_quantity = Decimal(ledger.get("verified_purchase_quantity", "0"))
            external_quantity = Decimal(ledger.get("external_or_unknown_cost_quantity", "0"))
            explained_quantity = verified_quantity + external_quantity
            unreconciled_quantity = row["quantity"] - explained_quantity
            actual_positions.append({
                **{key: (format(value, "f") if isinstance(value, Decimal) else value) for key, value in row.items()},
                "chain": chain,
                "current_price_usd": None if price is None else format(price, "f"),
                "current_value_usd": None if value is None else format(value, "f"),
                "verified_fomo_purchase_quantity_ledger": format(verified_quantity, "f"),
                "external_receipt_quantity_ledger": format(external_quantity, "f"),
                "opening_or_unreconciled_quantity": format(unreconciled_quantity, "f"),
            })
    actual_positions.sort(
        key=lambda row: Decimal(row["current_value_usd"] or "-1"), reverse=True
    )
    external_summary = defaultdict(lambda: {"in_count": 0, "out_count": 0})
    for row in external:
        if row.timestamp < cutoff:
            continue
        key = (row.chain, row.token_address)
        external_summary[key]["in_count" if row.direction == "IN" else "out_count"] += 1

    current_quantities = {
        (row["chain"], row["token_address"]): Decimal(row["quantity"])
        for row in actual_positions
    }
    deltas = wallet_token_deltas_after(
        raw, audit["evm_wallet"], audit["solana_wallet"], cutoff
    )
    opening_quantities = {
        key: current_quantities.get(key, Decimal("0")) - delta
        for key, delta in deltas.items()
    }
    for key, quantity in current_quantities.items():
        opening_quantities.setdefault(key, quantity)
    opening_quantities = {
        key: quantity for key, quantity in opening_quantities.items() if quantity > 0
    }

    historical_prices: dict[tuple[str, str], Decimal] = {}
    historical_sources: dict[tuple[str, str], str] = {}
    interval_cutoff_prices: dict[int, dict[tuple[str, str], Decimal]] = {
        days: {} for days in interval_days
    }
    if config.mongodb_uri:
        repository = MongoAnalysisRepository(config.mongodb_uri, config.mongodb_database)
        try:
            repository.ping()
            candles = repository.load_price_candles_for_windows(
                [(chain, token, cutoff) for chain, token in opening_quantities],
                tolerance=timedelta(hours=6),
            )
            interval_windows = [
                (row["chain"], row["token_address"], valuation_time - timedelta(days=days))
                for days, interval_snapshot in interval_snapshots.items()
                for row in interval_snapshot["opening_fifo_inventory"]
                if Decimal(row["verified_quantity"]) > 0
            ]
            interval_candles = repository.load_price_candles_for_windows(
                interval_windows, tolerance=timedelta(hours=6)
            )
        finally:
            repository.close()
        for candle in candles:
            key = (candle.chain, candle.token_address)
            historical_prices[key] = candle.close
            historical_sources[key] = "mongodb_5m_candle_at_or_before_cutoff"
        candles_by_token: dict[tuple[str, str], list[Any]] = defaultdict(list)
        for candle in interval_candles:
            candles_by_token[(candle.chain, candle.token_address)].append(candle)
        for token_candles in candles_by_token.values():
            token_candles.sort(key=lambda row: row.open_time)
        for days in interval_days:
            at = valuation_time - timedelta(days=days)
            for key, token_candles in candles_by_token.items():
                eligible = [row for row in token_candles if row.open_time <= at]
                if eligible:
                    interval_cutoff_prices[days][key] = eligible[-1].close

    stablecoins = {
        ("base", "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"),
        ("base", "0xd9aa3212271cbb9b8b14a35eeced92e7c73f9c4a"),
        ("robinhood", "0x5fc5360d0400a0fd4f2af552add042d716f1d168"),
        ("bnb", "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d"),
        ("bnb", "0x55d398326f99059ff775485246999027b3197955"),
        ("solana", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
        ("solana", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"),
    }
    for key in stablecoins:
        historical_prices[key] = Decimal("1")
        historical_sources[key] = "stablecoin_par_value"
        for prices_for_interval in interval_cutoff_prices.values():
            prices_for_interval[key] = Decimal("1")

    interval_period_metrics = {
        days: build_fifo_period_metrics(
            interval_snapshots[days], interval_cutoff_prices[days]
        )
        for days in interval_days
    }
    for days in interval_days:
        metrics = interval_period_metrics[days]
        cutoff_capital = Decimal(metrics["opening_verified_fifo_value_usd"])
        period_pnl = Decimal(metrics["period_total_trade_pnl_usd"])
        metrics.update({
            "capital_deployed_at_cutoff_usd": format(cutoff_capital, "f"),
            "period_return_on_cutoff_capital_pct": (
                None if cutoff_capital <= 0 else format(
                    period_pnl / cutoff_capital * Decimal("100"), "f"
                )
            ),
            "capital_denominator_status": "verified_open_positions_at_cutoff_only",
            "capital_denominator_warning": "Uses only verified FIFO positions open at the cutoff and priced at that time; it excludes custody cash, unknown-cost inventory, unpriced positions, and later funding.",
            # Retained as a cash-reuse diagnostic, but deliberately excluded
            # from the capital deployed denominator selected for the product.
            "minimum_incremental_trade_funding_usd": format(
                interval_funding[days].minimum_trade_funding_required_usd, "f"
            ),
        })
        interval_snapshots[days]["period_metrics"] = interval_period_metrics[days]

    stablecoin_value = sum(
        (Decimal(row["current_value_usd"]) for row in actual_positions
         if row["current_value_usd"] is not None
         and (row["chain"], row["token_address"]) in stablecoins),
        Decimal("0"),
    )
    risk_asset_value = total_value - stablecoin_value
    material_open_positions = [
        row for row in actual_positions
        if row["current_value_usd"] is not None
        and Decimal(row["current_value_usd"]) >= Decimal("1")
        and (row["chain"], row["token_address"]) not in stablecoins
    ]

    fallback_keys = [
        key for key, quantity in opening_quantities.items()
        if key not in historical_prices
        and prices.get(key, Decimal("0")) * quantity >= Decimal("10")
    ]
    historical_price_errors = []
    for chain, token in fallback_keys:
        try:
            rows = client.token_ohlcv_by_network_id(
                network_ids[chain], chain, token, aggregate=15, limit=1,
                before_timestamp=int(cutoff.timestamp()) + 1,
            )
            if rows:
                historical_prices[(chain, token)] = rows[0].close
                historical_sources[(chain, token)] = "coingecko_15m_cutoff_fallback"
        except CoinGeckoError as exc:
            historical_price_errors.append({
                "chain": chain, "token_address": token, "error": str(exc),
            })

    opening_fifo_value = opening_fifo_basis_priced = opening_fifo_basis_unpriced = Decimal("0")
    opening_fifo_positions = []
    for row in snapshot["opening_fifo_inventory"]:
        key = (row["chain"], row["token_address"])
        quantity = Decimal(row["verified_quantity"])
        basis = Decimal(row["verified_original_cost_basis_usd"])
        price = historical_prices.get(key)
        value = None if price is None else quantity * price
        if value is None:
            opening_fifo_basis_unpriced += basis
        else:
            opening_fifo_value += value
            opening_fifo_basis_priced += basis
        opening_fifo_positions.append({
            **row,
            "cutoff_price_usd": None if price is None else format(price, "f"),
            "cutoff_value_usd": None if value is None else format(value, "f"),
            "cutoff_unrealized_pnl_usd": (
                None if value is None else format(value - basis, "f")
            ),
            "price_source": historical_sources.get(key),
        })
    opening_fifo_unrealized = opening_fifo_value - opening_fifo_basis_priced
    lifetime_basis_fifo_total = Decimal(snapshot["realized_plus_unrealized_pnl_usd"])
    period_mark_to_market_fifo_pnl = lifetime_basis_fifo_total - opening_fifo_unrealized
    fifo_period_bridge = {
        "method": (
            "7-day realized FIFO P&L plus ending unrealized P&L, minus unrealized "
            "P&L already present in verified opening lots at the cutoff"
        ),
        "realized_pnl_during_window_usd": snapshot["realized_pnl_usd"],
        "ending_unrealized_pnl_on_original_fifo_basis_usd": snapshot[
            "unrealized_pnl_on_priced_verified_inventory_usd"
        ],
        "opening_unrealized_pnl_at_cutoff_usd": format(opening_fifo_unrealized, "f"),
        "period_mark_to_market_fifo_pnl_usd": format(period_mark_to_market_fifo_pnl, "f"),
        "opening_verified_fifo_value_usd": format(opening_fifo_value, "f"),
        "opening_verified_fifo_basis_priced_usd": format(opening_fifo_basis_priced, "f"),
        "opening_verified_fifo_basis_missing_cutoff_price_usd": format(
            opening_fifo_basis_unpriced, "f"
        ),
        "opening_positions": opening_fifo_positions,
    }

    opening_positions = []
    opening_value = Decimal("0")
    for key, quantity in opening_quantities.items():
        price = historical_prices.get(key)
        value = None if price is None else quantity * price
        if value is not None:
            opening_value += value
        opening_positions.append({
            "chain": key[0], "token_address": key[1],
            "quantity": format(quantity, "f"),
            "price_usd": None if price is None else format(price, "f"),
            "value_usd": None if value is None else format(value, "f"),
            "price_source": historical_sources.get(key),
        })
    opening_positions.sort(
        key=lambda row: Decimal(row["value_usd"] or "-1"), reverse=True
    )
    stablecoin_external_net = Decimal("0")
    unvalued_external_token_events = 0
    for row in external:
        if row.timestamp < cutoff:
            continue
        key = (row.chain, row.token_address)
        sign = Decimal("1") if row.direction == "IN" else Decimal("-1")
        if key in stablecoins:
            stablecoin_external_net += sign * row.quantity
        else:
            unvalued_external_token_events += 1
    period_equity_pnl = total_value - opening_value - stablecoin_external_net
    internal_funding_30d = [row for row in internal_funding if row.timestamp >= cutoff]
    internal_stablecoin_out = sum(
        (row.quantity for row in internal_funding_30d
         if row.direction == "OUT" and (row.chain, row.token_address) in stablecoins),
        Decimal("0"),
    )
    internal_stablecoin_in = sum(
        (row.quantity for row in internal_funding_30d
         if row.direction == "IN" and (row.chain, row.token_address) in stablecoins),
        Decimal("0"),
    )
    provisional_combined_pnl = (
        period_equity_pnl + internal_stablecoin_out - internal_stablecoin_in
    )
    fomo_ui_reference = None
    if args.fomo_ui_portfolio_usd is not None and args.fomo_ui_pnl_usd is not None:
        fifo_total = Decimal(snapshot["realized_plus_unrealized_pnl_usd"])
        unknown_sale_upper_bound = Decimal(
            snapshot["sale_proceeds_excluded_for_unknown_inventory_usd"]
        )
        pnl_gap = args.fomo_ui_pnl_usd - fifo_total
        fomo_ui_reference = {
            "source": "user_supplied_rounded_UI_values",
            "portfolio_usd": format(args.fomo_ui_portfolio_usd, "f"),
            "pnl_window_usd": format(args.fomo_ui_pnl_usd, "f"),
            "pnl_30d_usd": format(args.fomo_ui_pnl_usd, "f") if args.days == 30 else None,
            "implied_opening_equity_usd_before_external_flows": format(
                args.fomo_ui_portfolio_usd - args.fomo_ui_pnl_usd, "f"
            ),
            "live_wallet_value_difference_usd": format(
                total_value - args.fomo_ui_portfolio_usd, "f"
            ),
            "fifo_pnl_difference_usd": format(
                fifo_total - args.fomo_ui_pnl_usd, "f"
            ),
            "provisional_combined_equity_pnl_difference_usd": format(
                provisional_combined_pnl - args.fomo_ui_pnl_usd, "f"
            ),
            "status": "not_yet_reconciled",
            "unknown_cost_inventory_hypothesis": {
                "excluded_sale_proceeds_usd": format(unknown_sale_upper_bound, "f"),
                "maximum_gap_explained_percent": (
                    None if pnl_gap <= 0 else format(
                        unknown_sale_upper_bound / pnl_gap * Decimal("100"), "f"
                    )
                ),
                "residual_gap_even_if_zero_cost_usd": format(
                    pnl_gap - unknown_sale_upper_bound, "f"
                ),
                "conclusion": "does_not_explain_the_fomo_pnl_gap",
            },
        }

    payload = {
        "wallets": {"evm": audit["evm_wallet"], "solana": audit["solana_wallet"]},
        "valuation_time": valuation_time.isoformat(),
        "trade_ledger_through": audit["generated_at"],
        "window_days": args.days,
        "fomo_ui_reference": fomo_ui_reference,
        "rolling_capital": funding.as_document(),
        "pnl_window": snapshot,
        "pnl_intervals": {
            ("24h" if days == 1 else f"{days}d"): {
                **interval_snapshots[days],
                "rolling_capital": interval_funding[days].as_document(),
            }
            for days in interval_days
        },
        "fifo_period_bridge": fifo_period_bridge,
        "period_equity_bridge": {
            "ending_priced_token_portfolio_usd": format(total_value, "f"),
            "opening_priced_token_portfolio_usd": format(opening_value, "f"),
            "net_external_stablecoin_contributions_usd": format(stablecoin_external_net, "f"),
            "period_pnl_on_common_priced_wallet_assets_usd": format(period_equity_pnl, "f"),
            "provisional_pnl_if_fomo_custody_funds_remained_trader_owned_usd": format(
                provisional_combined_pnl, "f"
            ),
            "opening_token_count": len(opening_positions),
            "opening_priced_token_count": sum(
                row["value_usd"] is not None for row in opening_positions
            ),
            "opening_unpriced_token_count": sum(
                row["value_usd"] is None for row in opening_positions
            ),
            "unvalued_non_stablecoin_external_event_count": unvalued_external_token_events,
            "status": "not_comparable_to_fomo_until_internal_custody_balance_is_added",
            "warning": "Fomo DepositToken/WithdrawToken moves value outside the visible wallet without leaving the trader's Fomo ecosystem.",
            "opening_positions": opening_positions,
        },
        "actual_wallet_portfolio": {
            "priced_token_value_usd": format(total_value, "f"),
            "stablecoin_value_usd": format(stablecoin_value, "f"),
            "risk_asset_value_usd": format(risk_asset_value, "f"),
            "priced_non_dust_value_usd": format(priced_value, "f"),
            "position_count": len(actual_positions),
            "priced_position_count": sum(row["current_value_usd"] is not None for row in actual_positions),
            "unpriced_position_count": sum(row["current_value_usd"] is None for row in actual_positions),
            "native_gas_assets_included": ["solana:SOL"],
            "native_gas_asset_scope": "native SOL is included as WSOL-equivalent; EVM native gas balances remain pending",
            "material_open_position_count": len(material_open_positions),
            "material_open_positions": material_open_positions,
            "positions": actual_positions,
        },
        "external_flow_audit": {
            "method": "non-Fomo wallet token deltas; never treated as purchases",
            "event_count_90d": len(external),
            "receipt_count_90d": sum(row.direction == "IN" for row in external),
            "transfer_out_count_90d": sum(row.direction == "OUT" for row in external),
            "event_count_window": sum(row.timestamp >= cutoff for row in external),
            "events": [_serialize_adjustment(row) for row in external],
        },
        "fomo_internal_funding_audit": {
            "method": "Solana Fomo DepositToken/WithdrawToken instructions",
            "event_count_90d": len(internal_funding),
            "event_count_window": len(internal_funding_30d),
            "stablecoin_sent_to_fomo_custody_window_usd": format(internal_stablecoin_out, "f"),
            "stablecoin_returned_from_fomo_custody_window_usd": format(internal_stablecoin_in, "f"),
            "treatment": "internal Fomo custody movement; excluded from outside-wallet contributions",
            "events": [_serialize_adjustment(row) for row in internal_funding],
        },
        "provider": {
            "network_ids": network_ids,
            "coingecko_requests": len(client.metrics),
            "coingecko_credits_used": sum(row.credit_used for row in client.metrics),
            "price_errors": price_errors,
            "historical_price_errors": historical_price_errors,
            "rpc_metrics": rpc_metrics,
        },
        "reconciliation_status": (
            "provisional_until_trade_ledger_is_refreshed_to_valuation_time"
            if datetime.fromisoformat(audit["generated_at"]) < valuation_time - timedelta(hours=1)
            else "current"
        ),
        "display_labels": {
            "rolling_capital_deployed_usd": "Rolling capital deployed",
            "realized_return_on_rolling_capital_pct": "Return on rolling capital",
            "average_completed_position_return_pct": "Average return per completed position",
            "realized_plus_unrealized_pnl_usd": f"{args.days}-day total P&L",
        },
    }
    if args.persist:
        trader_id = (
            f"evm:{audit['evm_wallet'].lower()}|solana:{audit['solana_wallet']}"
        )
        repository = MongoAnalysisRepository(
            config.mongodb_uri or "", config.mongodb_database
        )
        try:
            repository.ping()
            payload["persistence"] = repository.upsert_portfolio_snapshot(
                trader_id, payload
            )
        finally:
            repository.close()
    if args.days == 30:
        payload["pnl_30d"] = payload["pnl_window"]
        payload["period_equity_bridge_30d"] = payload["period_equity_bridge"]
        payload["external_flow_audit"]["event_count_30d"] = payload["external_flow_audit"]["event_count_window"]
        payload["fomo_internal_funding_audit"]["event_count_30d"] = payload["fomo_internal_funding_audit"]["event_count_window"]
    output = audit_path.parent / f"portfolio_snapshot_{args.days}d.json"
    output.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({
        "output": str(output), "rolling_capital": payload["rolling_capital"],
        "pnl_window": {key: snapshot[key] for key in (
            "realized_pnl_usd", "unrealized_pnl_on_priced_verified_inventory_usd",
            "realized_plus_unrealized_pnl_usd", "external_or_unknown_cost_current_value_usd",
        )},
        "fifo_period_bridge": {
            key: fifo_period_bridge[key] for key in (
                "realized_pnl_during_window_usd",
                "ending_unrealized_pnl_on_original_fifo_basis_usd",
                "opening_unrealized_pnl_at_cutoff_usd",
                "period_mark_to_market_fifo_pnl_usd",
                "opening_verified_fifo_value_usd",
                "opening_verified_fifo_basis_missing_cutoff_price_usd",
            )
        },
        "period_equity_bridge": {
            key: payload["period_equity_bridge"][key] for key in (
                "ending_priced_token_portfolio_usd",
                "opening_priced_token_portfolio_usd",
                "net_external_stablecoin_contributions_usd",
                "period_pnl_on_common_priced_wallet_assets_usd",
                "provisional_pnl_if_fomo_custody_funds_remained_trader_owned_usd",
                "opening_priced_token_count",
                "opening_unpriced_token_count",
                "status",
            )
        },
        "actual_wallet_portfolio_usd": payload["actual_wallet_portfolio"]["priced_token_value_usd"],
        "portfolio_price_coverage": {
            "priced": payload["actual_wallet_portfolio"]["priced_position_count"],
            "unpriced": payload["actual_wallet_portfolio"]["unpriced_position_count"],
        },
        "external_flow_counts": {
            "receipts_90d": payload["external_flow_audit"]["receipt_count_90d"],
            "outs_90d": payload["external_flow_audit"]["transfer_out_count_90d"],
        },
        "provider": payload["provider"], "status": payload["reconciliation_status"],
    }, indent=2))


if __name__ == "__main__":
    main()
