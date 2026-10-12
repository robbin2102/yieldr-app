"""Build and persist resumable V3.3 feature, pattern, and story analysis."""

from __future__ import annotations

import argparse
import gc
import hashlib
import json
from collections import Counter, defaultdict
from dataclasses import replace
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Iterable

from fomo_analysis.action_analysis import build_action_feature_rows, classify_economic_actions
from fomo_analysis.advanced_features import (
    build_entry_state_rows,
    build_episode_feature_rows,
    build_trader_economics,
    build_trader_state_summary,
)
from fomo_analysis.config import load_analytics_config
from fomo_analysis.models import Candle, NormalizedTrade
from fomo_analysis.mongo_repository import MongoAnalysisRepository
from fomo_analysis.normalization import load_normalized_trades
from fomo_analysis.pattern_readiness import assess_pattern_readiness
from fomo_analysis.positions import reconstruct_positions
from fomo_analysis.price_features import CandleSeries, build_entry_price_features, build_episode_price_features
from fomo_analysis.v3_3_economics import attribute_realized_action_economics
from fomo_analysis.v3_3_pattern_engine import MODEL_VERSION, RULE_VERSION, run_v3_3_pattern_engine
from fomo_analysis.v3_3_stories import build_v3_3_action_assessments, build_v3_3_position_stories
from scripts.run_v3_3_target import attach_realized_economics


def _read(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _write(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True, default=str) + "\n", encoding="utf-8")


def _directory(root: Path, profile: dict[str, Any], days: int) -> Path:
    return root / f"{profile['evm_wallet'].lower()[2:10]}_{profile['solana_wallet'][:8]}_{days}d"


def _price_trades_from_candles(
    trades: Iterable[NormalizedTrade], candles: Iterable[Candle]
) -> tuple[list[NormalizedTrade], dict[str, int]]:
    grouped: dict[tuple[str, str], list[Candle]] = defaultdict(list)
    for candle in candles:
        grouped[(candle.chain, candle.token_address)].append(candle)
    series = {key: CandleSeries(rows) for key, rows in grouped.items()}
    output = []
    atomic = estimated = missing = 0
    for trade in trades:
        if trade.usd_notional is not None:
            output.append(trade)
            atomic += 1
            continue
        token_series = series.get((trade.chain, trade.token_address))
        candle = token_series.at_or_before(trade.timestamp) if token_series else None
        if candle is None or candle.close <= 0:
            output.append(trade)
            missing += 1
            continue
        notional = trade.token_amount * candle.close
        output.append(replace(
            trade,
            usd_notional=notional,
            execution_price_usd=candle.close,
            amount_source="mongodb_5m_candle_close_estimate",
        ))
        estimated += 1
    return output, {
        "atomic_or_quote_priced_trade_legs": atomic,
        "ohlc_estimated_trade_legs": estimated,
        "unpriced_trade_legs": missing,
    }


def _summary_id(trader_id: str) -> str:
    return hashlib.sha256(f"{trader_id}|{MODEL_VERSION}|{RULE_VERSION}".encode()).hexdigest()


def _pattern_status_counts(patterns: list[dict[str, Any]]) -> dict[str, int]:
    return dict(Counter(row["finding_status"] for row in patterns))


def _examples(stories: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "newest_open_position": next((row for row in stories if row["position_state"] == "open"), None),
        "newest_closed_position": next((row for row in stories if row["position_state"] == "closed"), None),
    }


