"""V3 entry-pattern candidates and a shared, conservative validation stack."""

from __future__ import annotations

import math
import random
from dataclasses import dataclass
from statistics import mean, median
from typing import Any, Callable, Iterable


MIN_OCCURRENCES = 30
MIN_BASELINE = 30
MIN_TOKENS = 10
MIN_ECONOMIC_UPLIFT_PCT = 2.0


def _number(row: dict[str, Any], key: str) -> float | None:
    value = row.get(key)
    try:
        return None if value is None else float(value)
    except (TypeError, ValueError):
        return None


@dataclass(frozen=True)
class EntryPattern:
    key: str
    name: str
    description: str
    matches: Callable[[dict[str, Any]], bool]


ENTRY_PATTERNS = (
    EntryPattern(
        "first_dip_buyer",
        "First Dip Buyer",
        "Buys an 8% to 35% pullback after a strong one-hour move.",
        lambda row: (_number(row, "pre_return_60m_pct") or -999) >= 20
        and -35 <= (_number(row, "drawdown_from_high_60m_pct") or 999) <= -8,
    ),
    EntryPattern(
        "recovery_confirmed_dip_buyer",
        "Recovery Confirmed Dip Buyer",
        "Buys a deep one-hour pullback after the five-minute return turns positive.",
        lambda row: (_number(row, "drawdown_from_high_60m_pct") or 999) <= -20
        and (_number(row, "pre_return_5m_pct") or -999) > 0,
    ),
    EntryPattern(
        "deep_panic_buyer",
        "Deep Panic Buyer",
        "Buys at least 40% below the recent four-hour high.",
        lambda row: (_number(row, "drawdown_from_high_240m_pct") or 999) <= -40,
    ),
    EntryPattern(
        "momentum_rider",
        "Momentum Rider",
        "Buys while both 15-minute and one-hour momentum are positive.",
        lambda row: (_number(row, "pre_return_15m_pct") or -999) > 0
        and (_number(row, "pre_return_60m_pct") or -999) > 0,
    ),
    EntryPattern(
        "early_momentum_buyer",
        "Early Momentum Buyer",
        "Buys after moderate, but not yet extreme, one-hour strength.",
        lambda row: 5 <= (_number(row, "pre_return_60m_pct") or -999) <= 40,
    ),
    EntryPattern(
        "breakout_buyer",
        "Breakout Buyer",
        "Buys within 3% of the recent one-hour high.",
        lambda row: (_number(row, "drawdown_from_high_60m_pct") or -999) >= -3,
    ),
    EntryPattern(
        "bottom_timing_specialist",
        "Bottom Timing Specialist",
        "Buys within 5% of the recent one-hour low.",
        lambda row: 0 <= (_number(row, "distance_from_low_60m_pct") or -999) <= 5,
    ),
)


def _summary(rows: list[dict[str, Any]]) -> dict[str, float | int | None]:
    outcomes = [_number(row, "forward_return_240m_pct") for row in rows]
    values = [value for value in outcomes if value is not None]
    if not values:
        return {"count": 0, "win_rate_percent": None, "mean_return_pct": None, "median_return_pct": None}
    return {
        "count": len(values),
        "win_rate_percent": round(100 * sum(value > 0 for value in values) / len(values), 2),
        "mean_return_pct": round(mean(values), 6),
        "median_return_pct": round(median(values), 6),
    }


def _uplift(pattern_rows: list[dict[str, Any]], baseline_rows: list[dict[str, Any]]) -> float | None:
    left = [_number(row, "forward_return_240m_pct") for row in pattern_rows]
    right = [_number(row, "forward_return_240m_pct") for row in baseline_rows]
    left = [value for value in left if value is not None]
    right = [value for value in right if value is not None]
    return mean(left) - mean(right) if left and right else None


def _bootstrap_uplift_interval(
    pattern_rows: list[dict[str, Any]],
    baseline_rows: list[dict[str, Any]],
    confidence: float,
    samples: int = 2_000,
) -> tuple[float | None, float | None]:
    left = [_number(row, "forward_return_240m_pct") for row in pattern_rows]
    right = [_number(row, "forward_return_240m_pct") for row in baseline_rows]
    left = [value for value in left if value is not None]
    right = [value for value in right if value is not None]
    if not left or not right:
        return None, None
    rng = random.Random(7)
    estimates = sorted(
        mean(rng.choices(left, k=len(left))) - mean(rng.choices(right, k=len(right)))
        for _ in range(samples)
    )
    tail = (1 - confidence) / 2
    low = estimates[max(0, math.floor(tail * samples))]
    high = estimates[min(samples - 1, math.ceil((1 - tail) * samples) - 1)]
    return round(low, 6), round(high, 6)


