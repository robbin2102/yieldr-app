"""Realized-outcome-first pattern validation for Yieldr V3.3."""

from __future__ import annotations

import math
import random
from collections import defaultdict
from datetime import datetime
from statistics import mean, median
from typing import Any, Iterable

from fomo_analysis.v3_2_pattern_engine import (
    PATTERN_SPECS,
    RETROSPECTIVE_ONLY_KEYS,
    PatternSpec,
    RISK,
)
from fomo_analysis.v3_pattern_engine import number
from fomo_analysis.v3_pattern_engine import CATALOG_NAMES


MODEL_VERSION = "3.3.0"
RULE_VERSION = "2026-09-09.2"
MIN_MATCHING = 30
MIN_BASELINE = 30
MIN_TOKENS = 10
MIN_GROUPS = 8


def _time(row: dict[str, Any]) -> datetime:
    value = row.get("timestamp") or row.get("opened_at")
    if isinstance(value, datetime):
        return value
    return datetime.fromisoformat(str(value).replace("Z", "+00:00"))


def _eligible(row: dict[str, Any], spec: PatternSpec) -> bool:
    return spec.source_dataset == "episode" or row.get("action_type") in spec.eligible_action_types


def _outcome(row: dict[str, Any], spec: PatternSpec) -> float | None:
    if spec.source_dataset == "episode":
        # `roi_pct` is reconstructed directly from the position's known cost
        # and disposal proceeds. `realized_return_pct` belongs to the optional
        # candle-path join and must not gate completed economic outcomes.
        return number(row, "roi_pct")
    outcome = row.get("realized_economic_outcome") or {}
    if not outcome.get("is_completed_observation"):
        return None
    return number(outcome, "realized_return_pct")


def _pnl(row: dict[str, Any], spec: PatternSpec) -> float | None:
    if spec.source_dataset == "episode":
        return number(row, "realized_pnl_usd")
    return number(row.get("realized_economic_outcome") or {}, "realized_pnl_usd")


def _capital(row: dict[str, Any], spec: PatternSpec) -> float | None:
    if spec.source_dataset == "episode":
        return number(row, "capital_deployed_usd")
    return number(row.get("realized_economic_outcome") or {}, "realized_cost_basis_usd")


def _group(row: dict[str, Any]) -> str:
    at = _time(row); iso = at.isocalendar()
    return f"{row.get('chain')}|{row.get('token_address')}|{iso.year}-W{iso.week:02d}"


def _summary(rows: list[dict[str, Any]], spec: PatternSpec) -> dict[str, Any]:
    values = [value for row in rows if (value := _outcome(row, spec)) is not None]
    wins = [value for value in values if value > 0]
    losses = [value for value in values if value <= 0]
    pnls = [value for row in rows if (value := _pnl(row, spec)) is not None]
    capital = [value for row in rows if (value := _capital(row, spec)) is not None]
    return {
        "completed_observation_count": len(values),
        "profitable_count": len(wins),
        "loss_count": len(losses),
        "win_rate_percent": 100 * len(wins) / len(values) if values else None,
        "realized_expectancy_pct": mean(values) if values else None,
        "median_realized_return_pct": median(values) if values else None,
        "average_win_pct": mean(wins) if wins else None,
        "average_loss_pct": mean(losses) if losses else None,
        "payoff_ratio": mean(wins) / abs(mean(losses)) if wins and losses and mean(losses) else None,
        "realized_pnl_usd": sum(pnls) if pnls else None,
        "realized_cost_basis_usd": sum(capital) if capital else None,
        "return_on_realized_cost_pct": sum(pnls) / sum(capital) * 100 if pnls and capital and sum(capital) else None,
        "independent_token_count": len({(row.get("chain"), row.get("token_address")) for row in rows if _outcome(row, spec) is not None}),
        "independent_position_count": len({row.get("episode_id") for row in rows if row.get("episode_id") and _outcome(row, spec) is not None}),
        "active_week_count": len({_group(row) for row in rows if _outcome(row, spec) is not None}),
    }


