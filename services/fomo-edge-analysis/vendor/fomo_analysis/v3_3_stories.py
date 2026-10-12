"""Plain-English action assessments and evolving position stories for V3.3."""

from __future__ import annotations

import hashlib
from bisect import bisect_right
from collections import defaultdict
from datetime import datetime, timezone
from statistics import mean
from typing import Any, Iterable

from fomo_analysis.v3_2_pattern_engine import PATTERN_SPECS
from fomo_analysis.v3_3_pattern_engine import MODEL_VERSION, RULE_VERSION
from fomo_analysis.v3_pattern_engine import number


SUPPORTED = {"validated_positive_edge", "validated_risk_pattern"}

CONTEXT_PRIORITY = {
    "validated_positive_edge": 0,
    "validated_risk_pattern": 1,
    "candidate_under_review": 2,
    "observed_risk": 3,
    "observed_behavior": 4,
    "insufficient_evidence": 5,
    "rejected_hypothesis": 6,
}

STATUS_TEXT = {
    "validated_positive_edge": "validated positive edge",
    "validated_risk_pattern": "validated risk pattern",
    "candidate_under_review": "candidate under review",
    "observed_risk": "observed risk",
    "observed_behavior": "observed behavior",
    "insufficient_evidence": "early evidence only",
    "rejected_hypothesis": "unsupported hypothesis",
}

BEHAVIOR_TEXT = {
    "first_dip_buyer": "Bought an 8-35% pullback after a strong one-hour rise.",
    "recovery_confirmed_dip_buyer": "Bought a deep pullback after five-minute price momentum turned upward.",
    "deep_panic_buyer": "Bought at least 40% below the recent four-hour high.",
    "momentum_rider": "Bought while short-term momentum was positive and accelerating.",
    "early_momentum_buyer": "Bought after moderate one-hour price strength.",
    "anti_chaser": "Bought after an extreme one-hour run-up.",
    "breakout_buyer": "Bought near the recent one-hour high.",
    "breakout_retest_buyer": "Bought after a recent high was broken and retested.",
    "bottom_timing_specialist": "Bought within 5% of the recent one-hour low.",
    "conviction_sizer": "Used a purchase size at least 1.5 times the trader's historical median.",
    "revenge_sizer": "Increased size after a prior realized loss.",
    "erratic_sizer": "Used a purchase size far from the trader's recent median.",
    "weekend_specialist": "Bought during the weekend.",
    "weekday_specialist": "Bought during a weekday.",
    "early_session_specialist": "Acted within the first three trades of a session.",
    "selective_trader": "Bought after a gap at least twice the trader's normal waiting time.",
    "overtrader": "Bought while more than ten trades had occurred in the prior hour.",
    "post_loss_tilter": "Bought after a loss while size or trading frequency had increased.",
    "drawdown_recovery_discipline": "Kept size controlled after a realized loss.",
    "post_win_overconfidence": "Bought after a win while size or trading frequency had increased.",
    "hot_hand_trader": "Bought after at least two consecutive realized wins.",
    "fatigue_attention_decay": "Acted on the sixth or later trade of a session.",
    "calibrated_conviction": "Used an above-normal purchase size.",
    "repeat_token_specialist": "Bought a token the trader had traded before.",
    "first_entry_specialist": "Made the first reconstructed entry into this token.",
    "successful_reentry_trader": "Re-entered a token after an earlier position episode.",
    "chasing_reentry": "Re-entered after price had risen at least 20% since the prior exit.",
    "patient_reentry_trader": "Re-entered after waiting at least one day.",
    "focused_capital_allocator": "Used an above-normal size while one position represented at least half of active reconstructed capital.",
    "overextended_trader": "Bought while at least ten reconstructed positions were open.",
    "capital_rotation_specialist": "Re-entered within one hour of an earlier token exit.",
}


def _id(*parts: Any) -> str:
    return hashlib.sha256("|".join(str(part) for part in parts).encode()).hexdigest()


def _time(value: Any) -> datetime:
    if isinstance(value, datetime): return value.astimezone(timezone.utc)
    return datetime.fromisoformat(str(value).replace("Z", "+00:00")).astimezone(timezone.utc)


def _money(value: Any) -> str | None:
    try: return f"${float(value):,.2f}"
    except (TypeError, ValueError): return None


