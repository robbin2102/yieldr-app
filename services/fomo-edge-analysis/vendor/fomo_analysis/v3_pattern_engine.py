"""Active V3 pattern catalog with shared validation, scoring, and economics."""

from __future__ import annotations

import math
import random
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime
from statistics import mean, median
from typing import Any, Callable, Iterable


def number(row: dict[str, Any], key: str) -> float | None:
    try:
        value = row.get(key)
        return None if value is None else float(value)
    except (TypeError, ValueError):
        return None


def timestamp(row: dict[str, Any]) -> datetime:
    value = row.get("timestamp") or row.get("opened_at")
    if isinstance(value, datetime):
        return value
    return datetime.fromisoformat(str(value).replace("Z", "+00:00"))


@dataclass(frozen=True)
class PatternDefinition:
    key: str
    name: str
    domain: str
    dataset: str
    description: str
    matches: Callable[[dict[str, Any]], bool]
    direction: int = 1

    @property
    def applicability_unit(self) -> str:
        return "position_entry" if self.dataset == "entry" else "position_episode"

    @property
    def recognition_timing(self) -> str:
        return "at_action" if self.dataset == "entry" else "at_episode_close"


def _gt(key: str, value: float) -> Callable[[dict[str, Any]], bool]:
    return lambda row: number(row, key) is not None and number(row, key) > value


def _lt(key: str, value: float) -> Callable[[dict[str, Any]], bool]:
    return lambda row: number(row, key) is not None and number(row, key) < value


