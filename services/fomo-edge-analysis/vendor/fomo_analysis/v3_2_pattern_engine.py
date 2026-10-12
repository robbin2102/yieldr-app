"""Yieldr V3.2 action-aware pattern validation and evidence contracts."""

from __future__ import annotations

import math
import random
from collections import defaultdict
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta
from statistics import mean, median
from typing import Any, Callable, Iterable

from fomo_analysis.v3_pattern_engine import PATTERNS, PatternDefinition, number, timestamp


MODEL_VERSION = "3.2.0"
RULE_VERSION = "2026-09-08.6"
PRIMARY_HORIZON_MINUTES = 60
MIN_MATCHING_ACTIONS = 30
MIN_BASELINE_ACTIONS = 30
MIN_DISTINCT_TOKENS = 10
MIN_DEPENDENCE_GROUPS = 8
MIN_SUBGROUP_ACTIONS = 30
RETROSPECTIVE_ONLY_KEYS = {"peak_capturer", "round_tripper"}

POSITIVE = "positive_edge"
RISK = "risk_pattern"


@dataclass(frozen=True)
class PatternSpec:
    key: str
    name: str
    domain: str
    description: str
    matches: Callable[[dict[str, Any]], bool]
    eligible_action_types: tuple[str, ...]
    analysis_unit: str
    recognition_event: str
    required_features: tuple[str, ...]
    outcome_target: str
    outcome_horizon_minutes: int | None
    dependence_structure: str
    economics_attribution_method: str
    direction: str = POSITIVE
    source_dataset: str = "action"

    def contract(self) -> dict[str, Any]:
        value = asdict(self)
        value.pop("matches")
        return value


OPENING_KEYS = {
    "first_entry_specialist",
}
REENTRY_KEYS = {
    "repeat_token_specialist", "successful_reentry_trader", "chasing_reentry",
    "patient_reentry_trader", "capital_rotation_specialist",
}
BUY_ACTION_KEYS = {
    definition.key for definition in PATTERNS if definition.dataset == "entry"
} - OPENING_KEYS - REENTRY_KEYS


REQUIRED_FEATURES: dict[str, tuple[str, ...]] = {
    "first_dip_buyer": ("pre_return_60m_pct", "drawdown_from_high_60m_pct"),
    "recovery_confirmed_dip_buyer": ("drawdown_from_high_60m_pct", "pre_return_5m_pct"),
    "deep_panic_buyer": ("drawdown_from_high_240m_pct",),
    "momentum_rider": ("pre_return_15m_pct", "momentum_acceleration_pct"),
    "early_momentum_buyer": ("pre_return_60m_pct",),
    "anti_chaser": ("pre_return_60m_pct",),
    "breakout_buyer": ("near_rolling_high_60m",),
    "breakout_retest_buyer": ("breakout_retest_60m",),
    "bottom_timing_specialist": ("distance_from_low_60m_pct",),
    "conviction_sizer": ("relative_size_vs_trader_median",),
    "revenge_sizer": ("previous_trade_return_pct", "relative_size_vs_recent_median"),
    "erratic_sizer": ("relative_size_vs_recent_median",),
    "weekend_specialist": ("is_weekend",),
    "weekday_specialist": ("is_weekend",),
    "early_session_specialist": ("trade_number_in_session",),
    "selective_trader": ("time_since_previous_trade_minutes", "trader_median_trade_gap_minutes"),
    "overtrader": ("trades_last_1h",),
    "post_loss_tilter": ("consecutive_losses",),
    "drawdown_recovery_discipline": ("consecutive_losses", "relative_size_vs_recent_median"),
    "post_win_overconfidence": ("consecutive_wins",),
    "hot_hand_trader": ("consecutive_wins",),
    "fatigue_attention_decay": ("trade_number_in_session",),
    "calibrated_conviction": ("relative_size_vs_trader_median",),
    "repeat_token_specialist": ("repeat_token",),
    "first_entry_specialist": ("entry_number_for_token",),
    "successful_reentry_trader": ("entry_number_for_token",),
    "chasing_reentry": ("price_move_since_prior_exit_pct",),
    "patient_reentry_trader": ("time_since_prior_exit_minutes",),
    "focused_capital_allocator": ("capital_concentration_top_1", "relative_size_vs_trader_median"),
    "overextended_trader": ("concurrent_position_count",),
    "capital_rotation_specialist": ("time_since_prior_exit_minutes",),
}


