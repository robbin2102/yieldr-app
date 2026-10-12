"""Namespaced collection and index contracts for the existing yieldr database."""

from __future__ import annotations

from typing import Any


COLLECTIONS = {
    "traders": "fomo_analysis_traders",
    "tokens": "fomo_analysis_tokens",
    "trades": "fomo_analysis_trade_legs",
    "positions": "fomo_analysis_position_episodes",
    "price_points": "fomo_analysis_price_points_5m",
    "price_coverage": "fomo_analysis_price_coverage",
    "jobs": "fomo_analysis_jobs",
    "features": "fomo_analysis_features",
    "trade_features": "fomo_analysis_trade_features",
    "episode_features": "fomo_analysis_episode_features",
    "patterns": "fomo_analysis_patterns",
    "pattern_snapshots": "fomo_analysis_pattern_snapshots",
    "episode_pattern_links": "fomo_analysis_episode_pattern_links",
    "story_events": "fomo_analysis_pattern_story_events",
    "economic_actions": "fomo_analysis_economic_actions",
    "action_assessments": "fomo_analysis_action_assessments",
    "position_action_stories": "fomo_analysis_position_action_stories",
    "trader_pattern_summaries": "fomo_analysis_trader_pattern_summaries",
    "portfolio_snapshots": "fomo_analysis_portfolio_snapshots",
    "external_flows": "fomo_analysis_external_flows",
    "holder_snapshots": "fomo_analysis_holder_snapshots",
    "trader_portfolio_snapshots": "fomo_analysis_trader_portfolio_snapshots",
    "raw_api_payloads": "fomo_analysis_raw_api_payloads",
    "trader_rankings": "fomo_analysis_trader_rankings",
    "ingestion_runs": "fomo_analysis_ingestion_runs",
    "wallet_identities": "fomo_analysis_wallet_identities",
    "cohorts": "fomo_analysis_cohorts",
    "cohort_memberships": "fomo_analysis_cohort_memberships",
    "venue_attributions": "fomo_analysis_venue_attributions",
    "realtime_actions": "fomo_analysis_realtime_actions",
    "coin_flow_buckets": "fomo_analysis_coin_flow_buckets_1h",
    "wallet_holdings": "fomo_analysis_wallet_holdings",
    "narrative_posts": "fomo_analysis_narrative_posts",
    "narrative_clusters": "fomo_analysis_narrative_clusters",
    "runs": "fomo_analysis_runs",
}


