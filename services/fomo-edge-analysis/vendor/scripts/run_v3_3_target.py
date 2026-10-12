"""Run Yieldr V3.3 for the single wallet pair configured in .env."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path
from statistics import mean, median
from typing import Any

from dotenv import load_dotenv

from fomo_analysis.action_analysis import build_action_feature_rows, classify_economic_actions
from fomo_analysis.config import PROJECT_ROOT, load_analytics_config
from fomo_analysis.mongo_repository import MongoAnalysisRepository
from fomo_analysis.normalization import load_normalized_trades
from fomo_analysis.positions import reconstruct_positions
from fomo_analysis.pnl_reporting import build_v3_3_pnl_reporting
from fomo_analysis.v3_3_economics import attribute_realized_action_economics, attach_realized_economics
from fomo_analysis.v3_3_pattern_engine import MODEL_VERSION, RULE_VERSION, run_v3_3_pattern_engine
from fomo_analysis.v3_3_stories import build_v3_3_action_assessments, build_v3_3_position_stories


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _read(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _feature_inventory(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Describe every computed field without losing row-level data in the report."""
    result={}
    for key in sorted({key for row in rows for key in row}):
        values=[row.get(key) for row in rows if row.get(key) is not None]
        item={"row_count":len(rows),"observed_count":len(values),"missing_count":len(rows)-len(values)}
        if values and all(isinstance(value,bool) for value in values):
            item["value_type"]="boolean";item["true_count"]=sum(values);item["false_count"]=len(values)-sum(values)
        else:
            numeric=[]
            for value in values:
                try:numeric.append(float(value))
                except (TypeError,ValueError):pass
            if values and len(numeric)==len(values):
                item.update({"value_type":"numeric","minimum":min(numeric),"median":median(numeric),"mean":mean(numeric),"maximum":max(numeric)})
            else:
                counts=Counter(str(value) for value in values)
                item["value_type"]="categorical_or_identifier";item["distinct_count"]=len(counts);item["most_common"]=counts.most_common(10)
        result[key]=item
    return result


def _target(evm_override: str | None = None, solana_override: str | None = None) -> tuple[str, str]:
    load_dotenv(PROJECT_ROOT / ".env")
    if bool(evm_override) != bool(solana_override):
        raise RuntimeError("--evm-wallet and --solana-wallet must be supplied together")
    evm=(evm_override or os.getenv("TARGET_WALLET", "")).strip().lower();solana=(solana_override or os.getenv("TARGET_SOLANA_WALLET", "")).strip()
    if not evm or not solana: raise RuntimeError("TARGET_WALLET and TARGET_SOLANA_WALLET must both be configured")
    if not (evm.startswith("0x") and len(evm)==42): raise RuntimeError("TARGET_WALLET is not a valid EVM address")
    if not (32<=len(solana)<=44): raise RuntimeError("TARGET_SOLANA_WALLET is not a valid Solana address")
    return evm,solana


def _examples(stories: list[dict[str, Any]], assessments: list[dict[str, Any]]) -> dict[str, Any]:
    newest_open=next((row for row in stories if row["position_state"]=="open"),None)
    newest_closed=next((row for row in stories if row["position_state"]=="closed"),None)
    supported=next((row for row in reversed(assessments) if row["primary_supported_pattern"]),None)
    no_match=next((row for row in reversed(assessments) if not row["primary_supported_pattern"]),None)
    return {"newest_open_position":newest_open,"newest_closed_position":newest_closed,"newest_supported_action":supported,"newest_action_without_supported_pattern":no_match}