def _bootstrap_uplift(
    left: list[dict[str, Any]], right: list[dict[str, Any]], spec: PatternSpec,
    samples: int = 1500, confidence: float = .95,
) -> list[float | None]:
    factor = -1 if spec.direction == RISK else 1
    grouped_left: dict[str, list[float]] = defaultdict(list)
    grouped_right: dict[str, list[float]] = defaultdict(list)
    for row in left:
        if (value := _outcome(row, spec)) is not None: grouped_left[_group(row)].append(value)
    for row in right:
        if (value := _outcome(row, spec)) is not None: grouped_right[_group(row)].append(value)
    a = [mean(values) for values in grouped_left.values()]
    b = [mean(values) for values in grouped_right.values()]
    if not a or not b: return [None, None]
    rng = random.Random(33)
    estimates = sorted(factor * (mean(rng.choices(a, k=len(a))) - mean(rng.choices(b, k=len(b)))) for _ in range(samples))
    tail=(1-confidence)/2
    return [
        estimates[max(0,int(samples*tail))],
        estimates[min(samples-1,int(samples*(1-tail)))],
    ]


def _walk_forward_uplifts(rows: list[dict[str, Any]], spec: PatternSpec) -> list[float]:
    """Evaluate three non-overlapping future blocks after expanding history."""
    ordered=sorted(rows,key=_time);count=len(ordered);values=[]
    for start_fraction,end_fraction in ((.5,.65),(.65,.8),(.8,1.0)):
        block=ordered[int(count*start_fraction):int(count*end_fraction)]
        matching=[_outcome(row,spec) for row in block if spec.matches(row)]
        baseline=[_outcome(row,spec) for row in block if not spec.matches(row)]
        matching=[value for value in matching if value is not None]
        baseline=[value for value in baseline if value is not None]
        if matching and baseline:
            factor=-1 if spec.direction==RISK else 1
            values.append(factor*(mean(matching)-mean(baseline)))
    return values