def _action_sentence(action: dict[str, Any]) -> str:
    symbol=action.get("token_symbol") or action.get("token_address")
    amount=_money(action.get("usd_notional"))
    labels={"opening_buy":"Opened a position","addition":"Added to the position","reentry":"Re-entered the token","partial_sell":"Reduced the position","full_exit":"Closed the position","token_receipt":"Received tokens","token_transfer_out":"Transferred tokens out"}
    sentence=f"{labels.get(action.get('action_type'),'Recorded an action')} in {symbol}"
    return sentence+(f" for {amount}." if amount else ".")


def _history(rows: list[dict[str, Any]]) -> dict[str, Any] | None:
    values=[number(row.get("realized_economic_outcome") or {},"realized_return_pct") for row in rows]
    values=[value for value in values if value is not None]
    if not values:return None
    wins=[value for value in values if value>0];losses=[value for value in values if value<=0]
    return {"completed_purchase_count":len(values),"win_rate_percent":100*len(wins)/len(values),"realized_expectancy_pct":mean(values),"average_win_pct":mean(wins) if wins else None,"average_loss_pct":mean(losses) if losses else None,"metric_definition":"Arithmetic mean of completed FIFO purchase-to-disposal returns in prior matching actions; historical evidence, not a forecast."}


def _actual_outcome_text(action: dict[str, Any]) -> str:
    outcome=action.get("realized_economic_outcome") or {};status=outcome.get("realization_status")
    pnl=_money(outcome.get("realized_pnl_usd"));ret=number(outcome,"realized_return_pct")
    if action.get("side")=="BUY":
        if status=="completed": return f"This purchase was fully disposed for {pnl or 'an unavailable PnL'}"+(f" ({ret:+.2f}%)." if ret is not None else ".")
        if status=="partially_realized": return f"This purchase is partly realized; attributed realized PnL is {pnl or 'unavailable'}"+(f" ({ret:+.2f}% on disposed cost)." if ret is not None else ".")
        if status=="open_pending_disposal": return "This purchase remains open; no completed purchase-to-disposal outcome exists yet."
        return "The realized purchase outcome is unavailable because cost or disposal proceeds are incomplete."
    if action.get("side")=="SELL" and status=="realized": return f"This disposal realized {pnl or 'an unavailable PnL'}"+(f" ({ret:+.2f}% on FIFO cost)." if ret is not None else ".")
    if action.get("side")=="SELL" and status=="partially_attributed_opening_inventory_gap": return f"Only the portion traceable to purchases inside the analysis window has a known outcome: {pnl or 'PnL unavailable'}"+(f" ({ret:+.2f}% on attributed FIFO cost)." if ret is not None else ".")
    if action.get("side")=="SELL" and status=="unavailable_opening_inventory_cost_basis": return "This disposal sold inventory acquired before the analysis window, so its cost basis and realized PnL are unavailable."
    return "No reliable realized economic outcome is available for this action."


def _evidence_sentence(pattern: dict[str, Any], *, prior: bool) -> str:
    evidence = (
        pattern.get("prior_historical_evidence") if prior
        else pattern.get("historical_evidence") or pattern.get("current_aggregate_evidence")
    )
    if not evidence:
        return "No completed matching outcome was available at that time." if prior else "No completed matching outcome is available."
    count = evidence.get("completed_purchase_count", evidence.get("completed_observation_count"))
    win_rate = number(evidence, "win_rate_percent")
    expectancy = number(evidence, "realized_expectancy_pct")
    pnl = number(evidence, "realized_pnl_usd")
    parts = []
    if count is not None:
        parts.append(f"{int(count):,} completed outcome{'s' if int(count) != 1 else ''}")
    if win_rate is not None:
        parts.append(f"{win_rate:.1f}% profitable")
    if expectancy is not None:
        parts.append(f"{expectancy:+.2f}% average realized return")
    if pnl is not None:
        parts.append(f"${pnl:,.2f} realized PnL")
    if not parts:
        return "Completed economic evidence is not yet available."
    prefix = "Prior matching history" if prior else "Current matching evidence"
    return f"{prefix}: " + ", ".join(parts) + "."