PATTERNS = (
    PatternDefinition("first_dip_buyer", "First Dip Buyer", "entry_skill", "entry", "Buys 8-35% pullbacks after strong one-hour rallies.", lambda r: (number(r,"pre_return_60m_pct") or -999)>=20 and -35 <= (number(r,"drawdown_from_high_60m_pct") or 999) <= -8),
    PatternDefinition("recovery_confirmed_dip_buyer", "Recovery Confirmed Dip Buyer", "entry_skill", "entry", "Buys deep pullbacks after five-minute momentum turns positive.", lambda r: (number(r,"drawdown_from_high_60m_pct") or 999)<=-20 and (number(r,"pre_return_5m_pct") or -999)>0),
    PatternDefinition("deep_panic_buyer", "Deep Panic Buyer", "entry_skill", "entry", "Buys at least 40% below the four-hour high.", lambda r: (number(r,"drawdown_from_high_240m_pct") or 999)<=-40),
    PatternDefinition("momentum_rider", "Momentum Rider", "entry_skill", "entry", "Buys with positive and accelerating momentum.", lambda r: (number(r,"pre_return_15m_pct") or -999)>0 and (number(r,"momentum_acceleration_pct") or -999)>0),
    PatternDefinition("early_momentum_buyer", "Early Momentum Buyer", "entry_skill", "entry", "Buys after moderate 5-40% one-hour strength.", lambda r: 5 <= (number(r,"pre_return_60m_pct") or -999) <= 40),
    PatternDefinition("anti_chaser", "Anti Chaser", "entry_skill", "entry", "Extreme one-hour chase entries underperform other entries.", _gt("pre_return_60m_pct",100), -1),
    PatternDefinition("breakout_buyer", "Breakout Buyer", "entry_skill", "entry", "Buys within 3% of the one-hour rolling high.", lambda r: bool(r.get("near_rolling_high_60m"))),
    PatternDefinition("breakout_retest_buyer", "Breakout Retest Buyer", "entry_skill", "entry", "Buys a retest after price clears a prior high.", lambda r: bool(r.get("breakout_retest_60m"))),
    PatternDefinition("bottom_timing_specialist", "Bottom Timing Specialist", "entry_skill", "entry", "Buys within 5% of the one-hour low.", lambda r: 0 <= (number(r,"distance_from_low_60m_pct") or -999) <= 5),
    PatternDefinition("scaled_exiter", "Scaled Exiter", "exit_skill", "episode", "Closes positions through more than one sell leg.", _gt("sell_count",1)),
    PatternDefinition("peak_capturer", "Peak Capturer", "exit_skill", "episode", "Captures at least 60% of available favorable excursion.", _gt("peak_captured_pct",60)),
    PatternDefinition("all_at_once_exiter", "All at Once Exiter", "exit_skill", "episode", "Closes the position in one sell.", lambda r: r.get("exit_style")=="all_at_once"),
    PatternDefinition("round_tripper", "Round Tripper", "exit_skill", "episode", "Gives a meaningful unrealized gain back to 5% or less.", lambda r: bool(r.get("round_trip")), -1),
    PatternDefinition("conviction_sizer", "Conviction Sizer", "sizing", "entry", "Larger-than-normal entries outperform.", _gt("relative_size_vs_trader_median",1.5)),
    PatternDefinition("selective_scale_in_trader", "Selective Scale In Trader", "sizing", "episode", "Adds more often above than below the first entry price.", lambda r: (number(r,"add_to_winner_count") or 0) > (number(r,"add_to_loser_count") or 0)),
    PatternDefinition("averaging_down_specialist", "Averaging Down Specialist", "sizing", "episode", "Adds below the first entry price.", _gt("add_to_loser_count",0)),
    PatternDefinition("revenge_sizer", "Revenge Sizer", "sizing", "entry", "Sizes up after a loss and then underperforms.", lambda r: (number(r,"previous_trade_return_pct") or 1)<=0 and (number(r,"relative_size_vs_recent_median") or 0)>=1.2, -1),
    PatternDefinition("erratic_sizer", "Erratic Sizer", "sizing", "entry", "Extreme size deviations fail to improve outcomes.", lambda r: (number(r,"relative_size_vs_recent_median") or 1)<=0.5 or (number(r,"relative_size_vs_recent_median") or 1)>=2, -1),
    PatternDefinition("weekend_specialist", "Weekend Specialist", "timing", "entry", "Weekend entries outperform weekday entries.", lambda r: bool(r.get("is_weekend"))),
    PatternDefinition("weekday_specialist", "Weekday Specialist", "timing", "entry", "Weekday entries outperform weekend entries.", lambda r: not bool(r.get("is_weekend"))),
    PatternDefinition("early_session_specialist", "Early Session Specialist", "timing", "entry", "The first three actions of a session outperform later actions.", lambda r: (number(r,"trade_number_in_session") or 999)<=3),
    PatternDefinition("selective_trader", "Selective Trader", "behavior", "entry", "Entries after longer-than-normal gaps outperform.", lambda r: number(r,"time_since_previous_trade_minutes") is not None and number(r,"trader_median_trade_gap_minutes") is not None and number(r,"time_since_previous_trade_minutes") >= number(r,"trader_median_trade_gap_minutes")*2),
    PatternDefinition("overtrader", "Overtrader", "behavior", "entry", "Entries during high one-hour activity underperform.", _gt("trades_last_1h",10), -1),
    PatternDefinition("post_loss_tilter", "Post Loss Tilter", "behavior", "entry", "After losses, activity or size increases and outcomes weaken.", lambda r: (number(r,"consecutive_losses") or 0)>=1 and ((number(r,"post_loss_size_change_pct") or 0)>20 or (number(r,"post_loss_frequency_gap_change_pct") or 0)<-20), -1),
    PatternDefinition("drawdown_recovery_discipline", "Drawdown Recovery Discipline", "behavior", "entry", "After losses, size stays controlled and outcomes recover.", lambda r: (number(r,"consecutive_losses") or 0)>=1 and (number(r,"relative_size_vs_recent_median") or 99)<=1.2),
    PatternDefinition("post_win_overconfidence", "Post Win Overconfidence", "behavior", "entry", "After wins, size or frequency rises and outcomes weaken.", lambda r: (number(r,"consecutive_wins") or 0)>=1 and ((number(r,"post_win_size_change_pct") or 0)>20 or (number(r,"post_win_frequency_gap_change_pct") or 0)<-20), -1),
    PatternDefinition("hot_hand_trader", "Hot Hand Trader", "behavior", "entry", "Entries after winning outcomes continue to outperform.", _gt("consecutive_wins",1)),
    PatternDefinition("fatigue_attention_decay", "Fatigue Attention Decay", "behavior", "entry", "Late-session entries underperform.", lambda r: (number(r,"trade_number_in_session") or 0)>=6, -1),
    PatternDefinition("calibrated_conviction", "Calibrated Conviction", "behavior", "entry", "Above-normal size is reserved for outperforming setups.", lambda r: (number(r,"relative_size_vs_trader_median") or 0)>=1.2),
    PatternDefinition("repeat_token_specialist", "Repeat Token Specialist", "repeat_reentry", "entry", "Entries in previously traded tokens outperform first entries.", lambda r: bool(r.get("repeat_token"))),
    PatternDefinition("first_entry_specialist", "First Entry Specialist", "repeat_reentry", "entry", "First token episodes outperform later re-entries.", lambda r: (number(r,"entry_number_for_token") or 999)==1),
    PatternDefinition("successful_reentry_trader", "Successful Reentry Trader", "repeat_reentry", "entry", "Later token episodes retain positive edge.", lambda r: (number(r,"entry_number_for_token") or 0)>1),
    PatternDefinition("chasing_reentry", "Chasing Reentry", "repeat_reentry", "entry", "Re-entry after a 20% post-exit run-up underperforms.", _gt("price_move_since_prior_exit_pct",20), -1),
    PatternDefinition("patient_reentry_trader", "Patient Reentry Trader", "repeat_reentry", "entry", "Re-entry after at least one day outperforms faster re-entry.", _gt("time_since_prior_exit_minutes",1440)),
    PatternDefinition("focused_capital_allocator", "Focused Capital Allocator", "capital_efficiency", "entry", "Concentrated, larger positions outperform.", lambda r: (number(r,"capital_concentration_top_1") or 0)>=0.5 and (number(r,"relative_size_vs_trader_median") or 0)>=1.2),
    PatternDefinition("overextended_trader", "Overextended Trader", "capital_efficiency", "entry", "Entries with ten or more concurrent positions underperform.", _gt("concurrent_position_count",9), -1),
    PatternDefinition("capital_rotation_specialist", "Capital Rotation Specialist", "capital_efficiency", "entry", "Entries soon after closing a prior token position outperform.", lambda r: 0 <= (number(r,"time_since_prior_exit_minutes") or -1) <= 60),
)