def analyze_one(
    repository: MongoAnalysisRepository,
    profile: dict[str, Any],
    audit_root: Path,
    days: int,
    generated_at: datetime,
) -> dict[str, Any]:
    directory = _directory(audit_root, profile, days)
    audit_path = directory / "trades.json"
    if not audit_path.exists():
        raise FileNotFoundError(f"Missing indexed audit: {audit_path}")
    priced_path = directory / "recent_priced_trades.json"
    _, raw_trades = load_normalized_trades(
        audit_path, priced_path if priced_path.exists() else None
    )
    token_keys = {(row.chain, row.token_address) for row in raw_trades}
    candles = repository.load_price_candles(token_keys)
    trades, price_provenance = _price_trades_from_candles(raw_trades, candles)
    reconstruction = reconstruct_positions(trades)

    entry_price = build_entry_price_features(trades, candles)
    episode_price = build_episode_price_features(reconstruction.episodes, candles)
    readiness = assess_pattern_readiness(entry_price, episode_price)
    price_report = {
        "summary": {
            "trade_count": len(trades),
            "buy_entry_count": len(entry_price),
            "closed_episode_count": len(episode_price),
            "mongo_candle_count": len(candles),
            **price_provenance,
        },
        "pattern_readiness": readiness,
        "entry_features": entry_price,
        "episode_features": episode_price,
    }
    _write(directory / "price_feature_analysis_v4.json", price_report)

    episodes = build_episode_feature_rows(trades, reconstruction.episodes, episode_price)
    entries = build_entry_state_rows(trades, reconstruction, entry_price, episodes)
    economics = build_trader_economics(trades, episodes)
    state = build_trader_state_summary(entries, episodes)
    feature_report = {
        "trader_id": profile["trader_id"],
        "price_readiness": readiness,
        "trader_economics": economics,
        "trader_state_summary": state,
        "price_provenance": price_provenance,
        "entry_features": entries,
        "episode_features": episodes,
    }
    feature_persistence = repository.upsert_price_features(
        profile["trader_id"],
        entries,
        episodes,
        {"price_readiness": readiness, "price_provenance": price_provenance, **economics, **state},
        feature_namespace="v3_tier1",
        summary_feature_key="v3_tier1_summary",
    )
    feature_report["persistence"] = feature_persistence
    _write(directory / "v3_feature_analysis.json", feature_report)

    actions = classify_economic_actions(trades, reconstruction)
    action_rows = build_action_feature_rows(actions, candles, entries, as_of=generated_at)
    action_rows = attach_realized_economics(
        action_rows, attribute_realized_action_economics(actions)
    )
    engine = run_v3_3_pattern_engine(action_rows, episodes, economics)
    assessments = build_v3_3_action_assessments(
        profile["trader_id"], action_rows, engine["patterns"], assessed_at=generated_at
    )
    stories = build_v3_3_position_stories(action_rows, assessments, episodes, engine["patterns"])
    purchase_outcomes = [
        row.get("realized_economic_outcome") or {}
        for row in action_rows if row.get("side") == "BUY"
    ]
    disposal_outcomes = [
        row.get("realized_economic_outcome") or {}
        for row in action_rows if row.get("side") == "SELL"
    ]
    summary = {
        "summary_id": _summary_id(profile["trader_id"]),
        "trader_id": profile["trader_id"],
        "priority_rank": profile.get("priority_rank"),
        "username": profile.get("username"),
        "x_handle": profile.get("x_handle"),
        "model_version": MODEL_VERSION,
        "rule_version": RULE_VERSION,
        "computed_at": generated_at.isoformat(),
        "analysis_window_days": days,
        "analysis_status": "completed",
        "trade_leg_count": len(trades),
        "economic_action_count": len(action_rows),
        "action_type_counts": dict(Counter(row["action_type"] for row in action_rows)),
        "position_story_count": len(stories),
        "position_chapter_count": sum(len(row["chapters"]) for row in stories),
        "open_position_count": sum(row["position_state"] == "open" for row in stories),
        "closed_position_count": sum(row["position_state"] == "closed" for row in stories),
        "completed_purchase_count": sum(row.get("realization_status") == "completed" for row in purchase_outcomes),
        "partially_realized_purchase_count": sum(row.get("realization_status") == "partially_realized" for row in purchase_outcomes),
        "open_purchase_count": sum(row.get("realization_status") == "open_pending_disposal" for row in purchase_outcomes),
        "unknown_purchase_outcome_count": sum(str(row.get("realization_status", "")).startswith("unavailable") for row in purchase_outcomes),
        "fully_attributed_disposal_count": sum(row.get("realization_status") == "realized" for row in disposal_outcomes),
        "partially_attributed_disposal_count": sum(row.get("realization_status") == "partially_attributed_opening_inventory_gap" for row in disposal_outcomes),
        "opening_inventory_disposal_count": sum(row.get("realization_status") == "unavailable_opening_inventory_cost_basis" for row in disposal_outcomes),
        "actions_with_pattern_context": sum(bool(row.get("matched_patterns")) for row in assessments),
        "actions_with_validated_action_pattern": sum(bool(row.get("primary_supported_pattern")) for row in assessments),
        "positions_with_validated_pattern": sum(bool(row.get("supported_position_pattern_count")) for row in stories),
        "position_pattern_recognition_events": sum(len(ch.get("position_pattern_events") or []) for row in stories for ch in row["chapters"]),
        "pattern_status_counts": _pattern_status_counts(engine["patterns"]),
        "pattern_findings": engine["patterns"],
        "price_readiness": readiness,
        "price_provenance": price_provenance,
        "trader_economics": economics,
        "trader_state_summary": state,
    }
    mongo_report = {
        "trader_id": profile["trader_id"],
        "model_version": MODEL_VERSION,
        "rule_version": RULE_VERSION,
        "generated_at": generated_at.isoformat(),
        "trader_summary": summary,
        "action_rows": action_rows,
        "action_assessments": assessments,
        "position_stories": stories,
    }
    persistence = repository.upsert_v3_2_report(mongo_report)
    local_summary = {
        **summary,
        "persistence": {**feature_persistence, **persistence},
        "examples": _examples(stories),
        "source": {
            "audit_path": str(audit_path),
            "priced_path": str(priced_path) if priced_path.exists() else None,
            "mongo_candle_count": len(candles),
        },
    }
    _write(directory / "v3_3_summary.json", local_summary)
    return {
        "priority_rank": profile.get("priority_rank"),
        "username": profile.get("username"),
        "x_handle": profile.get("x_handle"),
        "trader_id": profile["trader_id"],
        "directory": str(directory),
        "trade_leg_count": len(trades),
        "economic_action_count": len(action_rows),
        "position_story_count": len(stories),
        "completed_purchase_count": summary["completed_purchase_count"],
        "actions_with_pattern_context": summary["actions_with_pattern_context"],
        "positions_with_validated_pattern": summary["positions_with_validated_pattern"],
        "pattern_status_counts": summary["pattern_status_counts"],
        "price_readiness_status": readiness["status"],
        "price_provenance": price_provenance,
        "persistence": local_summary["persistence"],
        "output": str(directory / "v3_3_summary.json"),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profiles", type=Path, default=Path("output/trader_universe/top76_metadata_refresh.json"))
    parser.add_argument("--audit-root", type=Path, default=Path("output/wallet_audits"))
    parser.add_argument("--days", type=int, default=90)
    parser.add_argument("--start-rank", type=int, default=1)
    parser.add_argument("--limit", type=int)
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--output", type=Path, default=Path("output/cohorts/v3_3_top76_run.json"))
    args = parser.parse_args()
    payload = _read(args.profiles)
    profiles = [
        row for row in payload.get("profiles", [])
        if row.get("resolution_status") == "resolved"
        and int(row.get("priority_rank", 10**9)) >= args.start_rank
    ]
    profiles.sort(key=lambda row: int(row["priority_rank"]))
    if args.limit is not None:
        profiles = profiles[:args.limit]
    config = load_analytics_config(require_mongodb=True)
    repository = MongoAnalysisRepository(config.mongodb_uri or "", config.mongodb_database)
    generated_at = datetime.now(timezone.utc)
    results: list[dict[str, Any]] = []
    failures: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    run = {
        "model_version": MODEL_VERSION,
        "rule_version": RULE_VERSION,
        "started_at": generated_at.isoformat(),
        "requested_profiles": len(profiles),
        "results": results,
        "failures": failures,
        "skipped": skipped,
    }
    try:
        repository.ping()
        for index, profile in enumerate(profiles, 1):
            directory = _directory(args.audit_root, profile, args.days)
            summary_path = directory / "v3_3_summary.json"
            if args.resume and summary_path.exists():
                prior = _read(summary_path)
                if prior.get("model_version") == MODEL_VERSION and prior.get("rule_version") == RULE_VERSION:
                    skipped.append({"priority_rank": profile["priority_rank"], "trader_id": profile["trader_id"], "reason": "current_rule_already_completed", "output": str(summary_path)})
                    print(json.dumps({"progress": f"{index}/{len(profiles)}", "rank": profile["priority_rank"], "status": "skipped_current"}), flush=True)
                    continue
            try:
                result = analyze_one(repository, profile, args.audit_root, args.days, generated_at)
                results.append(result)
                print(json.dumps({"progress": f"{index}/{len(profiles)}", "rank": profile["priority_rank"], "handle": profile.get("x_handle"), "status": "completed", "actions": result["economic_action_count"], "patterns": result["pattern_status_counts"], "price": result["price_readiness_status"]}), flush=True)
            except Exception as exc:
                failure = {"priority_rank": profile.get("priority_rank"), "username": profile.get("username"), "trader_id": profile.get("trader_id"), "error_type": type(exc).__name__, "error": str(exc)}
                failures.append(failure)
                print(json.dumps({"progress": f"{index}/{len(profiles)}", "rank": profile.get("priority_rank"), "status": "error", "error_type": type(exc).__name__, "error": str(exc)[:300]}), flush=True)
            run["updated_at"] = datetime.now(timezone.utc).isoformat()
            run["completed_profiles"] = len(results)
            run["failed_profiles"] = len(failures)
            run["skipped_profiles"] = len(skipped)
            _write(args.output, run)
            gc.collect()
    finally:
        repository.close()
    run.update({
        "finished_at": datetime.now(timezone.utc).isoformat(),
        "completed_profiles": len(results),
        "failed_profiles": len(failures),
        "skipped_profiles": len(skipped),
        "totals": {
            "trade_legs": sum(row["trade_leg_count"] for row in results),
            "economic_actions": sum(row["economic_action_count"] for row in results),
            "position_stories": sum(row["position_story_count"] for row in results),
            "completed_purchases": sum(row["completed_purchase_count"] for row in results),
            "actions_with_pattern_context": sum(row["actions_with_pattern_context"] for row in results),
            "positions_with_validated_pattern": sum(row["positions_with_validated_pattern"] for row in results),
            "pattern_status_counts": dict(Counter(status for row in results for status, count in row["pattern_status_counts"].items() for _ in range(count))),
            "price_readiness_status_counts": dict(Counter(row["price_readiness_status"] for row in results)),
            "atomic_or_quote_priced_trade_legs": sum(row["price_provenance"]["atomic_or_quote_priced_trade_legs"] for row in results),
            "ohlc_estimated_trade_legs": sum(row["price_provenance"]["ohlc_estimated_trade_legs"] for row in results),
            "unpriced_trade_legs": sum(row["price_provenance"]["unpriced_trade_legs"] for row in results),
        },
    })
    _write(args.output, run)
    print(json.dumps({key: value for key, value in run.items() if key not in {"results", "failures", "skipped"}} | {"failures": failures}, indent=2), flush=True)


if __name__ == "__main__":
    main()