def _context_sort_key(pattern: dict[str, Any]) -> tuple[int, int, str]:
    status = pattern.get("finding_status", "rejected_hypothesis")
    evidence = pattern.get("current_aggregate_evidence") or {}
    count = int(evidence.get("completed_observation_count") or 0)
    return (CONTEXT_PRIORITY.get(status, 99), -count, pattern.get("pattern_name", ""))


def _compact_action_context(pattern: dict[str, Any]) -> dict[str, Any]:
    """Keep action-time evidence; trader-wide evidence is stored once in the summary."""
    return {
        key: pattern.get(key)
        for key in (
            "pattern_key", "pattern_name", "finding_status", "direction",
            "plain_english_behavior", "facts_at_action", "prior_historical_evidence",
            "pattern_model_version", "rule_version",
        )
    }


def _compact_position_context(pattern: dict[str, Any]) -> dict[str, Any]:
    return {
        key: pattern.get(key)
        for key in (
            "pattern_key", "pattern_name", "finding_status", "recognition_event",
            "plain_english_behavior", "is_supported_pattern",
            "recognized_chapter_number", "recognized_at_action_id",
        )
    }


def _action_pattern_sentence(action: dict[str, Any], matches: list[dict[str, Any]]) -> str:
    if not matches:
        if action.get("side") == "SELL":
            return "This disposal updates the position outcome; exit patterns are assessed from the complete sell sequence."
        return "No measurable V3.3 pattern condition matched this action."
    primary = sorted(matches, key=_context_sort_key)[0]
    status = STATUS_TEXT.get(primary.get("finding_status"), primary.get("finding_status", "unclassified"))
    prefix = "Risk context" if primary.get("direction") == "risk" else "Pattern context"
    return (
        f"{prefix}: it matched {primary['pattern_name']}, currently classified as {status}. "
        f"{_evidence_sentence(primary, prior=True)}"
    )


def _recognition_chapter(actions: list[dict[str, Any]], event: str | None) -> int | None:
    buys = [i for i, row in enumerate(actions, 1) if row.get("side") == "BUY"]
    sells = [i for i, row in enumerate(actions, 1) if row.get("side") == "SELL"]
    if event == "second_verified_buy":
        return buys[1] if len(buys) >= 2 else None
    if event == "second_verified_sell":
        return sells[1] if len(sells) >= 2 else None
    if event == "first_addition_below_opening_price":
        return next((i for i, row in enumerate(actions, 1) if row.get("action_type") == "addition"), None)
    if event == "episode_close":
        return sells[-1] if sells else None
    return None


def _position_pattern_sentence(pattern: dict[str, Any], *, newly_visible: bool) -> str:
    status = STATUS_TEXT.get(pattern.get("finding_status"), pattern.get("finding_status", "unclassified"))
    article = "an" if status[:1].lower() in "aeiou" else "a"
    if newly_visible:
        lead = f"This step first made the {pattern['pattern_name']} position pattern visible"
    else:
        lead = f"The {pattern['pattern_name']} position pattern remained active"
    return f"{lead}; it is {article} {status}. {_evidence_sentence(pattern, prior=False)}"