def _action_spec(definition: PatternDefinition) -> PatternSpec:
    if definition.key in OPENING_KEYS:
        eligible = ("opening_buy",)
        unit = "opening_action"
    elif definition.key in REENTRY_KEYS:
        eligible = ("reentry",)
        unit = "reentry_action"
    else:
        eligible = ("opening_buy", "addition", "reentry")
        unit = "buy_action"
    return PatternSpec(
        key=definition.key,
        name=definition.name,
        domain=definition.domain,
        description=definition.description,
        matches=definition.matches,
        eligible_action_types=eligible,
        analysis_unit=unit,
        recognition_event="when_action_is_verified",
        required_features=REQUIRED_FEATURES.get(definition.key, ()),
        outcome_target="price_higher_after_1h",
        outcome_horizon_minutes=PRIMARY_HORIZON_MINUTES,
        dependence_structure="chain_token_iso_week_block; actions remain visible but inference resamples grouped blocks",
        economics_attribution_method="matched_action_cost_and_own_forward_price_outcome; no episode PnL duplicated",
        direction=RISK if definition.direction < 0 else POSITIVE,
    )


def _episode_spec(definition: PatternDefinition) -> PatternSpec:
    recognition = {
        "scaled_exiter": "second_verified_sell",
        "selective_scale_in_trader": "second_verified_buy",
        "averaging_down_specialist": "first_addition_below_opening_price",
    }.get(definition.key, "episode_close")
    return PatternSpec(
        key=definition.key,
        name=definition.name,
        domain=definition.domain,
        description=definition.description,
        matches=definition.matches,
        eligible_action_types=("position_episode",),
        analysis_unit="position_episode",
        recognition_event=recognition,
        required_features=(),
        outcome_target="realized_position_return",
        outcome_horizon_minutes=None,
        dependence_structure="chain_token_iso_week_block",
        economics_attribution_method="whole_episode_known_cost_basis_and_realized_pnl",
        direction=RISK if definition.direction < 0 else POSITIVE,
        source_dataset="episode",
    )


PATTERN_SPECS = tuple(
    _action_spec(definition) if definition.dataset == "entry" else _episode_spec(definition)
    for definition in PATTERNS
)


def _time(row: dict[str, Any]) -> datetime:
    return timestamp(row)


def _outcome(row: dict[str, Any], spec: PatternSpec) -> float | None:
    if spec.source_dataset == "episode":
        return number(row, "realized_return_pct")
    raw = number(row, "forward_price_return_60m_pct")
    if raw is None:
        return None
    return -raw if row.get("side") == "SELL" else raw


def _success(row: dict[str, Any], spec: PatternSpec) -> bool | None:
    value = _outcome(row, spec)
    if value is None:
        return None
    return value > 0


def _eligible(row: dict[str, Any], spec: PatternSpec) -> bool:
    if spec.source_dataset == "episode":
        return True
    return row.get("action_type") in spec.eligible_action_types


def _group_key(row: dict[str, Any]) -> str:
    at = _time(row)
    iso = at.isocalendar()
    return f"{row.get('chain')}|{row.get('token_address')}|{iso.year}-W{iso.week:02d}"


def _bounded(value: float, bounds: tuple[float, float] | None) -> float:
    return max(bounds[0], min(bounds[1], value)) if bounds else value


