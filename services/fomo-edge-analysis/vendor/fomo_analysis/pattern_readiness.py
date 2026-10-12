"""Coverage gates that prevent weak price samples becoming trader patterns."""

from __future__ import annotations

from typing import Any, Iterable


DEFAULT_THRESHOLDS = {
    "minimum_entry_forward_4h_coverage_percent": 60.0,
    "minimum_complete_episode_count": 50,
    "minimum_complete_episode_token_count": 20,
    "minimum_episode_path_coverage_percent": 60.0,
}


def assess_pattern_readiness(
    entry_features: Iterable[dict[str, Any]],
    episode_features: Iterable[dict[str, Any]],
    thresholds: dict[str, float | int] | None = None,
) -> dict[str, Any]:
    """Return deterministic readiness evidence; never infer through missing data."""
    limits = {**DEFAULT_THRESHOLDS, **(thresholds or {})}
    entries = list(entry_features)
    episodes = list(episode_features)
    forward_ready = sum(
        row.get("forward_return_240m_pct") is not None for row in entries
    )
    minimum_path_coverage = float(limits["minimum_episode_path_coverage_percent"])
    usable = [
        row
        for row in episodes
        if float(row.get("path_coverage_percent", 0)) >= minimum_path_coverage
    ]
    all_tokens = {(row.get("chain"), row.get("token_address")) for row in episodes}
    usable_tokens = {
        (row.get("chain"), row.get("token_address")) for row in usable
    }
    entry_coverage = round(100 * forward_ready / len(entries), 2) if entries else 0.0
    episode_coverage = round(100 * len(usable) / len(episodes), 2) if episodes else 0.0

    checks = {
        "entry_forward_4h_coverage": entry_coverage
        >= float(limits["minimum_entry_forward_4h_coverage_percent"]),
        "behavior_episode_count": len(episodes)
        >= int(limits["minimum_complete_episode_count"]),
        "behavior_episode_token_count": len(all_tokens)
        >= int(limits["minimum_complete_episode_token_count"]),
        "usable_episode_count": len(usable)
        >= int(limits["minimum_complete_episode_count"]),
        "usable_episode_token_count": len(usable_tokens)
        >= int(limits["minimum_complete_episode_token_count"]),
        "episode_path_coverage": episode_coverage
        >= float(limits["minimum_episode_path_coverage_percent"]),
    }
    sample_checks = (
        "behavior_episode_count",
        "behavior_episode_token_count",
    )
    price_checks = (
        "entry_forward_4h_coverage",
        "usable_episode_count",
        "usable_episode_token_count",
        "episode_path_coverage",
    )
    sample_blocked = not all(checks[key] for key in sample_checks)
    price_blocked = not all(checks[key] for key in price_checks)
    if not sample_blocked and not price_blocked:
        status = "ready"
    elif sample_blocked and price_blocked:
        # Do not call a naturally small 90-day sample merely a candle failure.
        price_failure_beyond_sample = (
            not checks["entry_forward_4h_coverage"]
            or not checks["episode_path_coverage"]
            or (
                checks["behavior_episode_count"]
                and not checks["usable_episode_count"]
            )
            or (
                checks["behavior_episode_token_count"]
                and not checks["usable_episode_token_count"]
            )
        )
        status = (
            "blocked_price_and_sample_size"
            if price_failure_beyond_sample
            else "insufficient_behavior_sample"
        )
    elif sample_blocked:
        status = "insufficient_behavior_sample"
    else:
        status = "blocked_price_coverage"
    return {
        "status": status,
        "checks": checks,
        "thresholds": limits,
        "observed": {
            "buy_entry_count": len(entries),
            "entry_forward_4h_ready": forward_ready,
            "entry_forward_4h_coverage_percent": entry_coverage,
            "closed_episode_count": len(episodes),
            "closed_episode_token_count": len(all_tokens),
            "usable_episode_count": len(usable),
            "usable_episode_token_count": len(usable_tokens),
            "excluded_episode_count": len(episodes) - len(usable),
            # Compatibility aliases for existing consumers. These now mean
            # threshold-usable, not a perfectly uninterrupted candle series.
            "complete_episode_count": len(usable),
            "complete_episode_token_count": len(usable_tokens),
            "episode_path_ready": len(usable),
            "episode_path_coverage_percent": episode_coverage,
        },
        "failed_checks": [name for name, passed in checks.items() if not passed],
        "evidence_population": {
            "included_closed_episodes": len(usable),
            "excluded_closed_episodes": len(episodes) - len(usable),
            "included_token_count": len(usable_tokens),
            "total_closed_episode_count": len(episodes),
            "total_closed_episode_token_count": len(all_tokens),
            "episode_inclusion_rule": (
                f"path_coverage_percent >= {minimum_path_coverage}"
            ),
        },
    }