CATALOG_NAMES = {
    "fast_loss_cutter": "Fast Loss Cutter", "lets_winners_run": "Lets Winners Run",
    "time_based_exiter": "Time Based Exiter", "disciplined_flat_sizer": "Disciplined Flat Sizer",
    "session_specialist": "Session Specialist", "hour_of_day_specialist": "Hour of Day Specialist",
    "short_horizon_specialist": "Short Horizon Specialist", "long_horizon_runner": "Long Horizon Runner",
    "moonshot_dependent_trader": "Moonshot Dependent Trader", "broad_based_winner": "Broad Based Winner",
    "streak_dependent_trader": "Streak Dependent Trader", "asymmetric_winner": "Asymmetric Winner",
    "high_hit_rate_grinder": "High Hit Rate Grinder", "capital_efficient_trader": "Capital Efficient Trader",
    "fast_capital_recycler": "Fast Capital Recycler",
}


DESCRIPTIVE_ONLY_KEYS = {"peak_capturer", "round_tripper"}


def _values(rows: list[dict[str, Any]], outcome_key: str, factor: int = 1) -> list[float]:
    return [factor * value for row in rows if (value := number(row, outcome_key)) is not None]


def _uplift(left: list[dict[str, Any]], right: list[dict[str, Any]], key: str, factor: int) -> float | None:
    a, b = _values(left,key,factor), _values(right,key,factor)
    return mean(a)-mean(b) if a and b else None


def _bootstrap(left: list[float], right: list[float], confidence: float, samples: int=1500) -> list[float | None]:
    if not left or not right: return [None,None]
    rng=random.Random(17)
    estimates=sorted(mean(rng.choices(left,k=len(left)))-mean(rng.choices(right,k=len(right))) for _ in range(samples))
    tail=(1-confidence)/2
    return [round(estimates[max(0,int(tail*samples))],6), round(estimates[min(samples-1,int((1-tail)*samples))],6)]


def _drop_top(values: list[float], count: int) -> list[float]:
    return sorted(values)[:-count] if count and len(values)>count else []