def validate_pattern_v3_3(spec: PatternSpec, rows: Iterable[dict[str, Any]]) -> dict[str, Any]:
    eligible = [row for row in rows if _eligible(row, spec)]
    observed = [row for row in eligible if spec.matches(row)]
    usable = [row for row in eligible if _outcome(row, spec) is not None]
    matching = [row for row in usable if spec.matches(row)]
    baseline = [row for row in usable if not spec.matches(row)]
    raw_left = [_outcome(row, spec) for row in matching]
    raw_right = [_outcome(row, spec) for row in baseline]
    left = [value for value in raw_left if value is not None]
    right = [value for value in raw_right if value is not None]
    factor = -1 if spec.direction == RISK else 1
    uplift = factor * (mean(left) - mean(right)) if left and right else None
    median_uplift = factor * (median(left) - median(right)) if left and right else None
    absolute_edge = factor * mean(left) if left else None
    adjusted=sorted((factor*value for value in left),reverse=True)
    def stressed(drop_count: int) -> float | None:
        remaining=adjusted[drop_count:]
        return mean(remaining) if remaining else None
    top_five_count=max(1,math.ceil(len(adjusted)*.05)) if adjusted else 0
    best_removed_expectancy=stressed(1)
    top_three_removed_expectancy=stressed(3)
    top_five_percent_removed_expectancy=stressed(top_five_count)
    winning_tokens = len({(row.get("chain"), row.get("token_address")) for row in matching if (_outcome(row, spec) or 0) > 0})
    matched_summary = _summary(matching, spec)
    baseline_summary = _summary(baseline, spec)
    asymmetric_tail = bool(
        spec.direction != RISK
        and matched_summary["win_rate_percent"] is not None
        and matched_summary["win_rate_percent"] <= 50
        and (matched_summary["payoff_ratio"] or 0) > 1
        and (matched_summary["realized_expectancy_pct"] or 0) > 0
        and winning_tokens >= 3
        and (best_removed_expectancy or 0) > 0
    )
    ordered = sorted(usable, key=_time); split = int(len(ordered) * .7)
    train, holdout = ordered[:split], ordered[split:]
    def part_uplift(part: list[dict[str, Any]]) -> float | None:
        a=[_outcome(row,spec) for row in part if spec.matches(row)]; b=[_outcome(row,spec) for row in part if not spec.matches(row)]
        a=[v for v in a if v is not None]; b=[v for v in b if v is not None]
        return factor*(mean(a)-mean(b)) if a and b else None
    holdout_matching=[row for row in holdout if spec.matches(row)]
    holdout_values=[_outcome(row,spec) for row in holdout_matching];holdout_values=[v for v in holdout_values if v is not None]
    train_uplift=part_uplift(train);holdout_uplift=part_uplift(holdout)
    ci=_bootstrap_uplift(matching,baseline,spec)
    corrected_confidence=1-(.05/max(1,len(PATTERN_SPECS)))
    corrected_ci=_bootstrap_uplift(matching,baseline,spec,confidence=corrected_confidence)
    walk_forward=_walk_forward_uplifts(usable,spec)
    recent_start=max(1,int(len(ordered)*.75))
    older_matches=[row for row in ordered[:recent_start] if spec.matches(row)]
    recent_matches=[row for row in ordered[recent_start:] if spec.matches(row)]
    older_values=[factor*_outcome(row,spec) for row in older_matches if _outcome(row,spec) is not None]
    recent_values=[factor*_outcome(row,spec) for row in recent_matches if _outcome(row,spec) is not None]
    older_expectancy=mean(older_values) if older_values else None
    recent_expectancy=mean(recent_values) if recent_values else None
    if recent_expectancy is None or older_expectancy is None: recent_health="insufficient_evidence"
    elif recent_expectancy<=0: recent_health="dead"
    elif older_expectancy>0 and recent_expectancy<older_expectancy*.75: recent_health="weakening"
    elif older_expectancy>0 and recent_expectancy>older_expectancy*1.25: recent_health="strengthening"
    else: recent_health="stable"
    tokens={(row.get("chain"),row.get("token_address")) for row in matching}
    groups={_group(row) for row in matching}
    checks={
        "minimum_evidence":len(matching)>=MIN_MATCHING and len(baseline)>=MIN_BASELINE,
        "cross_token_breadth":len(tokens)>=MIN_TOKENS,
        "dependence_group_breadth":len(groups)>=MIN_GROUPS,
        "positive_realized_expectancy":absolute_edge is not None and absolute_edge>0,
        "outperforms_trader_baseline":uplift is not None and uplift>0,
        "best_observation_removed":best_removed_expectancy is not None and best_removed_expectancy>0,
        "top_three_observations_removed":top_three_removed_expectancy is not None and top_three_removed_expectancy>0,
        "top_five_percent_removed":top_five_percent_removed_expectancy is not None and top_five_percent_removed_expectancy>0,
        "chronological_holdout_expectancy":bool(holdout_values) and factor*mean(holdout_values)>0,
                "chronological_holdout_uplift":holdout_uplift is not None and holdout_uplift>0,
        "walk_forward_persistence":len(walk_forward)>=2 and sum(value>0 for value in walk_forward)>=math.ceil(len(walk_forward)*2/3),
        "group_bootstrap_confidence":ci[0] is not None and ci[0]>0,
        "multiple_testing_control":corrected_ci[0] is not None and corrected_ci[0]>0,
        "recent_edge_health":recent_health in {"stable","strengthening"},
    }
    required=all(checks.values())
    if spec.key in RETROSPECTIVE_ONLY_KEYS and observed:
        status="observed_risk" if spec.direction==RISK else "observed_behavior"
    elif not observed: status="rejected_hypothesis"
    elif len(matching)<MIN_MATCHING or len(baseline)<MIN_BASELINE: status="insufficient_evidence"
    elif required: status="validated_risk_pattern" if spec.direction==RISK else "validated_positive_edge"
    elif absolute_edge is not None and absolute_edge>0 and uplift is not None and uplift>0: status="candidate_under_review"
    else: status="observed_risk" if spec.direction==RISK else "observed_behavior"
    return {
        **spec.contract(), "pattern_model_version":MODEL_VERSION,"rule_version":RULE_VERSION,
        "finding_status":status,"direction":spec.direction,
        "primary_outcome":"completed_position_realized_return" if spec.source_dataset=="episode" else "completed_acquisition_purchase_to_disposal_return",
        "timing_diagnostic_role":"supporting_only",
        "populations":{"observed_match_count":len(observed),"completed_match_count":len(matching),"completed_baseline_count":len(baseline),"independent_token_count":len(tokens),"dependence_group_count":len(groups)},
        "historical_evidence":matched_summary,
        "trader_baseline_evidence":baseline_summary,
        "comparison":{"direction_adjusted_expectancy_uplift_pct":uplift,"direction_adjusted_median_uplift_pct":median_uplift,"train_uplift_pct":train_uplift,"holdout_uplift_pct":holdout_uplift,"group_bootstrap_uplift_ci_pct":ci},
        "payoff_shape":{"asymmetric_positive_edge":asymmetric_tail,"winning_token_count":winning_tokens,"expectancy_after_best_observation_removed_pct":best_removed_expectancy,"expectancy_after_top_three_removed_pct":top_three_removed_expectancy,"expectancy_after_top_five_percent_removed_pct":top_five_percent_removed_expectancy,"win_rate_above_50_percent":(matched_summary["win_rate_percent"] or 0)>50 if matched_summary["win_rate_percent"] is not None else None,"positive_median_return":(matched_summary["median_realized_return_pct"] or 0)>0 if matched_summary["median_realized_return_pct"] is not None else None,"note":"Win rate above 50% and positive median return are diagnostics, not validation gates."},
        "checks":checks,
        "failed_checks":[key for key,value in checks.items() if not value],
        "validation":{"checks":checks,"failed_checks":[key for key,value in checks.items() if not value],"bootstrap_uplift_ci_pct":ci,"multiple_testing_adjusted_bootstrap_ci_pct":corrected_ci,"multiple_testing_method":"Bonferroni family-wise alpha 0.05 across active action/episode rules","train_uplift_pct":train_uplift,"holdout_uplift_pct":holdout_uplift,"walk_forward_uplifts_pct":walk_forward,"older_expectancy_pct":older_expectancy,"recent_expectancy_pct":recent_expectancy,"recent_health":recent_health},
        "scores":{
            "edge_strength_0_to_10":round(max(0,min(10,(absolute_edge or 0)/10+(uplift or 0)/10)),2),
            "reliability_0_to_10":round(10*sum(checks[key] for key in ("minimum_evidence","cross_token_breadth","dependence_group_breadth","group_bootstrap_confidence","best_observation_removed","top_three_observations_removed","top_five_percent_removed"))/7,2),
            "persistence_0_to_10":round(10*sum(checks[key] for key in ("chronological_holdout_expectancy","chronological_holdout_uplift","walk_forward_persistence","recent_edge_health"))/4,2),
            "recent_health":recent_health,
            "luck_risk":"low" if checks["top_three_observations_removed"] and checks["top_five_percent_removed"] else "medium" if checks["best_observation_removed"] else "high",
            "note":"Evidence-quality diagnostics, not a probability or recommendation.",
        },
        "publication":{"is_validated_edge":status in {"validated_positive_edge","validated_risk_pattern"},"descriptive_behavior_is_edge":False,"predictive_probability_published":False},
    }