def _remove_top(rows: list[dict[str, Any]], count: int) -> list[dict[str, Any]]:
    return sorted(
        rows,
        key=lambda row: _number(row, "forward_return_240m_pct") or -math.inf,
    )[:-count] if count and len(rows) > count else []


def validate_entry_patterns(
    rows: Iterable[dict[str, Any]],
    patterns: Iterable[EntryPattern] = ENTRY_PATTERNS,
) -> list[dict[str, Any]]:
    usable = [
        row for row in rows if _number(row, "forward_return_240m_pct") is not None
    ]
    definitions = list(patterns)
    corrected_confidence = 1 - 0.05 / max(1, len(definitions))
    ordered = sorted(usable, key=lambda row: str(row.get("timestamp", "")))
    split = max(1, int(len(ordered) * 0.7))
    train_ids = {row["trade_id"] for row in ordered[:split]}
    output = []
    for definition in definitions:
        matching = [row for row in usable if definition.matches(row)]
        baseline = [row for row in usable if not definition.matches(row)]
        pattern_summary = _summary(matching)
        baseline_summary = _summary(baseline)
        tokens = {(row.get("chain"), row.get("token_address")) for row in matching}
        uplift = _uplift(matching, baseline)
        median_uplift = (
            float(pattern_summary["median_return_pct"])
            - float(baseline_summary["median_return_pct"])
            if pattern_summary["median_return_pct"] is not None
            and baseline_summary["median_return_pct"] is not None
            else None
        )
        ci_low, ci_high = _bootstrap_uplift_interval(
            matching, baseline, corrected_confidence
        )
        train_pattern = [row for row in matching if row["trade_id"] in train_ids]
        train_baseline = [row for row in baseline if row["trade_id"] in train_ids]
        holdout_pattern = [row for row in matching if row["trade_id"] not in train_ids]
        holdout_baseline = [row for row in baseline if row["trade_id"] not in train_ids]
        train_uplift = _uplift(train_pattern, train_baseline)
        holdout_uplift = _uplift(holdout_pattern, holdout_baseline)
        remove_top_three = _uplift(_remove_top(matching, 3), _remove_top(baseline, 3))
        top_five_count_pattern = max(1, math.ceil(len(matching) * 0.05))
        top_five_count_baseline = max(1, math.ceil(len(baseline) * 0.05))
        remove_top_five = _uplift(
            _remove_top(matching, top_five_count_pattern),
            _remove_top(baseline, top_five_count_baseline),
        )
        checks = {
            "minimum_occurrences": len(matching) >= MIN_OCCURRENCES,
            "minimum_baseline": len(baseline) >= MIN_BASELINE,
            "cross_token_breadth": len(tokens) >= MIN_TOKENS,
            "economic_mean_uplift": uplift is not None and uplift >= MIN_ECONOMIC_UPLIFT_PCT,
            "positive_median_uplift": median_uplift is not None and median_uplift > 0,
            "multiple_test_corrected_bootstrap": ci_low is not None and ci_low > 0,
            "chronological_train": train_uplift is not None and train_uplift > 0,
            "chronological_holdout": holdout_uplift is not None and holdout_uplift > 0,
            "remove_top_three": remove_top_three is not None and remove_top_three > 0,
            "remove_top_five_percent": remove_top_five is not None and remove_top_five > 0,
        }
        output.append({
            "pattern_key": definition.key,
            "pattern_name": definition.name,
            "domain": "entry_skill",
            "description": definition.description,
            "status": "validated" if all(checks.values()) else "candidate_rejected",
            "pattern": pattern_summary,
            "baseline": baseline_summary,
            "independent_token_count": len(tokens),
            "mean_return_uplift_pct": None if uplift is None else round(uplift, 6),
            "median_return_uplift_pct": None if median_uplift is None else round(median_uplift, 6),
            "bootstrap_confidence": round(corrected_confidence, 6),
            "bootstrap_uplift_ci_pct": [ci_low, ci_high],
            "train_uplift_pct": None if train_uplift is None else round(train_uplift, 6),
            "holdout_uplift_pct": None if holdout_uplift is None else round(holdout_uplift, 6),
            "remove_top_three_uplift_pct": None if remove_top_three is None else round(remove_top_three, 6),
            "remove_top_five_percent_uplift_pct": None if remove_top_five is None else round(remove_top_five, 6),
            "checks": checks,
            "failed_checks": [key for key, passed in checks.items() if not passed],
        })
    return output