def _independent_entry_samples(
    rows: list[dict[str, Any]], definition: PatternDefinition
) -> list[dict[str, Any]]:
    """Use at most one statistical observation per reconstructed episode."""
    if definition.dataset != "entry":
        return rows
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        grouped[str(row.get("episode_id") or row.get("trade_id"))].append(row)
    samples = []
    for episode_rows in grouped.values():
        ordered = sorted(episode_rows, key=timestamp)
        samples.append(ordered[0])
    return samples


def _pattern_economics(matching: list[dict[str, Any]], all_rows: list[dict[str, Any]]) -> dict[str, Any]:
    pnl_key = "allocated_realized_pnl_usd" if any("allocated_realized_pnl_usd" in row for row in matching) else "realized_pnl_usd"
    capital_key = "absolute_size_usd" if any("absolute_size_usd" in row for row in matching) else "capital_deployed_usd"
    pnls=[number(row,pnl_key) for row in matching]; pnls=[v for v in pnls if v is not None]
    total=[number(row,pnl_key) for row in all_rows]; total=[v for v in total if v is not None]
    capital=[number(row,capital_key) for row in matching]; capital=[v for v in capital if v is not None]
    days={timestamp(row).date().isoformat() for row in matching}
    weeks={(timestamp(row).isocalendar().year,timestamp(row).isocalendar().week) for row in matching}
    pattern_pnl=sum(pnls) if pnls else None
    gross=sum(capital) if capital else None
    is_entry = capital_key == "absolute_size_usd"

    def is_closed(row: dict[str, Any]) -> bool:
        return bool(
            row.get("episode_closed_at") or row.get("closed_at")
        )

    completed = [row for row in matching if is_closed(row)]
    completed_capital = [number(row, capital_key) for row in completed]
    completed_capital = [value for value in completed_capital if value is not None]
    completed_pnl = [number(row, pnl_key) for row in completed]
    completed_pnl = [value for value in completed_pnl if value is not None]
    remaining_basis = []
    for row in matching:
        if is_closed(row):
            continue
        if is_entry:
            amount = number(row, capital_key)
            fraction = number(row, "episode_remaining_quantity_fraction")
            if amount is not None and fraction is not None:
                remaining_basis.append(amount * fraction)
        else:
            value = number(row, "remaining_cost_basis_usd")
            if value is not None:
                remaining_basis.append(value)
    events=[]
    for row in matching:
        amount=number(row,capital_key)
        opened=row.get("timestamp") or row.get("opened_at")
        closed=row.get("episode_closed_at") or row.get("closed_at")
        if amount is None or opened is None: continue
        events.append((timestamp({"timestamp":opened}),1,amount))
        if closed is not None: events.append((timestamp({"timestamp":closed}),-1,-amount))
    active=estimated_base=0.0
    for _,_,delta in sorted(events,key=lambda item:(item[0],item[1])):
        active+=delta; estimated_base=max(estimated_base,active)
    estimated_base=estimated_base or None
    period_times = [timestamp(row) for row in matching]
    live_yield = pattern_pnl / gross * 100 if pattern_pnl is not None and gross else None
    completed_pnl_total = sum(completed_pnl) if completed_pnl else None
    completed_cost_total = sum(completed_capital) if completed_capital else None
    completed_yield = (
        completed_pnl_total / completed_cost_total * 100
        if completed_pnl_total is not None and completed_cost_total else None
    )
    return {
        "n_occurrences": len({r.get("episode_id") for r in matching}),
        "matching_action_count": (
            len({r.get("episode_id") for r in matching}) if is_entry else None
        ),
        "attributable_acquisition_count": len(matching) if is_entry else None,
        "matching_episode_count": len({r.get("episode_id") for r in matching}),
        "n_independent_tokens": len({(r.get("chain"),r.get("token_address")) for r in matching}),
        "n_active_days": len(days), "n_active_weeks": len(weeks),
        "pattern_realized_pnl_usd": pattern_pnl,
        "pattern_pnl_share": pattern_pnl/sum(total) if pattern_pnl is not None and total and sum(total) else None,
        "gross_capital_deployed_usd": gross,
        "realized_yield_on_deployed_capital_pct": live_yield,
        "live_view_label": "Realized to date; includes capital in open positions.",
        "remaining_open_cost_basis_usd": sum(remaining_basis) if remaining_basis else 0.0,
        "unrealized_pnl_usd": None,
        "open_episode_count": len({r.get("episode_id") for r in matching if not is_closed(r)}),
        "completed_episode_count": len({r.get("episode_id") for r in completed}),
        "completed_only": {
            "realized_pnl_usd": completed_pnl_total,
            "gross_capital_deployed_usd": completed_cost_total,
            "realized_yield_on_deployed_capital_pct": completed_yield,
            "episode_count": len({r.get("episode_id") for r in completed}),
        },
        "peak_concurrent_capital_usd": estimated_base,
        "analysis_period_start": min(period_times).isoformat() if period_times else None,
        "analysis_period_end": max(period_times).isoformat() if period_times else None,
        "valuation_timestamp": None,
        "valuation_status": "unavailable_without_current_price",
        "accounting_method": (
            "entry_leg_cost_basis_with_episode_realized_pnl_allocated_pro_rata_by_acquisition_cost"
            if is_entry else "whole_episode_cost_basis_and_realized_pnl"
        ),
        "fee_treatment": "uses_normalized_trade_notionals; fee inclusion follows source transaction accounting",
        "capital_basis_provenance": "cumulative_matched_acquisition_cost",
        "provenance": {
            "capital_deployed": "estimated" if gross is not None else "unavailable",
            "realized_pnl": "estimated" if pattern_pnl is not None else "unavailable",
            "unrealized_pnl": "unavailable",
            "source": "normalized onchain trade notionals and reconstructed position episodes",
        },
        "overlap_warning": "An episode may match multiple patterns; do not sum pattern PnL as independent portfolio profit.",
    }