# Direction values match pymongo.ASCENDING (1) and DESCENDING (-1), while keeping
# schema inspection usable before pymongo is installed.
INDEXES: dict[str, list[dict[str, Any]]] = {
    COLLECTIONS["traders"]: [
        {"keys": [("trader_id", 1)], "unique": True},
        {"keys": [("status", 1), ("priority_rank", 1)]},
    ],
    COLLECTIONS["tokens"]: [
        {"keys": [("chain", 1), ("token_address", 1)], "unique": True},
    ],
    COLLECTIONS["trades"]: [
        {"keys": [("trade_id", 1)], "unique": True},
        {"keys": [("trader_id", 1), ("timestamp", -1)]},
        {"keys": [("chain", 1), ("token_address", 1), ("timestamp", 1)]},
    ],
    COLLECTIONS["positions"]: [
        {"keys": [("episode_id", 1)], "unique": True},
        {"keys": [("trader_id", 1), ("opened_at", -1)]},
    ],
    COLLECTIONS["price_points"]: [
        {"keys": [("chain", 1), ("token_address", 1), ("timestamp", 1)], "unique": True},
    ],
    COLLECTIONS["price_coverage"]: [
        {"keys": [("chain", 1), ("token_address", 1), ("interval", 1)], "unique": True},
    ],
    COLLECTIONS["jobs"]: [
        {"keys": [("dedupe_key", 1)], "unique": True},
        {"keys": [("status", 1), ("next_run_at", 1)]},
        {"keys": [("status", 1), ("priority", 1), ("end", -1)]},
    ],
    COLLECTIONS["features"]: [
        {"keys": [("trader_id", 1), ("analysis_version", 1), ("feature_key", 1)], "unique": True},
    ],
    COLLECTIONS["trade_features"]: [
        {"keys": [("feature_id", 1)], "unique": True},
        {"keys": [("trader_id", 1), ("timestamp", -1)]},
        {"keys": [("chain", 1), ("token_address", 1), ("timestamp", 1)]},
    ],
    COLLECTIONS["episode_features"]: [
        {"keys": [("feature_id", 1)], "unique": True},
        {"keys": [("trader_id", 1), ("opened_at", -1)]},
        {"keys": [("price_path_status", 1), ("chain", 1)]},
    ],
    COLLECTIONS["patterns"]: [
        {"keys": [("pattern_id", 1)], "unique": True},
        {"keys": [("trader_id", 1), ("analysis_version", 1), ("pattern_key", 1)], "unique": True},
    ],
    COLLECTIONS["pattern_snapshots"]: [
        {"keys": [("snapshot_id", 1)], "unique": True},
        {"keys": [("trader_id", 1), ("computed_at", -1)]},
        {"keys": [("trader_id", 1), ("pattern_key", 1), ("rule_version", 1)]},
    ],
    COLLECTIONS["episode_pattern_links"]: [
        {"keys": [("link_id", 1)], "unique": True},
        {"keys": [("episode_id", 1), ("recognized_at", 1)]},
        {"keys": [("pattern_key", 1), ("state", 1)]},
    ],
    COLLECTIONS["story_events"]: [
        {"keys": [("event_id", 1)], "unique": True},
        {"keys": [("episode_id", 1), ("occurred_at", 1)]},
        {"keys": [("event_type", 1), ("occurred_at", -1)]},
    ],
    COLLECTIONS["economic_actions"]: [
        {"keys": [("action_id", 1)], "unique": True},
        {"keys": [("trader_id", 1), ("timestamp", -1)]},
        {"keys": [("episode_id", 1), ("timestamp", 1)]},
    ],
    COLLECTIONS["action_assessments"]: [
        {"keys": [("assessment_id", 1)], "unique": True},
        {"keys": [("trader_id", 1), ("observed_at", -1)]},
        {"keys": [("action_id", 1), ("assessed_at", 1)]},
        {"keys": [("evaluation_deadline", 1), ("subsequent_outcome.evaluation_status", 1)]},
    ],
    COLLECTIONS["position_action_stories"]: [
        {"keys": [("story_id", 1)], "unique": True},
        {"keys": [("trader_id", 1), ("position_id", 1), ("model_version", 1)]},
    ],
    COLLECTIONS["trader_pattern_summaries"]: [
        {"keys": [("summary_id", 1)], "unique": True},
        {"keys": [("trader_id", 1), ("model_version", 1), ("computed_at", -1)]},
    ],
    COLLECTIONS["portfolio_snapshots"]: [
        {"keys": [("snapshot_id", 1)], "unique": True},
        {"keys": [("trader_id", 1), ("valuation_time", -1)]},
    ],
    COLLECTIONS["external_flows"]: [
        {"keys": [("event_id", 1)], "unique": True},
        {"keys": [("trader_id", 1), ("timestamp", -1)]},
        {"keys": [("chain", 1), ("token_address", 1), ("timestamp", -1)]},
    ],
    COLLECTIONS["holder_snapshots"]: [
        {"keys": [("holder_snapshot_id", 1)], "unique": True},
        {"keys": [("token_id", 1), ("observed_at", -1)]},
        {"keys": [("fomo_user_id", 1), ("observed_at", -1)]},
    ],
    COLLECTIONS["trader_portfolio_snapshots"]: [
        {"keys": [("portfolio_snapshot_id", 1)], "unique": True},
        {"keys": [("fomo_user_id", 1), ("valuation_at", -1)]},
        {"keys": [("run_id", 1), ("fomo_user_id", 1)]},
    ],
    COLLECTIONS["raw_api_payloads"]: [
        {"keys": [("payload_id", 1)], "unique": True},
        {"keys": [("run_id", 1), ("observed_at", 1)]},
        {"keys": [("sha256", 1)]},
    ],
    COLLECTIONS["trader_rankings"]: [
        {"keys": [("ranking_id", 1)], "unique": True},
        {"keys": [("ranking_snapshot_id", 1), ("portfolio_value_rank", 1)]},
        {"keys": [("ranking_snapshot_id", 1), ("total_pnl_rank", 1)]},
        {"keys": [("fomo_user_id", 1), ("computed_at", -1)]},
    ],
    COLLECTIONS["ingestion_runs"]: [
        {"keys": [("ingestion_run_id", 1)], "unique": True},
        {"keys": [("status", 1), ("completed_at", -1)]},
    ],
    COLLECTIONS["wallet_identities"]: [
        {"keys": [("wallet_id", 1)], "unique": True},
        {"keys": [("chain", 1), ("address", 1)], "unique": True},
        {"keys": [("label", 1), ("analysis_support", 1)]},
        {"keys": [("cohort_ids", 1), ("chain", 1)]},
    ],
    COLLECTIONS["cohorts"]: [
        {"keys": [("cohort_id", 1)], "unique": True},
        {"keys": [("status", 1), ("frozen_at", -1)]},
    ],
    COLLECTIONS["cohort_memberships"]: [
        {"keys": [("membership_id", 1)], "unique": True},
        {"keys": [("cohort_id", 1), ("rank", 1)], "unique": True},
        {"keys": [("cohort_id", 1), ("trader_id", 1)], "unique": True},
    ],
    COLLECTIONS["venue_attributions"]: [
        {"keys": [("action_id", 1), ("classifier_version", 1)], "unique": True},
        {"keys": [("order_origin", 1), ("primary_execution_venue", 1)]},
        {"keys": [("confidence", 1), ("classified_at", -1)]},
    ],
    COLLECTIONS["realtime_actions"]: [
        {"keys": [("action_id", 1)], "unique": True},
        {"keys": [("chain", 1), ("token_address", 1), ("timestamp", -1)]},
        {"keys": [("wallet_id", 1), ("timestamp", -1)]},
        {"keys": [("wallet_label", 1), ("timestamp", -1)]},
    ],
    COLLECTIONS["coin_flow_buckets"]: [
        {"keys": [("bucket_id", 1)], "unique": True},
        {
            "keys": [
                ("chain", 1), ("token_address", 1),
                ("interval", 1), ("bucket_start", 1),
                ("top_money_cohort_id", 1),
            ],
            "unique": True,
        },
        {"keys": [("bucket_end", -1), ("top_money.net_inflow_usd", -1)]},
    ],
    COLLECTIONS["wallet_holdings"]: [
        {"keys": [("snapshot_id", 1)], "unique": True},
        {"keys": [("wallet_id", 1), ("observed_at", -1)]},
        {"keys": [("chain", 1), ("token_address", 1), ("observed_at", -1)]},
        {"keys": [("wallet_label", 1), ("observed_at", -1)]},
    ],
    COLLECTIONS["narrative_posts"]: [
        {"keys": [("post_id", 1)], "unique": True},
        {"keys": [("author_trader_id", 1), ("posted_at", -1)]},
        {"keys": [("token_ids", 1), ("posted_at", -1)]},
        {"keys": [("post_type", 1), ("posted_at", -1)]},
    ],
    COLLECTIONS["narrative_clusters"]: [
        {"keys": [("cluster_id", 1)], "unique": True},
        {"keys": [("window_end", -1), ("strength_score", -1)]},
        {"keys": [("token_ids", 1), ("window_end", -1)]},
    ],
    COLLECTIONS["runs"]: [
        {"keys": [("run_id", 1)], "unique": True},
        {"keys": [("trader_id", 1), ("started_at", -1)]},
    ],
}


def ensure_indexes(database: Any) -> None:
    """Create idempotent indexes after MONGODB_URI is supplied."""
    for collection_name, definitions in INDEXES.items():
        collection = database[collection_name]
        for definition in definitions:
            collection.create_index(
                definition["keys"], unique=definition.get("unique", False)
            )