def _aggregate_result(
    key: str,
    domain: str,
    status: str,
    evidence: dict[str, Any],
    explanation: str,
) -> dict[str, Any]:
    """Create an honest trader-period finding without pretending it has a baseline."""
    return {
        "key": key,
        "name": CATALOG_NAMES[key],
        "domain": domain,
        "description": explanation,
        "source_dataset": "trader_period",
        "analysis_unit": "trader_90_day_period",
        "eligible_action_types": [],
        "recognition_event": "after_analysis_period",
        "required_features": [],
        "outcome_target": "completed_position_realized_economics",
        "outcome_horizon_minutes": None,
        "dependence_structure": "position_episode; descriptive trader-period profile",
        "economics_attribution_method": "completed-position cost basis and realized PnL",
        "pattern_model_version": MODEL_VERSION,
        "rule_version": RULE_VERSION,
        "finding_status": status,
        "direction": "risk_pattern" if status == "observed_risk" else "positive_edge",
        "primary_outcome": "completed_position_realized_pnl_and_return",
        "timing_diagnostic_role": "not_used_for_primary_classification",
        "populations": {
            "completed_match_count": evidence.get("completed_observation_count", 0),
            "completed_baseline_count": 0,
            "independent_token_count": evidence.get("independent_token_count", 0),
            "dependence_group_count": evidence.get("active_week_count", 0),
        },
        "historical_evidence": evidence,
        "trader_baseline_evidence": None,
        "comparison": None,
        "payoff_shape": {
            "capital_weighted": True,
            "win_rate_above_50_percent": (
                evidence.get("win_rate_percent") > 50
                if evidence.get("win_rate_percent") is not None else None
            ),
            "positive_median_return": (
                evidence.get("median_realized_return_pct") > 0
                if evidence.get("median_realized_return_pct") is not None else None
            ),
            "note": "Win rate and median return are diagnostics, not mandatory edge conditions.",
        },
        "checks": {},
        "failed_checks": ["independent_comparison_population", "chronological_out_of_sample_validation"],
        "validation": {
            "status": "descriptive_or_candidate_only",
            "limitation": "A single trader-period profile has no independent within-trader baseline. Validate it across earlier and later periods before calling it an edge.",
        },
        "publication": {
            "is_validated_edge": False,
            "descriptive_behavior_is_edge": False,
            "predictive_probability_published": False,
        },
    }