def _quantile(values: list[float], fraction: float) -> float:
    ordered = sorted(values)
    position = (len(ordered) - 1) * fraction
    lower = int(position)
    upper = min(len(ordered) - 1, lower + 1)
    weight = position - lower
    return ordered[lower] * (1 - weight) + ordered[upper] * weight


def _group_means(
    rows: list[dict[str, Any]], spec: PatternSpec,
    bounds: tuple[float, float] | None = None,
) -> dict[str, float]:
    grouped: dict[str, list[float]] = defaultdict(list)
    for row in rows:
        value = _outcome(row, spec)
        if value is not None:
            grouped[_group_key(row)].append(_bounded(value, bounds))
    return {key: mean(values) for key, values in grouped.items() if values}


def _block_bootstrap(
    matching: list[dict[str, Any]], baseline: list[dict[str, Any]], spec: PatternSpec,
    confidence: float, bounds: tuple[float, float] | None = None, samples: int = 1500,
) -> list[float | None]:
    left = list(_group_means(matching, spec, bounds).values())
    right = list(_group_means(baseline, spec, bounds).values())
    if not left or not right:
        return [None, None]
    factor = 1 if spec.direction == POSITIVE else -1
    rng = random.Random(32)
    estimates = sorted(
        factor * (mean(rng.choices(left, k=len(left))) - mean(rng.choices(right, k=len(right))))
        for _ in range(samples)
    )
    tail = (1 - confidence) / 2
    return [
        round(estimates[max(0, int(tail * samples))], 6),
        round(estimates[min(samples - 1, int((1 - tail) * samples))], 6),
    ]


def _frequency(rows: list[dict[str, Any]], spec: PatternSpec) -> float | None:
    values = [_success(row, spec) for row in rows]
    values = [value for value in values if value is not None]
    return 100 * sum(values) / len(values) if values else None


def _median_outcome(rows: list[dict[str, Any]], spec: PatternSpec) -> float | None:
    values = [_outcome(row, spec) for row in rows]
    values = [value for value in values if value is not None]
    return median(values) if values else None


def _subgroups(rows: list[dict[str, Any]], spec: PatternSpec) -> dict[str, Any]:
    if spec.source_dataset != "action":
        return {}
    output = {}
    for action_type in ("opening_buy", "addition", "reentry"):
        group = [row for row in rows if row.get("action_type") == action_type]
        tokens = {(row.get("chain"), row.get("token_address")) for row in group}
        positions = {row.get("episode_id") for row in group if row.get("episode_id")}
        output[action_type] = {
            "matching_action_count": len(group),
            "matching_position_count": len(positions),
            "distinct_token_count": len(tokens),
            "outcome_eligible_count": sum(_outcome(row, spec) is not None for row in group),
            "historical_success_frequency_pct": _frequency(group, spec),
            "median_directional_price_change_pct": _median_outcome(group, spec),
            "publish_separately": (
                len(group) >= MIN_SUBGROUP_ACTIONS and len(positions) >= 10 and len(tokens) >= 5
            ),
        }
    return output


def _economics(rows: list[dict[str, Any]], spec: PatternSpec) -> dict[str, Any]:
    if spec.source_dataset == "action":
        known = [row for row in rows if number(row, "usd_notional") is not None]
        return {
            "gross_matched_action_notional_usd": sum(number(row, "usd_notional") or 0 for row in known) if known else None,
            "known_notional_action_count": len(known),
            "unknown_notional_action_count": len(rows) - len(known),
            "realized_attributable_pnl_usd": None,
            "return_on_deployed_capital_pct": None,
            "accounting_status": "not_attributed_without_lot_level_realization",
            "explanation": "Entry quality uses each action's own forward price outcome. Episode PnL is not duplicated or pro-rated across matched buys.",
        }
    closed = [row for row in rows if row.get("closed_at") or row.get("episode_closed_at")]
    priced = [
        row for row in closed
        if number(row, "capital_deployed_usd") is not None
        and number(row, "realized_pnl_usd") is not None
    ]
    capital = sum(number(row, "capital_deployed_usd") or 0 for row in priced)
    pnl = sum(number(row, "realized_pnl_usd") or 0 for row in priced)
    return {
        "observed_episode_count": len(rows),
        "closed_episode_count": len(closed),
        "priced_economics_count": len(priced),
        "gross_capital_deployed_usd": capital if priced else None,
        "realized_attributable_pnl_usd": pnl if priced else None,
        "return_on_deployed_capital_pct": pnl / capital * 100 if priced and capital else None,
        "accounting_status": "whole_episode_known_cost_basis",
        "overlap_warning": "An episode may match other patterns; do not sum pattern economics.",
    }