def build_v3_3_action_assessments(trader_id: str, action_rows: Iterable[dict[str, Any]], patterns: Iterable[dict[str, Any]], *, assessed_at: datetime | None=None) -> list[dict[str, Any]]:
    generated=(assessed_at or datetime.now(timezone.utc)).astimezone(timezone.utc)
    results={row["key"]:row for row in patterns};specs={spec.key:spec for spec in PATTERN_SPECS if spec.source_dataset=="action"}
    ordered=sorted(action_rows,key=lambda row:(_time(row["timestamp"]),row["action_id"])); assessments=[]
    completed_history={}
    for key,spec in specs.items():
        rows=[]
        for candidate in ordered:
            outcome=candidate.get("realized_economic_outcome") or {};completed=outcome.get("completed_at")
            if candidate.get("action_type") in spec.eligible_action_types and completed and spec.matches(candidate):
                rows.append((_time(completed),candidate))
        rows.sort(key=lambda item:(item[0],item[1]["action_id"]))
        completed_history[key]=([item[0] for item in rows],[item[1] for item in rows])
    for action in ordered:
        observed_at=_time(action["timestamp"]);matches=[]
        for key,spec in specs.items():
            if key not in results or action.get("action_type") not in spec.eligible_action_types or not spec.matches(action):continue
            result=results[key]
            times,history=completed_history[key]
            prior=history[:bisect_right(times,observed_at)]
            matches.append({"pattern_key":key,"pattern_name":result["name"],"finding_status":result["finding_status"],"direction":result["direction"],"plain_english_behavior":BEHAVIOR_TEXT.get(key,f"Matched the measurable conditions for {result['name']}."),"facts_at_action":{feature:action.get(feature) for feature in result.get("required_features",[])},"prior_historical_evidence":_history(prior),"current_aggregate_evidence":result.get("historical_evidence"),"current_baseline_comparison":result.get("comparison"),"current_scores":result.get("scores"),"pattern_model_version":MODEL_VERSION,"rule_version":RULE_VERSION})
        matches.sort(key=_context_sort_key)
        supported=[row for row in matches if row["finding_status"] in SUPPORTED]
        primary=next((row for row in supported if row["finding_status"]=="validated_positive_edge"),supported[0] if supported else None)
        primary_context=matches[0] if matches else None
        assessment_text=_action_sentence(action)+" "+_action_pattern_sentence(action,matches)
        assessments.append({"assessment_id":_id(action["action_id"],MODEL_VERSION,RULE_VERSION),"trader_id":trader_id,"wallet":action.get("wallet"),"chain":action.get("chain"),"token_address":action.get("token_address"),"token_symbol":action.get("token_symbol"),"position_id":action.get("episode_id"),"action_id":action["action_id"],"action_type":action.get("action_type"),"observed_at":action.get("timestamp"),"assessment_mode":"retrospective_replay_with_prior_completed_evidence_only","plain_english_assessment":assessment_text,"matched_patterns":[_compact_action_context(row) for row in matches],"primary_pattern_context":_compact_action_context(primary_context) if primary_context else None,"primary_supported_pattern":_compact_action_context(primary) if primary else None,"supported_pattern_count":len(supported),"matched_pattern_count":len(matches),"historical_numbers_are_predictions":False,"actual_outcome":{"plain_english":_actual_outcome_text(action),"realized_economics":action.get("realized_economic_outcome"),"timing_diagnostic":action.get("timing_diagnostic_1h")},"market_cap_context":{"status":"available" if action.get("market_cap_usd") is not None else "unavailable","market_cap_usd":action.get("market_cap_usd"),"supply_basis":action.get("market_cap_supply_basis"),"reason":None if action.get("market_cap_usd") is not None else "Historical circulating or total supply was not indexed; market cap was not inferred."},"model_version":MODEL_VERSION,"rule_version":RULE_VERSION,"assessed_at":generated.isoformat()})
    return assessments