def _trader_period_patterns(
    episode_rows: list[dict[str, Any]], trader_economics: dict[str, Any] | None,
) -> list[dict[str, Any]]:
    """Restore V3's payoff, exit, reliability, and capital-efficiency profiles."""
    economics = trader_economics or {}
    completed = [
        row for row in episode_rows
        if number(row, "roi_pct") is not None
        and number(row, "realized_pnl_usd") is not None
        and number(row, "capital_deployed_usd") is not None
    ]
    returns = [number(row, "roi_pct") for row in completed]
    returns = [value for value in returns if value is not None]
    wins = [row for row in completed if (number(row, "realized_pnl_usd") or 0) > 0]
    losses = [row for row in completed if (number(row, "realized_pnl_usd") or 0) <= 0]
    win_holds = [number(row, "time_to_full_exit_minutes") for row in wins]
    loss_holds = [number(row, "time_to_full_exit_minutes") for row in losses]
    win_holds = [value for value in win_holds if value is not None]
    loss_holds = [value for value in loss_holds if value is not None]
    hold_ratio = (
        median(win_holds) / median(loss_holds)
        if win_holds and loss_holds and median(loss_holds) else None
    )
    pnls = [number(row, "realized_pnl_usd") or 0 for row in completed]
    costs = [number(row, "capital_deployed_usd") or 0 for row in completed]
    total_pnl = sum(pnls)
    total_cost = sum(costs)
    best_index = max(range(len(pnls)), key=pnls.__getitem__) if pnls else None
    pnl_without_best = total_pnl - pnls[best_index] if best_index is not None else None
    cost_without_best = total_cost - costs[best_index] if best_index is not None else None
    return_without_best = (
        100 * pnl_without_best / cost_without_best
        if cost_without_best and pnl_without_best is not None else None
    )
    evidence = {
        "completed_observation_count": len(completed),
        "profitable_count": len(wins),
        "loss_count": len(losses),
        "win_rate_percent": 100 * len(wins) / len(completed) if completed else None,
        "realized_expectancy_pct": mean(returns) if returns else None,
        "average_completed_position_return_pct": mean(returns) if returns else None,
        "median_realized_return_pct": median(returns) if returns else None,
        "average_win_pct": economics.get("average_win_pct"),
        "average_loss_pct": economics.get("average_loss_pct"),
        "payoff_ratio": economics.get("payoff_ratio"),
        "realized_pnl_usd": total_pnl if completed else None,
        "realized_cost_basis_usd": total_cost if completed else None,
        "return_on_realized_cost_pct": 100 * total_pnl / total_cost if total_cost else None,
        "profit_factor": economics.get("profit_factor"),
        "independent_token_count": len({(row.get("chain"), row.get("token_address")) for row in completed}),
        "active_week_count": len({_group(row) for row in completed}),
        "winner_vs_loser_hold_ratio": hold_ratio,
        "best_trade_profit_share": economics.get("best_trade_profit_share"),
        "top_3_profit_share": economics.get("top_3_profit_share"),
        "token_profit_hhi": economics.get("token_profit_hhi"),
        "capital_turnover": economics.get("capital_turnover"),
        "realized_return_on_minimum_funding_pct": economics.get(
            "realized_return_on_minimum_funding_pct"
        ),
        "realized_return_on_rolling_capital_pct": economics.get(
            "realized_return_on_rolling_capital_pct"
        ),
        "rolling_capital_deployed_usd": economics.get(
            "rolling_capital_deployed_usd"
        ),
        "minimum_trade_funding_required_usd": economics.get(
            "minimum_trade_funding_required_usd"
        ),
        "expectancy_after_best_position_removed_pct": return_without_best,
    }
    win_rate = evidence["win_rate_percent"]
    payoff = evidence["payoff_ratio"] or 0
    weighted_return = evidence["return_on_realized_cost_pct"] or 0
    profit_factor = evidence["profit_factor"] or 0
    best_share = evidence["best_trade_profit_share"] or 0
    top3_share = evidence["top_3_profit_share"] or 0
    asymmetry = bool(
        len(completed) >= 30 and win_rate is not None and win_rate < 50
        and payoff > 1 and weighted_return > 0 and profit_factor > 1
    )
    moonshot = bool(best_share > .35 or top3_share > .65)

    def finding(key: str, domain: str, matched: bool, text: str, *, risk: bool = False) -> dict[str, Any]:
        status = ("observed_risk" if risk else "candidate_under_review") if matched else "rejected_hypothesis"
        return _aggregate_result(key, domain, status, dict(evidence), text)

    hold_consistent = hold_ratio is not None and hold_ratio > 1.5 and len(win_holds) >= 10 and len(loss_holds) >= 10
    size_cv = number(economics, "entry_size_coefficient_of_variation")
    yoc = number(economics, "realized_return_on_rolling_capital_pct")
    capital_denominator_complete = economics.get("capital_denominator_status") == "complete"
    turnover = number(economics, "capital_turnover")
    median_hold = median(win_holds + loss_holds) if win_holds or loss_holds else None
    patterns = [
        finding("fast_loss_cutter", "exit_skill", hold_consistent, "Losing positions were closed materially faster than winning positions."),
        finding("lets_winners_run", "exit_skill", hold_consistent, "Winning positions were held materially longer than losing positions."),
        finding("time_based_exiter", "exit_skill", False, "Exit timing requires a stable hold-time rule and separate validation."),
        finding("disciplined_flat_sizer", "sizing", size_cv is not None and size_cv < .3, "Entry sizes stayed in a narrow range."),
        finding("session_specialist", "timing", False, "Session specialization requires a separately validated session comparison."),
        finding("hour_of_day_specialist", "timing", False, "Hour-of-day specialization requires a separately validated hour comparison."),
        finding("short_horizon_specialist", "timing", False, "Short-horizon specialization requires a non-overlapping hold-time comparison."),
        finding("long_horizon_runner", "timing", False, "Long-horizon specialization requires a non-overlapping hold-time comparison."),
        finding("moonshot_dependent_trader", "reliability", moonshot, "A large share of gross profits came from the best one or three positions.", risk=True),
        finding("broad_based_winner", "reliability", weighted_return > 0 and not moonshot and (evidence["token_profit_hhi"] or 1) < .15, "Profits were positive and broadly distributed across tokens."),
        finding("streak_dependent_trader", "reliability", False, "Streak dependence requires a chronological weekly-profit concentration test.", risk=True),
        finding("asymmetric_winner", "payoff_profile", asymmetry, "Frequent smaller losing positions were outweighed in capital-weighted dollars by less frequent larger winners."),
        finding("high_hit_rate_grinder", "payoff_profile", bool(win_rate is not None and win_rate >= 60 and weighted_return > 0), "A high hit rate and positive capital-weighted return characterized the period."),
        _aggregate_result(
            "capital_efficient_trader",
            "capital_efficiency",
            "candidate_under_review"
            if yoc is not None and yoc > 20 and total_pnl > 0
            else "rejected_hypothesis",
            dict(evidence),
            (
                "The verified trade sequence appears capital-efficient, but the "
                "denominator is only a lower bound; complete cutoff equity and "
                "custody cash are required before this can be validated."
                if not capital_denominator_complete
                else "Completed and open positions produced a high return on complete observed capital."
            ),
        ) if not capital_denominator_complete else finding(
            "capital_efficient_trader",
            "capital_efficiency",
            bool(yoc is not None and yoc > 20 and total_pnl > 0),
            "Completed and open positions produced a high return on complete observed capital.",
        ),
        finding("fast_capital_recycler", "capital_efficiency", bool(turnover is not None and turnover > 3 and median_hold is not None and median_hold < 1440 and total_pnl > 0), "Capital turned over repeatedly with sub-day median holding time and positive realized PnL."),
    ]
    return patterns