def validate_pattern_v3_2(
    spec: PatternSpec, rows: Iterable[dict[str, Any]], correction_count: int,
) -> dict[str, Any]:
    eligible = [row for row in rows if _eligible(row, spec)]
    matched_observed = [row for row in eligible if spec.matches(row)]
    usable = [row for row in eligible if _outcome(row, spec) is not None]
    matching = [row for row in usable if spec.matches(row)]
    baseline = [row for row in usable if not spec.matches(row)]
    factor = 1 if spec.direction == POSITIVE else -1
    matching_values = [_outcome(row, spec) for row in matching]
    baseline_values = [_outcome(row, spec) for row in baseline]
    matching_values = [value for value in matching_values if value is not None]
    baseline_values = [value for value in baseline_values if value is not None]
    pooled_values = matching_values + baseline_values
    bounds = (
        (_quantile(pooled_values, 0.01), _quantile(pooled_values, 0.99))
        if len(pooled_values) >= 100 else None
    )
    adjusted_matching = [_bounded(value, bounds) for value in matching_values]
    adjusted_baseline = [_bounded(value, bounds) for value in baseline_values]
    raw_mean_uplift = (
        factor * (mean(matching_values) - mean(baseline_values))
        if matching_values and baseline_values else None
    )
    mean_uplift = (
        factor * (mean(adjusted_matching) - mean(adjusted_baseline))
        if adjusted_matching and adjusted_baseline else None
    )
    median_uplift = (
        factor * (median(matching_values) - median(baseline_values))
        if matching_values and baseline_values else None
    )
    success_frequency = _frequency(matching, spec)
    baseline_frequency = _frequency(baseline, spec)
    frequency_uplift = (
        factor * (success_frequency - baseline_frequency)
        if success_frequency is not None and baseline_frequency is not None else None
    )
    confidence = 1 - 0.05 / max(1, correction_count)
    ci = _block_bootstrap(matching, baseline, spec, confidence, bounds)

    ordered = sorted(usable, key=_time)
    cutoff_index = int(len(ordered) * 0.7)
    cutoff = _time(ordered[cutoff_index]) if ordered and cutoff_index < len(ordered) else None
    purge = timedelta(minutes=spec.outcome_horizon_minutes or 0)
    train = [row for row in ordered if cutoff and _time(row) + purge < cutoff]
    holdout = [row for row in ordered if cutoff and _time(row) >= cutoff]

    def split_uplift(part: list[dict[str, Any]]) -> float | None:
        left = [_outcome(row, spec) for row in part if spec.matches(row)]
        right = [_outcome(row, spec) for row in part if not spec.matches(row)]
        left = [value for value in left if value is not None]
        right = [value for value in right if value is not None]
        left = [_bounded(value, bounds) for value in left]
        right = [_bounded(value, bounds) for value in right]
        return factor * (mean(left) - mean(right)) if left and right else None

    train_uplift = split_uplift(train)
    holdout_uplift = split_uplift(holdout)
    block_uplifts = []
    for block in range(3):
        part = ordered[block * len(ordered) // 3 : (block + 1) * len(ordered) // 3]
        value = split_uplift(part)
        if value is not None:
            block_uplifts.append(value)

    tokens = {(row.get("chain"), row.get("token_address")) for row in matching}
    positions = {row.get("episode_id") for row in matching if row.get("episode_id")}
    observed_positions = {
        row.get("episode_id") for row in matched_observed if row.get("episode_id")
    }
    observed_tokens = {
        (row.get("chain"), row.get("token_address")) for row in matched_observed
    }
    groups = {_group_key(row) for row in matching}
    left_groups = list(_group_means(matching, spec, bounds).values())
    right_groups = list(_group_means(baseline, spec, bounds).values())
    if len(left_groups) > 1 and len(right_groups) > 1:
        left_trimmed = sorted(left_groups, key=abs)[:-1]
        right_trimmed = sorted(right_groups, key=abs)[:-1]
        leave_extreme_group_uplift = factor * (mean(left_trimmed) - mean(right_trimmed))
    else:
        leave_extreme_group_uplift = None
    checks = {
        "minimum_evidence": len(matching) >= MIN_MATCHING_ACTIONS and len(baseline) >= MIN_BASELINE_ACTIONS,
        "cross_token_breadth": len(tokens) >= MIN_DISTINCT_TOKENS,
        "dependence_group_breadth": len(groups) >= MIN_DEPENDENCE_GROUPS,
        "positive_adjusted_mean_uplift": mean_uplift is not None and mean_uplift > 0,
        "positive_adjusted_median_uplift": median_uplift is not None and median_uplift > 0,
        "absolute_directional_outcome": (
            _median_outcome(matching, spec) is not None
            and factor * (_median_outcome(matching, spec) or 0) > 0
        ),
        "absolute_target_frequency": (
            success_frequency is not None
            and (success_frequency > 50 if spec.direction == POSITIVE else success_frequency < 50)
        ),
        "bonferroni_block_bootstrap": ci[0] is not None and ci[0] > 0,
        "winsorized_outlier_robustness": mean_uplift is not None and mean_uplift > 0,
        "leave_extreme_group_out": leave_extreme_group_uplift is not None and leave_extreme_group_uplift > 0,
        "chronological_train": train_uplift is not None and train_uplift > 0,
        "purged_chronological_holdout": holdout_uplift is not None and holdout_uplift > 0,
        "walk_forward": len(block_uplifts) == 3 and sum(value > 0 for value in block_uplifts) >= 2,
    }
    primary = (
        checks["minimum_evidence"]
        and checks["cross_token_breadth"]
        and checks["dependence_group_breadth"]
        and checks["bonferroni_block_bootstrap"]
        and checks["positive_adjusted_median_uplift"]
        and checks["absolute_directional_outcome"]
        and checks["absolute_target_frequency"]
        and checks["leave_extreme_group_out"]
        and checks["purged_chronological_holdout"]
    )
    if spec.key in RETROSPECTIVE_ONLY_KEYS and matched_observed:
        status = "observed_risk" if spec.direction == RISK else "observed_behavior"
    elif not matched_observed:
        status = "rejected_hypothesis"
    elif len(matching) < MIN_MATCHING_ACTIONS or len(baseline) < MIN_BASELINE_ACTIONS:
        status = "insufficient_evidence"
    elif primary:
        status = "validated_positive_edge" if spec.direction == POSITIVE else "validated_risk_pattern"
    elif mean_uplift is not None and mean_uplift > 0:
        status = "candidate_under_review"
    else:
        status = "rejected_hypothesis"

    recent = ordered[-max(30, math.ceil(len(ordered) * 0.2)):] if ordered else []
    prior = ordered[: len(ordered) - len(recent)] if recent else []
    recent_uplift = split_uplift(recent)
    prior_uplift = split_uplift(prior)
    if recent_uplift is None or prior_uplift is None:
        health = "insufficient_evidence"
    elif recent_uplift > prior_uplift * 1.25:
        health = "stronger"
    elif recent_uplift < prior_uplift * 0.75:
        health = "weaker"
    else:
        health = "stable"

    return {
        "pattern_model_version": MODEL_VERSION,
        "rule_version": RULE_VERSION,
        **spec.contract(),
        "finding_status": status,
        "direction": spec.direction,
        "populations": {
            "observed_match_count": len(matched_observed),
            "observed_matching_position_count": len(observed_positions),
            "observed_distinct_token_count": len(observed_tokens),
            "outcome_eligible_count": len(matching),
            "validation_sample_count": len(matching),
            "baseline_outcome_eligible_count": len(baseline),
            "validation_eligible_position_count": len(positions),
            "validation_distinct_token_count": len(tokens),
            "dependence_group_count": len(groups),
        },
        "historical_frequency": {
            "target": spec.outcome_target,
            "horizon_minutes": spec.outcome_horizon_minutes,
            "matching_success_pct": success_frequency,
            "baseline_success_pct": baseline_frequency,
            "direction_adjusted_uplift_percentage_points": frequency_uplift,
            "is_predictive_probability": False,
        },
        "outcomes": {
            "matching_mean_directional_return_pct": mean(matching_values) if matching_values else None,
            "matching_median_directional_return_pct": median(matching_values) if matching_values else None,
            "raw_mean_uplift_pct": raw_mean_uplift,
            "adjusted_mean_uplift_pct": mean_uplift,
            "adjusted_median_uplift_pct": median_uplift,
            "block_bootstrap_confidence": confidence,
            "block_bootstrap_uplift_ci_pct": ci,
            "winsorization_bounds_pct": list(bounds) if bounds else None,
            "leave_extreme_group_out_uplift_pct": leave_extreme_group_uplift,
            "train_uplift_pct": train_uplift,
            "holdout_uplift_pct": holdout_uplift,
            "walk_forward_uplifts_pct": block_uplifts,
        },
        "subgroups": _subgroups(matching, spec),
        "economics": _economics(matched_observed, spec),
        "checks": checks,
        "failed_checks": [key for key, passed in checks.items() if not passed],
        "recent_health": health,
        "recent_uplift_pct": recent_uplift,
        "prior_uplift_pct": prior_uplift,
        "publication": {
            "default_number": (
                "historical_frequency"
                if success_frequency is not None and spec.key not in RETROSPECTIVE_ONLY_KEYS
                else None
            ),
            "predictive_probability_published": False,
            "reason": (
                "Outcome-defined signature is retrospective and cannot publish an outcome frequency as an edge."
                if spec.key in RETROSPECTIVE_ONLY_KEYS
                else "No calibrated chronologically evaluated predictive model has passed publication gates."
            ),
        },
    }


def run_v3_2_pattern_engine(
    action_rows: Iterable[dict[str, Any]], episode_rows: Iterable[dict[str, Any]],
    readiness: dict[str, Any],
) -> dict[str, Any]:
    actions = list(action_rows)
    episodes = list(episode_rows)
    results = []
    for spec in PATTERN_SPECS:
        rows = episodes if spec.source_dataset == "episode" else actions
        result = validate_pattern_v3_2(spec, rows, len(PATTERN_SPECS))
        if readiness.get("status") != "ready" and result["finding_status"].startswith("validated_"):
            result["finding_status"] = "insufficient_evidence"
            result["coverage_blocked"] = True
        results.append(result)
    return {
        "pattern_model_version": MODEL_VERSION,
        "rule_version": RULE_VERSION,
        "primary_action_outcome": {
            "buy": "price_higher_after_1h",
            "sell": "price_lower_after_1h",
            "horizon_minutes": PRIMARY_HORIZON_MINUTES,
        },
        "patterns": results,
        "status_counts": {
            status: sum(row["finding_status"] == status for row in results)
            for status in sorted({row["finding_status"] for row in results})
        },
    }