def _write_markdown(path: Path, report: dict[str, Any]) -> None:
    summary=report["summary"];patterns=report["pattern_engine"]["patterns"]
    lines=["# Yieldr V3.3 target wallet analysis","",f"Model `{MODEL_VERSION}` · rule `{RULE_VERSION}` · 90-day target-only run","","## Result","",f"- Economic actions: {summary['economic_action_count']:,}",f"- Position stories: {summary['position_story_count']:,}",f"- Open positions: {summary['open_position_count']:,}",f"- Closed positions: {summary['closed_position_count']:,}",f"- Completed purchase outcomes: {summary['completed_purchase_count']:,}",f"- Partially realized purchases: {summary['partially_realized_purchase_count']:,}",f"- Purchases still open: {summary['open_purchase_count']:,}","","## Pattern findings","","| Pattern | Status | Completed N | Win rate | Average completed return | Median | PnL |","|---|---|---:|---:|---:|---:|---:|"]
    for row in patterns:
        if row["finding_status"] in {"rejected_hypothesis"}:continue
        evidence=row["historical_evidence"]
        def p(value):return "—" if value is None else f"{value:,.2f}%"
        def m(value):return "—" if value is None else f"${value:,.2f}"
        lines.append(f"| {row['name']} | {row['finding_status']} | {evidence['completed_observation_count']} | {p(evidence['win_rate_percent'])} | {p(evidence['realized_expectancy_pct'])} | {p(evidence['median_realized_return_pct'])} | {m(evidence['realized_pnl_usd'])} |")
    pnl=report.get("pnl_reporting")
    if pnl:
        verified=pnl["verified_trade_pnl"];bridge=pnl["unattributed_disposals"]
        lines += ["","## P&L accounting","",f"- Verified realized trade P&L: ${float(verified['realized_pnl_usd']):,.2f}",f"- Verified unrealized trade P&L: ${float(verified['unrealized_pnl_usd']):,.2f}",f"- Verified total trade P&L: ${float(verified['total_trade_pnl_usd']):,.2f}",f"- Unattributed sell proceeds excluded from profit: ${float(bridge['sale_proceeds_excluded_from_trade_pnl_usd']):,.2f}",""]
    lines += ["","## Real position story examples",""]
    for key in ("newest_open_position","newest_closed_position"):
        story=report["real_story_examples"].get(key)
        if not story:continue
        lines += [f"### {key.replace('_',' ').title()}","",story["plain_english_story"],""]
        for chapter in story["chapters"]:
            lines.append(f"- {chapter['occurred_at']}: {chapter['pattern_assessment']} {chapter['actual_progress']['plain_english']}")
        lines.append("")
    lines += ["## Interpretation boundaries","","- Historical win rate and realized EV come from completed purchase-to-disposal observations, never from the current trade itself.","- One-hour price movement is retained only as a timing diagnostic.","- Observed behavior is not labeled a validated edge unless all V3.3 evidence gates pass."]
    if pnl:
        lines += ["- Open-position unrealized P&L uses the attached point-in-time wallet valuation and verified FIFO purchase basis.","- UI-only unmatched sell proceeds are a reconciliation bridge, not verified economic profit."]
    else:
        lines.append("- Open-position unrealized P&L remains unavailable until a reliable current-price valuation is joined.")
    lines += ["- Market cap remains unavailable unless timestamp-aligned price and a clearly labeled historical supply basis both exist.",""]
    path.write_text("\n".join(lines),encoding="utf-8")