def build_v3_3_position_stories(
    action_rows: Iterable[dict[str, Any]],
    assessments: Iterable[dict[str, Any]],
    episode_rows: Iterable[dict[str, Any]] = (),
    patterns: Iterable[dict[str, Any]] = (),
) -> list[dict[str, Any]]:
    by_assessment={row["action_id"]:row for row in assessments};grouped:dict[str,list[dict[str,Any]]]=defaultdict(list)
    episodes={row.get("episode_id"):row for row in episode_rows if row.get("episode_id")}
    episode_specs={spec.key:spec for spec in PATTERN_SPECS if spec.source_dataset=="episode"}
    episode_findings={row["key"]:row for row in patterns if row.get("source_dataset")=="episode"}
    for action in action_rows:
        if action.get("episode_id"):grouped[action["episode_id"]].append(action)
    stories=[]
    for position_id,actions in grouped.items():
        ordered=sorted(actions,key=lambda row:(_time(row["timestamp"]),row["action_id"]));buys=[r for r in ordered if r.get("side")=="BUY"];sells=[r for r in ordered if r.get("side")=="SELL"]
        bought=sum(float(r.get("token_amount") or 0) for r in buys);sold=sum(float(r.get("token_amount") or 0) for r in sells);remaining=max(0,bought-sold)
        cost=sum(float(r.get("usd_notional") or 0) for r in buys if r.get("usd_notional") is not None);proceeds=sum(float(r.get("usd_notional") or 0) for r in sells if r.get("usd_notional") is not None)
        realized=[r.get("realized_economic_outcome") or {} for r in sells];pnl=sum(float(r.get("realized_pnl_usd") or 0) for r in realized if r.get("realized_pnl_usd") is not None)
        closed=remaining<=max(1e-18,bought*1e-6) and bool(sells);chapters=[]
        symbol=ordered[0].get("token_symbol") or ordered[0].get("token_address")
        state="closed" if closed else "open"
        episode=episodes.get(position_id)
        position_matches=[]
        if episode:
            for key,spec in episode_specs.items():
                finding=episode_findings.get(key)
                if not finding or not spec.matches(episode):continue
                if spec.recognition_event=="episode_close" and not closed:continue
                position_matches.append({
                    "pattern_key":key,
                    "pattern_name":finding["name"],
                    "finding_status":finding["finding_status"],
                    "recognition_event":spec.recognition_event,
                    "plain_english_behavior":finding["description"],
                    "historical_evidence":finding["historical_evidence"],
                    "is_supported_pattern":finding["finding_status"] in SUPPORTED,
                })
        for match in position_matches:
            match["recognized_chapter_number"] = _recognition_chapter(
                ordered, match.get("recognition_event")
            )
            chapter_number = match["recognized_chapter_number"]
            match["recognized_at_action_id"] = (
                ordered[chapter_number - 1]["action_id"] if chapter_number else None
            )
        for index,action in enumerate(ordered,1):
            assessment=by_assessment[action["action_id"]]
            newly_visible=[row for row in position_matches if row.get("recognized_chapter_number")==index]
            active=[row for row in position_matches if row.get("recognized_chapter_number") and row["recognized_chapter_number"]<=index]
            additions=[_position_pattern_sentence(row,newly_visible=True) for row in newly_visible]
            if not additions and active and action.get("side")=="SELL":
                additions=[_position_pattern_sentence(sorted(active,key=lambda row:CONTEXT_PRIORITY.get(row.get("finding_status"),99))[0],newly_visible=False)]
            chapter_assessment=" ".join([assessment["plain_english_assessment"],*additions])
            chapters.append({"chapter_number":index,"chapter_id":_id(position_id,action["action_id"],RULE_VERSION),"occurred_at":action["timestamp"],"action_id":action["action_id"],"action_type":action["action_type"],"what_happened":_action_sentence(action),"pattern_assessment":chapter_assessment,"primary_pattern_context":assessment.get("primary_pattern_context"),"primary_supported_pattern":assessment["primary_supported_pattern"],"matched_pattern_keys":[row["pattern_key"] for row in assessment["matched_patterns"]],"position_pattern_events":[_compact_position_context(row) for row in newly_visible],"active_position_patterns":[_compact_position_context(row) for row in active],"actual_progress":assessment["actual_outcome"],"assessment_id":assessment["assessment_id"]})
        supported_position=[row for row in position_matches if row["is_supported_pattern"]]
        position_assessment=(
            f"The position matches the supported {supported_position[0]['pattern_name']} pattern."
            if supported_position else
            "No supported position-management pattern was identified; observed matches remain descriptive or under review."
        )
        story_text=f"The trader {'opened and closed' if closed else 'opened and still holds'} a position in {symbol} through {len(buys)} purchase action(s) and {len(sells)} disposal action(s). Realized PnL attributed so far is ${pnl:,.2f}."
        stories.append({"story_id":_id(position_id,MODEL_VERSION,RULE_VERSION),"position_id":position_id,"trader_id":ordered[0].get("trader_id"),"wallet":ordered[0].get("wallet"),"chain":ordered[0].get("chain"),"token_address":ordered[0].get("token_address"),"token_symbol":ordered[0].get("token_symbol"),"position_state":state,"plain_english_story":story_text,"position_pattern_assessment":position_assessment,"matched_position_patterns":[_compact_position_context(row) for row in position_matches],"supported_position_pattern_count":len(supported_position),"economics":{"capital_deployed_usd":cost,"sale_proceeds_usd":proceeds,"realized_pnl_usd":pnl,"realized_return_pct":pnl/cost*100 if closed and cost else None,"remaining_token_quantity":remaining,"unrealized_pnl_usd":None,"valuation_status":"closed" if closed else "unavailable_without_current_price"},"chapters":chapters,"model_version":MODEL_VERSION,"rule_version":RULE_VERSION})
    return sorted(stories,key=lambda row:max(_time(ch["occurred_at"]) for ch in row["chapters"]),reverse=True)