def run_v3_3_pattern_engine(
    action_rows: Iterable[dict[str, Any]],
    episode_rows: Iterable[dict[str, Any]],
    trader_economics: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Validate the original V3 catalog against completed economic outcomes."""
    actions=list(action_rows);episodes=list(episode_rows);results=[]
    for spec in PATTERN_SPECS:
        rows=actions if spec.source_dataset=="action" else episodes
        results.append(validate_pattern_v3_3(spec,rows))
    results.extend(_trader_period_patterns(episodes, trader_economics))
    statuses=sorted({row["finding_status"] for row in results})
    return {
        "pattern_model_version":MODEL_VERSION,
        "rule_version":RULE_VERSION,
        "primary_outcomes":{
            "purchase_actions":"completed FIFO purchase-to-disposal realized return",
            "position_patterns":"completed-position realized return",
            "fixed_horizon_price_returns":"supporting timing diagnostics only",
        },
        "validation_policy":{
            "positive_edge_requires_win_rate_above_50_percent":False,
            "positive_edge_requires_positive_median_return":False,
            "positive_realized_expectancy_required":True,
            "baseline_and_chronological_validation_required":True,
            "descriptive_behavior_is_a_validated_edge":False,
        },
        "patterns":results,
        "status_counts":{status:sum(row["finding_status"]==status for row in results) for status in statuses},
    }