def main() -> None:
    parser=argparse.ArgumentParser();parser.add_argument("--audit-root",type=Path,default=Path("output/wallet_audits"));parser.add_argument("--days",type=int,default=90);parser.add_argument("--pnl-days",type=int,default=7);parser.add_argument("--evm-wallet");parser.add_argument("--solana-wallet");parser.add_argument("--persist",action="store_true");args=parser.parse_args()
    evm,solana=_target(args.evm_wallet,args.solana_wallet);directory=args.audit_root/f"{evm[2:10]}_{solana[:8]}_{args.days}d";audit_path=directory/"trades.json";priced_path=directory/"recent_priced_trades.json";feature_path=directory/"v3_feature_analysis.json"
    if not audit_path.exists():raise RuntimeError(f"Target audit is missing: {audit_path}. Run scripts.audit_wallet_90d for the configured pair first.")
    if not priced_path.exists():raise RuntimeError(f"Target atomic USD enrichment is missing: {priced_path}.")
    if not feature_path.exists():raise RuntimeError(f"Target V3 feature input is missing: {feature_path}. Build price paths and V3 features for this target first.")
    audit=_read(audit_path)
    if audit.get("evm_wallet","").lower()!=evm or audit.get("solana_wallet")!=solana:raise RuntimeError("Target audit wallet attribution does not match the configured pair")
    _,trades=load_normalized_trades(audit_path,priced_path);reconstruction=reconstruct_positions(trades);features=_read(feature_path)
    expected_trader=f"evm:{evm}|solana:{solana}"
    if features.get("trader_id")!=expected_trader:raise RuntimeError("Target feature attribution does not match the configured pair")
    config=load_analytics_config(require_mongodb=True);repo=MongoAnalysisRepository(config.mongodb_uri or "",config.mongodb_database);generated=datetime.now(timezone.utc)
    try:
        repo.ping();actions=classify_economic_actions(trades,reconstruction)
        windows=[(a.chain,a.token_address,t) for a in actions for t in (a.timestamp,a.timestamp+timedelta(hours=1))]
        candles=repo.load_price_candles_for_windows(windows)
        action_rows=build_action_feature_rows(actions,candles,features["entry_features"],as_of=generated)
        action_rows=attach_realized_economics(action_rows,attribute_realized_action_economics(actions))
        engine=run_v3_3_pattern_engine(
            action_rows,
            features["episode_features"],
            features.get("trader_economics"),
        )
        assessments=build_v3_3_action_assessments(expected_trader,action_rows,engine["patterns"],assessed_at=generated)
        stories=build_v3_3_position_stories(
            action_rows,
            assessments,
            features["episode_features"],
            engine["patterns"],
        )
        purchase=[row.get("realized_economic_outcome") or {} for row in action_rows if row.get("side")=="BUY"]
        disposals=[row.get("realized_economic_outcome") or {} for row in action_rows if row.get("side")=="SELL"]
        summary={"summary_id":hashlib.sha256(f"{expected_trader}|{MODEL_VERSION}|{RULE_VERSION}".encode()).hexdigest(),"trader_id":expected_trader,"model_version":MODEL_VERSION,"rule_version":RULE_VERSION,"computed_at":generated.isoformat(),"economic_action_count":len(action_rows),"action_type_counts":dict(Counter(row["action_type"] for row in action_rows)),"position_story_count":len(stories),"position_chapter_count":sum(len(row["chapters"]) for row in stories),"open_position_count":sum(row["position_state"]=="open" for row in stories),"closed_position_count":sum(row["position_state"]=="closed" for row in stories),"completed_purchase_count":sum(row.get("realization_status")=="completed" for row in purchase),"partially_realized_purchase_count":sum(row.get("realization_status")=="partially_realized" for row in purchase),"open_purchase_count":sum(row.get("realization_status")=="open_pending_disposal" for row in purchase),"unknown_purchase_outcome_count":sum(str(row.get("realization_status","")).startswith("unavailable") for row in purchase),"fully_attributed_disposal_count":sum(row.get("realization_status")=="realized" for row in disposals),"partially_attributed_disposal_count":sum(row.get("realization_status")=="partially_attributed_opening_inventory_gap" for row in disposals),"opening_inventory_disposal_count":sum(row.get("realization_status")=="unavailable_opening_inventory_cost_basis" for row in disposals),"actions_with_pattern_context":sum(bool(row.get("matched_patterns")) for row in assessments),"actions_with_validated_action_pattern":sum(bool(row.get("primary_supported_pattern")) for row in assessments),"positions_with_validated_pattern":sum(bool(row.get("supported_position_pattern_count")) for row in stories),"position_pattern_recognition_events":sum(len(ch.get("position_pattern_events") or []) for row in stories for ch in row["chapters"]),"pattern_status_counts":engine["status_counts"],"timing_diagnostic_price_readiness":features["price_readiness"]}
        report={"trader_id":expected_trader,"configured_wallets":{"evm":evm,"solana":solana},"model_version":MODEL_VERSION,"rule_version":RULE_VERSION,"generated_at":generated.isoformat(),"input_manifest":{"audit_path":str(audit_path),"audit_sha256":_sha(audit_path),"priced_path":str(priced_path),"priced_sha256":_sha(priced_path),"feature_path":str(feature_path),"feature_sha256":_sha(feature_path),"mongo_candle_count":len(candles)},"summary":summary,"trader_economics":features["trader_economics"],"trader_state_summary":features["trader_state_summary"],"feature_inventory":{"entry_features":_feature_inventory(features["entry_features"]),"episode_features":_feature_inventory(features["episode_features"]),"trader_economics":features["trader_economics"],"trader_state_summary":features["trader_state_summary"]},"pattern_engine":engine,"action_rows":action_rows,"action_assessments":assessments,"position_stories":stories,"real_story_examples":_examples(stories,assessments),"limitations":["Retrospective assessments use only evidence completed before each action, but were reconstructed after the fact.",f"{summary['unknown_purchase_outcome_count']:,} purchase actions have incomplete USD cost/proceeds attribution and are excluded from completed purchase economics.",f"{summary['opening_inventory_disposal_count']:,} disposal actions sold inventory acquired before the 90-day window and therefore lack reconstructable cost basis/PnL.","Historical market cap is not inferred without timestamp-aligned supply provenance."]}
        portfolio_path=directory/f"portfolio_snapshot_{args.pnl_days}d.json";ui_path=directory/"fomo_ui_reconciliation_30d.json"
        if portfolio_path.exists():
            report["pnl_reporting"]=build_v3_3_pnl_reporting(_read(portfolio_path),ui_reconciliation=_read(ui_path) if ui_path.exists() else None,position_stories=stories)
            report["input_manifest"].update({"portfolio_snapshot_path":str(portfolio_path),"portfolio_snapshot_sha256":_sha(portfolio_path),"fomo_ui_reconciliation_path":str(ui_path) if ui_path.exists() else None,"fomo_ui_reconciliation_sha256":_sha(ui_path) if ui_path.exists() else None})
            pnl_report=report["pnl_reporting"]
            summary["pnl_summary"]={
                "window_days":pnl_report["window_days"],
                **pnl_report["verified_trade_pnl"],
                "unattributed_disposal_count":pnl_report["unattributed_disposals"]["event_count"],
                "unattributed_disposal_proceeds_excluded_from_pnl_usd":pnl_report["unattributed_disposals"]["sale_proceeds_excluded_from_trade_pnl_usd"],
                "pnl_intervals":pnl_report["pnl_intervals"],
                "open_wallet_balance_count_including_dust":pnl_report["open_positions"]["position_count"],
                "material_open_position_count":pnl_report["open_positions"]["material_position_count"],
                "closed_position_count":pnl_report["closed_positions"]["position_count"],
            }
        else:
            report["limitations"].append(f"No portfolio_snapshot_{args.pnl_days}d.json was available, so current valuation and dual-view PnL were not attached.")
        if args.persist:report["persistence"]=repo.upsert_v3_2_report({**report,"trader_summary":summary})
    finally:repo.close()
    directory.mkdir(parents=True,exist_ok=True);out=directory/"v3_3_analysis.json";out.write_text(json.dumps(report,indent=2,sort_keys=True,default=str)+"\n",encoding="utf-8");_write_markdown(directory/"V3_3_TARGET_RESULTS.md",report)
    print(json.dumps({"target_wallets_verified":True,"output":str(out),"summary":summary},indent=2))


if __name__=="__main__":main()