def validate_pattern(definition: PatternDefinition, rows: list[dict[str, Any]], correction_count: int) -> dict[str, Any]:
    outcome_key="forward_return_240m_pct" if definition.dataset=="entry" else "realized_return_pct"
    raw_usable=[r for r in rows if number(r,outcome_key) is not None]
    usable=_independent_entry_samples(raw_usable, definition)
    matching=[r for r in usable if definition.matches(r)]; baseline=[r for r in usable if not definition.matches(r)]
    if definition.dataset == "entry":
        economic_episode_ids = {
            row.get("episode_id") or row.get("trade_id")
            for row in _independent_entry_samples(rows, definition)
            if definition.matches(row)
        }
        economic_matching = [
            row for row in rows
            if (row.get("episode_id") or row.get("trade_id")) in economic_episode_ids
        ]
    else:
        economic_matching=[r for r in rows if definition.matches(r)]
    factor=definition.direction
    left,right=_values(matching,outcome_key,factor),_values(baseline,outcome_key,factor)
    uplift=mean(left)-mean(right) if left and right else None
    median_uplift=median(left)-median(right) if left and right else None
    confidence=1-0.05/max(1,correction_count)
    ci=_bootstrap(left,right,confidence)
    ordered=sorted(usable,key=timestamp); split=int(len(ordered)*.7)
    train=ordered[:split]; holdout=ordered[split:]
    train_uplift=_uplift([r for r in train if definition.matches(r)],[r for r in train if not definition.matches(r)],outcome_key,factor)
    holdout_uplift=_uplift([r for r in holdout if definition.matches(r)],[r for r in holdout if not definition.matches(r)],outcome_key,factor)
    block_uplifts=[]
    for block in range(3):
        part=ordered[block*len(ordered)//3:(block+1)*len(ordered)//3]
        value=_uplift([r for r in part if definition.matches(r)],[r for r in part if not definition.matches(r)],outcome_key,factor)
        if value is not None: block_uplifts.append(value)
    top1=(mean(_drop_top(left,1))-mean(_drop_top(right,1))) if len(left)>1 and len(right)>1 else None
    top3=(mean(_drop_top(left,3))-mean(_drop_top(right,3))) if len(left)>3 and len(right)>3 else None
    n5a=max(1,math.ceil(len(left)*.05)); n5b=max(1,math.ceil(len(right)*.05))
    top5=(mean(_drop_top(left,n5a))-mean(_drop_top(right,n5b))) if len(left)>n5a and len(right)>n5b else None
    tokens={(r.get("chain"),r.get("token_address")) for r in matching}
    checks={
        "baseline_comparison": uplift is not None and uplift>=2,
        "positive_pattern_expectancy": (
            bool(left) and mean(left)>0 if factor==1 else True
        ),
        "positive_median_uplift": median_uplift is not None and median_uplift>0,
        "minimum_evidence": len(matching)>=30 and len(baseline)>=30,
        "cross_token_breadth": len(tokens)>=10,
        "bootstrap_confidence": ci[0] is not None and ci[0]>0,
        "remove_top_1": top1 is not None and top1>0,
        "remove_top_3": top3 is not None and top3>0,
        "remove_top_5_percent": top5 is not None and top5>0,
        "chronological_train": train_uplift is not None and train_uplift>0,
        "chronological_holdout": holdout_uplift is not None and holdout_uplift>0,
        "walk_forward": len(block_uplifts)==3 and sum(v>0 for v in block_uplifts)>=2,
    }
    recent=ordered[-max(30,int(len(ordered)*.2)):]
    recent_uplift=_uplift([r for r in recent if definition.matches(r)],[r for r in recent if not definition.matches(r)],outcome_key,factor)
    health=("dead" if recent_uplift is None else "decaying" if recent_uplift<=0 else "weakening" if uplift and recent_uplift<.75*uplift else "strengthening" if uplift and recent_uplift>1.25*uplift else "stable")
    edge_score=max(0,min(10,round(((uplift or 0)/2+(median_uplift or 0)/2)/2,2)))
    reliability_score=round(10*sum(checks[k] for k in ("minimum_evidence","cross_token_breadth","bootstrap_confidence","remove_top_1","remove_top_3","remove_top_5_percent"))/6,2)
    persistence_score=round(10*sum(checks[k] for k in ("chronological_train","chronological_holdout","walk_forward"))/3,2)
    luck_risk="low" if checks["remove_top_1"] and checks["remove_top_3"] and checks["remove_top_5_percent"] else "medium" if checks["remove_top_1"] else "high"
    result = {
        "pattern_model_version":"3.1.4",
        "pattern_key":definition.key,"pattern_name":definition.name,"domain":definition.domain,
        "description":definition.description,"direction":"positive_edge" if factor==1 else "negative_anti_pattern",
        "applicability_unit": definition.applicability_unit,
        "recognition_timing": definition.recognition_timing,
        "status":"validated" if all(checks.values()) and health not in {"decaying","dead"} else "candidate_rejected",
        "outcome_key":outcome_key,"occurrence_count":len(matching),"baseline_count":len(baseline),
        "independent_token_count":len(tokens),"adjusted_mean_uplift_pct":None if uplift is None else round(uplift,6),
        "adjusted_median_uplift_pct":None if median_uplift is None else round(median_uplift,6),
        "bootstrap_confidence":round(confidence,6),"bootstrap_uplift_ci_pct":ci,
        "train_uplift_pct":train_uplift,"holdout_uplift_pct":holdout_uplift,"walk_forward_uplifts_pct":block_uplifts,
        "recent_uplift_pct":recent_uplift,"edge_health":health,
        "edge_score":edge_score,"reliability_score":reliability_score,"persistence_score":persistence_score,
        "luck_risk":luck_risk,"checks":checks,"failed_checks":[k for k,v in checks.items() if not v],
        "behavioral_discipline_score": (
            round((reliability_score+persistence_score)/2,2)
            if definition.domain in {"behavior","sizing","exit_skill"} and factor==1
            else round(10-(reliability_score+persistence_score)/2,2)
            if definition.domain in {"behavior","sizing","exit_skill"} and factor==-1
            else None
        ),
        "economics":_pattern_economics(economic_matching,rows),
    }
    if definition.key in DESCRIPTIVE_ONLY_KEYS:
        result["status"] = "descriptive_signal" if matching else "candidate_rejected"
        result["validation_limitation"] = (
            "Signature uses realized outcome fields and cannot be validated against "
            "the same outcome without leakage. It remains an exit diagnostic."
        )
    return result


def _aggregate_patterns(entries: list[dict[str,Any]], episodes: list[dict[str,Any]], economics: dict[str,Any]) -> list[dict[str,Any]]:
    results=[]
    def add(key,status,evidence,domain):
        results.append({
            "pattern_model_version":"3.1.4",
            "pattern_key":key,"pattern_name":CATALOG_NAMES[key],"domain":domain,
            "applicability_unit":"trader_period",
            "recognition_timing":"after_analysis_period",
            "status":"descriptive_signal" if status=="validated" else status,
            "evidence":evidence,
            "validation_limitation":"Aggregate signature is built; shared bootstrap/baseline/walk-forward validation is not yet applicable.",
        })
    realized=[r for r in episodes if number(r,"realized_return_pct") is not None]
    wins=[r for r in realized if number(r,"realized_return_pct")>0]; losses=[r for r in realized if number(r,"realized_return_pct")<=0]
    win_hold=[number(r,"time_to_full_exit_minutes") for r in wins]; win_hold=[v for v in win_hold if v is not None]
    loss_hold=[number(r,"time_to_full_exit_minutes") for r in losses]; loss_hold=[v for v in loss_hold if v is not None]
    hold_ratio=median(win_hold)/median(loss_hold) if win_hold and loss_hold and median(loss_hold) else None
    add("fast_loss_cutter","validated" if hold_ratio and hold_ratio>1.5 and len(loss_hold)>=30 else "candidate_rejected",{"winner_vs_loser_hold_ratio":hold_ratio,"loss_count":len(loss_hold)},"exit_skill")
    add("lets_winners_run","validated" if hold_ratio and hold_ratio>1.5 and len(win_hold)>=30 else "candidate_rejected",{"winner_vs_loser_hold_ratio":hold_ratio,"win_count":len(win_hold)},"exit_skill")
    holds=[number(r,"time_to_full_exit_minutes") for r in realized]; holds=[v for v in holds if v is not None]
    hold_cv=(math.sqrt(mean((v-mean(holds))**2 for v in holds))/mean(holds)) if holds and mean(holds) else None
    add("time_based_exiter","validated" if hold_cv is not None and hold_cv<.5 and len(holds)>=50 else "candidate_rejected",{"hold_time_cv":hold_cv,"count":len(holds)},"exit_skill")
    size_cv=number(economics,"entry_size_coefficient_of_variation")
    add("disciplined_flat_sizer","validated" if size_cv is not None and size_cv<.3 and len(entries)>=50 else "candidate_rejected",{"size_cv":size_cv,"count":len(entries)},"sizing")
    usable=[r for r in entries if number(r,"forward_return_240m_pct") is not None]
    def best_group(field):
        groups=defaultdict(list)
        for r in usable: groups[str(r.get(field))].append(number(r,"forward_return_240m_pct"))
        groups={k:[v for v in vals if v is not None] for k,vals in groups.items()}
        eligible={k:v for k,v in groups.items() if len(v)>=30}
        if not eligible:return None,None,0
        key=max(eligible,key=lambda k:mean(eligible[k])); others=[v for k,vals in eligible.items() if k!=key for v in vals]
        return key,(mean(eligible[key])-mean(others) if others else None),len(eligible[key])
    session,uplift,count=best_group("session_bucket"); add("session_specialist","validated" if uplift and uplift>=2 else "candidate_rejected",{"best_session":session,"uplift_pct":uplift,"count":count},"timing")
    hour,uplift,count=best_group("hour_utc"); add("hour_of_day_specialist","validated" if uplift and uplift>=2 and count>=30 else "candidate_rejected",{"best_hour_utc":hour,"uplift_pct":uplift,"count":count},"timing")
    median_hold=median(holds) if holds else None
    short=[r for r in realized if median_hold is not None and (number(r,"time_to_full_exit_minutes") or math.inf)<=median_hold]
    long=[r for r in realized if median_hold is not None and (number(r,"time_to_full_exit_minutes") or -1)>median_hold]
    short_up=_uplift(short,long,"realized_return_pct",1); long_up=None if short_up is None else -short_up
    add("short_horizon_specialist","validated" if short_up and short_up>=2 and len(short)>=30 else "candidate_rejected",{"uplift_pct":short_up,"count":len(short)},"timing")
    add("long_horizon_runner","validated" if long_up and long_up>=2 and len(long)>=30 else "candidate_rejected",{"uplift_pct":long_up,"count":len(long)},"timing")
    best_share=number(economics,"best_trade_profit_share"); top3=number(economics,"top_3_profit_share"); hhi=number(economics,"token_profit_hhi")
    moonshot=bool((best_share or 0)>.35 or (top3 or 0)>.65)
    add("moonshot_dependent_trader","validated" if moonshot else "candidate_rejected",{"best_share":best_share,"top3_share":top3},"reliability")
    broad=bool((number(economics,"expectancy_pct") or 0)>0 and (number(economics,"median_trade_return_pct") or 0)>0 and hhi is not None and hhi<.15)
    add("broad_based_winner","validated" if broad else "candidate_rejected",{"token_profit_hhi":hhi,"expectancy_pct":number(economics,"expectancy_pct")},"reliability")
    profit_by_week=defaultdict(float)
    for r in realized:
        t=timestamp(r).isocalendar(); profit_by_week[(t.year,t.week)]+=max(0,number(r,"realized_pnl_usd") or 0)
    gross=sum(profit_by_week.values()); week_share=max(profit_by_week.values())/gross if gross and profit_by_week else None
    add("streak_dependent_trader","validated" if week_share and week_share>.5 else "candidate_rejected",{"best_week_profit_share":week_share},"reliability")
    expectancy=number(economics,"expectancy_pct"); win_rate=number(economics,"win_rate_percent"); payoff=number(economics,"payoff_ratio"); median_return=number(economics,"median_trade_return_pct")
    asym=bool(expectancy and expectancy>0 and win_rate is not None and win_rate<55 and payoff and payoff>=2 and not moonshot)
    add("asymmetric_winner","validated" if asym else "candidate_rejected",{"expectancy_pct":expectancy,"win_rate_percent":win_rate,"payoff_ratio":payoff,"moonshot_risk":moonshot},"payoff_profile")
    grinder=bool(expectancy and expectancy>0 and win_rate and win_rate>=60 and median_return and median_return>0)
    add("high_hit_rate_grinder","validated" if grinder else "candidate_rejected",{"expectancy_pct":expectancy,"win_rate_percent":win_rate,"median_return_pct":median_return},"payoff_profile")
    yoc=(number(economics,"realized_return_on_rolling_capital_pct") or number(economics,"realized_return_on_minimum_funding_pct") or number(economics,"realized_yield_on_deployed_capital_pct") or number(economics,"estimated_yield_on_capital_pct")); turnover=number(economics,"capital_turnover")
    add("capital_efficient_trader","validated" if yoc and yoc>20 and expectancy and expectancy>0 else "candidate_rejected",{"realized_return_on_rolling_capital_pct":yoc,"rolling_capital_deployed_usd":number(economics,"rolling_capital_deployed_usd"),"expectancy_pct":expectancy,"provenance":economics.get("capital_basis_provenance")},"capital_efficiency")
    add("fast_capital_recycler","validated" if turnover and turnover>3 and expectancy and expectancy>0 and median_hold and median_hold<1440 else "candidate_rejected",{"turnover":turnover,"median_hold_minutes":median_hold,"realized_return_on_rolling_capital_pct":yoc},"capital_efficiency")
    return results


def run_v3_pattern_engine(entries: Iterable[dict[str,Any]], episodes: Iterable[dict[str,Any]], economics: dict[str,Any], readiness: dict[str,Any]) -> dict[str,Any]:
    entry_rows=list(entries); episode_rows=list(episodes)
    binary=[]
    for definition in PATTERNS:
        rows=entry_rows if definition.dataset=="entry" else episode_rows
        binary.append(validate_pattern(definition,rows,len(PATTERNS)))
    patterns=binary+_aggregate_patterns(entry_rows,episode_rows,economics)
    if readiness.get("status") != "ready":
        for pattern in patterns:
            if pattern["status"] == "validated":
                pattern["status"] = "provisional_blocked_price_coverage"
    return {
        "pattern_model_version":"3.1.4",
        "status":"complete" if readiness.get("status")=="ready" else "provisional_price_coverage",
        "catalog_pattern_count":len(patterns),
        "validated_count":sum(row["status"]=="validated" for row in patterns),
        "rejected_count":sum(row["status"]=="candidate_rejected" for row in patterns),
        "descriptive_signal_count":sum(row["status"]=="descriptive_signal" for row in patterns),
        "provisional_count":sum(row["status"]=="provisional_blocked_price_coverage" for row in patterns),
        "patterns":patterns,
    }
