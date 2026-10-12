"""Idempotent MongoDB persistence for one analyzed trader."""

from __future__ import annotations

import hashlib
import uuid
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Iterable

from bson.decimal128 import Decimal128
from pymongo import MongoClient, ReturnDocument, UpdateOne
from pymongo.errors import BulkWriteError

from fomo_analysis import ANALYSIS_VERSION
from fomo_analysis.models import Candle, NormalizedTrade
from fomo_analysis.market_data import MarketDataJob, safe_decimal
from fomo_analysis.mongo_schema import COLLECTIONS
from fomo_analysis.positions import PositionEpisode


def decimal128(value: Decimal | None) -> Decimal128 | None:
    return None if value is None else Decimal128(value)


def trade_document(trade: NormalizedTrade) -> dict[str, Any]:
    return {
        "trade_id": trade.trade_id,
        "trader_id": trade.trader_id,
        "wallet": trade.wallet,
        "chain": trade.chain,
        "transaction_id": trade.transaction_id,
        "leg_index": trade.leg_index,
        "timestamp": trade.timestamp,
        "side": trade.side,
        "token_address": trade.token_address,
        "token_symbol": trade.token_symbol,
        "token_amount": decimal128(trade.token_amount),
        "usd_notional": decimal128(trade.usd_notional),
        "execution_price_usd": decimal128(trade.execution_price_usd),
        "amount_source": trade.amount_source,
        "evidence": trade.evidence,
        "analysis_version": ANALYSIS_VERSION,
    }


def position_document(episode: PositionEpisode) -> dict[str, Any]:
    episode_id = f"{episode.trader_id}:{episode.chain}:{episode.token_address}:{episode.episode_number}"
    return {
        "episode_id": episode_id,
        "trader_id": episode.trader_id,
        "chain": episode.chain,
        "token_address": episode.token_address,
        "token_symbol": episode.token_symbol,
        "episode_number": episode.episode_number,
        "opened_at": episode.opened_at,
        "closed_at": episode.closed_at,
        "bought_quantity": decimal128(episode.bought_quantity),
        "sold_quantity": decimal128(episode.sold_quantity),
        "remaining_quantity": decimal128(episode.remaining_quantity),
        "buy_notional_usd": decimal128(episode.buy_notional_usd),
        "sell_notional_usd": decimal128(episode.sell_notional_usd),
        "realized_pnl_usd": decimal128(episode.realized_pnl_usd),
        "priced_buy_count": episode.priced_buy_count,
        "priced_sell_count": episode.priced_sell_count,
        "buy_count": episode.buy_count,
        "sell_count": episode.sell_count,
        "trade_ids": episode.trade_ids,
        "analysis_version": ANALYSIS_VERSION,
    }


def candle_document(candle: Candle) -> dict[str, Any]:
    return {
        "price_point_id": f"{candle.chain}:{candle.token_address}:{candle.open_time.isoformat()}",
        "chain": candle.chain,
        "token_address": candle.token_address,
        "timestamp": candle.open_time,
        "interval": candle.interval,
        "open": decimal128(candle.open),
        "high": decimal128(candle.high),
        "low": decimal128(candle.low),
        "close": decimal128(candle.close),
        "sample_count": candle.sample_count,
        "source": candle.source,
        "quality": candle.quality,
    }


def _run_id(trader_id: str, window_start: str, window_end: str) -> str:
    raw = f"{ANALYSIS_VERSION}|{trader_id}|{window_start}|{window_end}".encode()
    return hashlib.sha256(raw).hexdigest()


class MongoAnalysisRepository:
    def __init__(self, uri: str, database: str) -> None:
        self.client = MongoClient(
            uri, serverSelectionTimeoutMS=10_000, tz_aware=True
        )
        self.database = self.client[database]

    def close(self) -> None:
        self.client.close()

    def ping(self) -> None:
        self.client.admin.command("ping")

    def upsert_portfolio_snapshot(
        self, trader_id: str, payload: dict[str, Any]
    ) -> dict[str, int]:
        """Persist one compact snapshot and its auditable transfer events."""
        snapshot = dict(payload)
        external = dict(snapshot.get("external_flow_audit") or {})
        internal = dict(snapshot.get("fomo_internal_funding_audit") or {})
        events = list(external.pop("events", [])) + list(internal.pop("events", []))
        snapshot["external_flow_audit"] = external
        snapshot["fomo_internal_funding_audit"] = internal
        snapshot_id = (
            f"{trader_id}:{snapshot.get('window_days')}d:"
            f"{str(snapshot.get('valuation_time'))[:10]}"
        )
        snapshot.update({"snapshot_id": snapshot_id, "trader_id": trader_id})
        self.database[COLLECTIONS["portfolio_snapshots"]].update_one(
            {"snapshot_id": snapshot_id}, {"$set": snapshot}, upsert=True
        )
        rows = []
        for event in events:
            row = dict(event)
            timestamp = row.get("timestamp")
            if isinstance(timestamp, str):
                row["timestamp"] = datetime.fromisoformat(
                    timestamp.replace("Z", "+00:00")
                )
            row["trader_id"] = trader_id
            rows.append(row)
        return {
            "portfolio_snapshots": 1,
            "external_flow_events": self._upsert_many(
                COLLECTIONS["external_flows"], "event_id", rows
            ),
        }

    def upsert_trader_profiles(self, traders: Iterable[dict[str, Any]]) -> int:
        now = datetime.now(timezone.utc)
        documents = []
        for trader in traders:
            if not trader.get("evm_wallet") or not trader.get("solana_wallet"):
                continue
            documents.append({
                "trader_id": trader["trader_id"],
                "evm_wallet": trader["evm_wallet"].lower(),
                "solana_wallet": trader["solana_wallet"],
                "username": trader.get("username"),
                "x_handle": trader.get("x_handle"),
                "priority_rank": trader.get("priority_rank"),
                "source_url": trader.get("source_url"),
                "fomoscan_url": trader.get("fomoscan_url"),
                "fomo_display_name": trader.get("fomo_display_name"),
                "profile_image_url": trader.get("profile_image_url"),
                "cover_image_url": trader.get("cover_image_url"),
                "bio": trader.get("bio"),
                "resolution_status": trader.get("resolution_status"),
                "analysis_version": ANALYSIS_VERSION,
                "updated_at": now,
            })
        processed = self._upsert_many(COLLECTIONS["traders"], "trader_id", documents)
        if documents:
            self.database[COLLECTIONS["traders"]].update_many(
                {
                    "trader_id": {"$in": [row["trader_id"] for row in documents]},
                    "status": {"$exists": False},
                },
                {"$set": {"status": "pending_trade_sync"}},
            )
        return processed

    def upsert_price_candles(
        self,
        candles: Iterable[Candle],
        status: str = "sampled",
        update_coverage: bool = True,
    ) -> dict[str, int]:
        rows = list(candles)
        points = self._insert_candles_ignore_duplicates(rows)
        grouped: dict[tuple[str, str, str], list[Candle]] = defaultdict(list)
        for candle in rows:
            grouped[(candle.chain, candle.token_address, candle.interval)].append(candle)
        now = datetime.now(timezone.utc)
        coverage_operations = []
        for (chain, token_address, interval), token_candles in grouped.items():
            coverage_operations.append(
                UpdateOne(
                    {
                        "chain": chain,
                        "token_address": token_address,
                        "interval": interval,
                    },
                    {
                        "$set": {
                            "chain": chain,
                            "token_address": token_address,
                            "interval": interval,
                            "last_batch_candle_count": len(token_candles),
                            "status": status,
                            "updated_at": now,
                        },
                        "$min": {
                            "earliest_at": min(
                                row.open_time for row in token_candles
                            )
                        },
                        "$max": {
                            "latest_at": max(
                                row.open_time for row in token_candles
                            )
                        },
                    },
                    upsert=True,
                )
            )
        if update_coverage and coverage_operations:
            self.database[COLLECTIONS["price_coverage"]].bulk_write(
                coverage_operations, ordered=False
            )
        return {"price_points": points, "coverage_records": len(grouped)}

    def _insert_candles_ignore_duplicates(
        self, candles: Iterable[Candle], chunk_size: int = 20_000
    ) -> int:
        """Insert immutable candles quickly; retries safely ignore unique-key hits."""
        documents = [candle_document(row) for row in candles]
        inserted = 0
        collection = self.database[COLLECTIONS["price_points"]]
        for start in range(0, len(documents), chunk_size):
            group = documents[start : start + chunk_size]
            if not group:
                continue
            try:
                result = collection.insert_many(group, ordered=False)
                inserted += len(result.inserted_ids)
            except BulkWriteError as exc:
                errors = exc.details.get("writeErrors", [])
                unexpected = [
                    error for error in errors if error.get("code") != 11000
                ]
                if unexpected:
                    raise
                inserted += int(exc.details.get("nInserted", 0))
        return inserted

    def upsert_token_market_snapshots(
        self, snapshots: Iterable[dict[str, Any]]
    ) -> int:
        now = datetime.now(timezone.utc)
        documents = []
        for snapshot in snapshots:
            document = dict(snapshot)
            document["current_price_usd"] = decimal128(
                safe_decimal(document.get("current_price_usd"))
            )
            document["pool_reserve_usd"] = decimal128(
                safe_decimal(document.get("pool_reserve_usd"))
            )
            pool_created_at = document.get("pool_created_at")
            if isinstance(pool_created_at, str) and pool_created_at:
                document["pool_created_at"] = datetime.fromisoformat(
                    pool_created_at.replace("Z", "+00:00")
                )
            document["updated_at"] = now
            documents.append(document)
        return self._upsert_many(
            COLLECTIONS["tokens"], "token_id", documents
        )

    def upsert_token_pool_candidates(
        self, rows: Iterable[dict[str, Any]]
    ) -> int:
        now = datetime.now(timezone.utc)
        operations = [
            UpdateOne(
                {"token_id": row["token_id"]},
                {"$set": {
                    "pool_candidates": row["pool_candidates"],
                    "pool_candidates_observed_at": now,
                    "updated_at": now,
                }},
                upsert=False,
            )
            for row in rows
        ]
        if operations:
            self.database[COLLECTIONS["tokens"]].bulk_write(
                operations, ordered=False
            )
        return len(operations)

    def recent_token_market_snapshots(
        self,
        addresses_by_chain: dict[str, list[str]],
        max_age: timedelta = timedelta(hours=24),
    ) -> list[dict[str, Any]]:
        cutoff = datetime.now(timezone.utc) - max_age
        clauses = [
            {"chain": chain, "token_address": {"$in": list(set(addresses))}}
            for chain, addresses in addresses_by_chain.items()
            if addresses
        ]
        if not clauses:
            return []
        return list(
            self.database[COLLECTIONS["tokens"]].find(
                {"$or": clauses, "price_observed_at": {"$gte": cutoff}},
                {"_id": 0},
            )
        )

    def load_price_candles(
        self, token_keys: Iterable[tuple[str, str]]
    ) -> list[Candle]:
        clauses = [
            {"chain": chain, "token_address": token_address, "interval": "5m"}
            for chain, token_address in sorted(set(token_keys))
        ]
        if not clauses:
            return []
        rows = self.database[COLLECTIONS["price_points"]].find(
            {"$or": clauses}, {"_id": 0}
        ).sort("timestamp", 1)
        return [
            Candle(
                chain=row["chain"],
                token_address=row["token_address"],
                open_time=row["timestamp"],
                interval=row["interval"],
                open=row["open"].to_decimal(),
                high=row["high"].to_decimal(),
                low=row["low"].to_decimal(),
                close=row["close"].to_decimal(),
                sample_count=row.get("sample_count", 1),
                source=row.get("source", "unknown"),
                quality=row.get("quality", "unknown"),
            )
            for row in rows
        ]

    def load_price_candles_for_windows(
        self,
        windows: Iterable[tuple[str, str, datetime]],
        tolerance: timedelta = timedelta(minutes=10),
        chunk_size: int = 300,
    ) -> list[Candle]:
        """Load only small candle windows needed for point-in-time outcomes."""
        grouped: dict[tuple[str, str], list[tuple[datetime, datetime]]] = defaultdict(list)
        for chain, token_address, at in windows:
            grouped[(chain, token_address)].append((at - tolerance, at))
        clauses = []
        for (chain, token_address), ranges in grouped.items():
            merged: list[list[datetime]] = []
            for start, end in sorted(ranges):
                if merged and start <= merged[-1][1] + timedelta(minutes=5):
                    merged[-1][1] = max(merged[-1][1], end)
                else:
                    merged.append([start, end])
            clauses.extend({
                "chain": chain,
                "token_address": token_address,
                "interval": "5m",
                "timestamp": {"$gte": start, "$lte": end},
            } for start, end in merged)
        documents: dict[tuple[str, str, datetime], dict[str, Any]] = {}
        projection = {
            "_id": 0, "chain": 1, "token_address": 1, "timestamp": 1,
            "interval": 1, "open": 1, "high": 1, "low": 1, "close": 1,
            "sample_count": 1, "source": 1, "quality": 1,
        }
        for start in range(0, len(clauses), chunk_size):
            for row in self.database[COLLECTIONS["price_points"]].find(
                {"$or": clauses[start : start + chunk_size]}, projection
            ):
                documents[(row["chain"], row["token_address"], row["timestamp"])] = row
        return [
            Candle(
                chain=row["chain"], token_address=row["token_address"],
                open_time=row["timestamp"], interval=row.get("interval", "5m"),
                open=row["open"].to_decimal(), high=row["high"].to_decimal(),
                low=row["low"].to_decimal(), close=row["close"].to_decimal(),
                sample_count=row.get("sample_count", 1),
                source=row.get("source", "unknown"), quality=row.get("quality", "unknown"),
            )
            for row in sorted(documents.values(), key=lambda item: item["timestamp"])
        ]

    def rebuild_price_coverage(self) -> int:
        """Rebuild the derived availability index after a bulk candle backfill."""
        pipeline = [
            {"$match": {"interval": "5m"}},
            {"$group": {
                "_id": {
                    "chain": "$chain",
                    "token_address": "$token_address",
                    "interval": "$interval",
                },
                "earliest_at": {"$min": "$timestamp"},
                "latest_at": {"$max": "$timestamp"},
                "candle_count": {"$sum": 1},
                "sources": {"$addToSet": "$source"},
            }},
        ]
        now = datetime.now(timezone.utc)
        operations = []
        for row in self.database[COLLECTIONS["price_points"]].aggregate(
            pipeline, allowDiskUse=True
        ):
            identity = row["_id"]
            operations.append(UpdateOne(
                identity,
                {"$set": {
                    **identity,
                    "earliest_at": row["earliest_at"],
                    "latest_at": row["latest_at"],
                    "candle_count": row["candle_count"],
                    "sources": row["sources"],
                    "status": "indexed",
                    "updated_at": now,
                }},
                upsert=True,
            ))
        if operations:
            self.database[COLLECTIONS["price_coverage"]].bulk_write(
                operations, ordered=False
            )
        return len(operations)

    def upsert_market_data_jobs(self, jobs: Iterable[MarketDataJob]) -> int:
        now = datetime.now(timezone.utc)
        collection = self.database[COLLECTIONS["jobs"]]
        rows = list(jobs)
        processed = 0
        for start in range(0, len(rows), 500):
            operations = []
            for job in rows[start : start + 500]:
                document = job.as_document()
                dynamic = {
                    "reason": document.pop("reason"),
                    "priority": document.pop("priority"),
                    "updated_at": now,
                }
                operations.append(
                    UpdateOne(
                        {"dedupe_key": job.dedupe_key},
                        {
                            "$setOnInsert": {
                                **document,
                                "job_type": "price_backfill_5m",
                                "status": "pending",
                                "attempt_count": 0,
                                "created_at": now,
                            },
                            "$set": dynamic,
                        },
                        upsert=True,
                    )
                )
            if operations:
                collection.bulk_write(operations, ordered=False)
                processed += len(operations)
        return processed

    def market_job_statuses(self, dedupe_keys: Iterable[str]) -> dict[str, str]:
        keys = list(dedupe_keys)
        if not keys:
            return {}
        rows = self.database[COLLECTIONS["jobs"]].find(
            {"dedupe_key": {"$in": keys}}, {"dedupe_key": 1, "status": 1}
        )
        return {row["dedupe_key"]: row.get("status", "pending") for row in rows}

    def claim_market_data_job(
        self,
        dedupe_keys: Iterable[str],
        worker_id: str,
        lease_seconds: int = 900,
    ) -> dict[str, Any] | None:
        now = datetime.now(timezone.utc)
        return self.database[COLLECTIONS["jobs"]].find_one_and_update(
            {
                "dedupe_key": {"$in": list(dedupe_keys)},
                "status": {"$in": ["pending", "error", "running"]},
                "$and": [
                    {"$or": [
                        {"next_run_at": {"$exists": False}},
                        {"next_run_at": {"$lte": now}},
                    ]},
                    {"$or": [
                        {"lease_expires_at": {"$exists": False}},
                        {"lease_expires_at": {"$lte": now}},
                    ]},
                ],
            },
            {
                "$set": {
                    "status": "running",
                    "lease_owner": worker_id,
                    "lease_expires_at": now + timedelta(seconds=lease_seconds),
                    "started_at": now,
                    "updated_at": now,
                },
                "$inc": {"attempt_count": 1},
            },
            sort=[("priority", 1), ("end", -1)],
            return_document=ReturnDocument.AFTER,
        )

    def claim_market_data_jobs(
        self,
        dedupe_keys: Iterable[str],
        worker_id: str,
        limit: int,
        lease_seconds: int = 900,
    ) -> list[dict[str, Any]]:
        """Lease a bounded batch using three Mongo round trips, not one per job."""
        if limit < 1:
            return []
        now = datetime.now(timezone.utc)
        eligible = {
            "dedupe_key": {"$in": list(dedupe_keys)},
            "status": {"$in": ["pending", "error", "running"]},
            "$and": [
                {"$or": [
                    {"next_run_at": {"$exists": False}},
                    {"next_run_at": {"$lte": now}},
                ]},
                {"$or": [
                    {"lease_expires_at": {"$exists": False}},
                    {"lease_expires_at": {"$lte": now}},
                ]},
            ],
        }
        selected = list(
            self.database[COLLECTIONS["jobs"]]
            .find(eligible, {"dedupe_key": 1})
            .sort([("priority", 1), ("end", -1)])
            .limit(limit)
        )
        if not selected:
            return []
        lease_id = f"{worker_id}:{uuid.uuid4()}"
        selected_keys = [row["dedupe_key"] for row in selected]
        claim_filter = dict(eligible)
        claim_filter["dedupe_key"] = {"$in": selected_keys}
        self.database[COLLECTIONS["jobs"]].update_many(
            claim_filter,
            {
                "$set": {
                    "status": "running",
                    "lease_owner": worker_id,
                    "lease_id": lease_id,
                    "lease_expires_at": now + timedelta(seconds=lease_seconds),
                    "started_at": now,
                    "updated_at": now,
                },
                "$inc": {"attempt_count": 1},
            },
        )
        return list(
            self.database[COLLECTIONS["jobs"]].find(
                {"lease_id": lease_id}, {"_id": 0}
            )
        )

    def invalidate_jobs_whose_pool_did_not_exist(self) -> int:
        snapshots = list(
            self.database[COLLECTIONS["tokens"]].find(
                {
                    "pool_address": {"$ne": None},
                    "pool_created_at": {"$type": "date"},
                },
                {"chain": 1, "token_address": 1, "pool_address": 1, "pool_created_at": 1},
            )
        )
        created_by_pool = {
            (row["chain"], row["token_address"], row["pool_address"]): row["pool_created_at"]
            for row in snapshots
        }
        operations = []
        jobs = self.database[COLLECTIONS["jobs"]].find(
            {"job_type": "price_backfill_5m", "status": "pending"},
            {"dedupe_key": 1, "chain": 1, "token_address": 1, "pool_address": 1, "end": 1},
        )
        now = datetime.now(timezone.utc)
        for job in jobs:
            created = created_by_pool.get(
                (job["chain"], job["token_address"], job["pool_address"])
            )
            if created and created > job["end"]:
                operations.append(
                    UpdateOne(
                        {"dedupe_key": job["dedupe_key"], "status": "pending"},
                        {"$set": {
                            "status": "invalid_pool_after_window",
                            "last_error": "Selected pool was created after requested window",
                            "updated_at": now,
                        }},
                    )
                )
        if operations:
            self.database[COLLECTIONS["jobs"]].bulk_write(
                operations, ordered=False
            )
        return len(operations)

    def mark_market_data_job(
        self, job: MarketDataJob, result: dict[str, Any]
    ) -> None:
        self.mark_market_data_jobs([(job, result)])

    def mark_market_data_jobs(
        self, rows: Iterable[tuple[MarketDataJob, dict[str, Any]]]
    ) -> None:
        now = datetime.now(timezone.utc)
        operations = []
        for job, result in rows:
            unset = {
                "lease_owner": "",
                "lease_id": "",
                "lease_expires_at": "",
            }
            if "next_run_at" not in result:
                unset["next_run_at"] = ""
            operations.append(
                UpdateOne(
                    {"dedupe_key": job.dedupe_key},
                    {
                        "$set": {
                            **job.as_document(),
                            **result,
                            "job_type": "price_backfill_5m",
                            "updated_at": now,
                        },
                        "$setOnInsert": {"created_at": now},
                        "$unset": unset,
                    },
                    upsert=True,
                )
            )
        if operations:
            self.database[COLLECTIONS["jobs"]].bulk_write(
                operations, ordered=False
            )

    def upsert_price_features(
        self,
        trader_id: str,
        entry_features: Iterable[dict[str, Any]],
        episode_features: Iterable[dict[str, Any]],
        summary: dict[str, Any],
        feature_namespace: str = "price_path",
        summary_feature_key: str = "price_path_readiness",
    ) -> dict[str, int]:
        now = datetime.now(timezone.utc)

        def convert(row: dict[str, Any], identity: str) -> dict[str, Any]:
            document = dict(row)
            for key, value in list(document.items()):
                if isinstance(value, str) and key.endswith(("_pct", "_usd")):
                    numeric = safe_decimal(value)
                    document[key] = decimal128(numeric) if numeric is not None else value
            document.update({
                "feature_id": f"{identity}:{ANALYSIS_VERSION}:{feature_namespace}",
                "analysis_version": ANALYSIS_VERSION,
                "computed_at": now,
            })
            return document

        entries = [
            convert(row, row["trade_id"]) for row in entry_features
        ]
        episodes = [
            convert(row, row["episode_id"]) for row in episode_features
        ]
        entry_count = self._upsert_many(
            COLLECTIONS["trade_features"], "feature_id", entries
        )
        episode_count = self._upsert_many(
            COLLECTIONS["episode_features"], "feature_id", episodes
        )
        feature_id = f"{trader_id}:{ANALYSIS_VERSION}:{summary_feature_key}"
        self.database[COLLECTIONS["features"]].update_one(
            {"feature_id": feature_id},
            {"$set": {
                "feature_id": feature_id,
                "trader_id": trader_id,
                "analysis_version": ANALYSIS_VERSION,
                "feature_key": summary_feature_key,
                "values": summary,
                "computed_at": now,
            }},
            upsert=True,
        )
        return {"entry_features": entry_count, "episode_features": episode_count}

    def upsert_patterns(
        self, trader_id: str, patterns: Iterable[dict[str, Any]]
    ) -> int:
        now = datetime.now(timezone.utc)
        documents = []
        for pattern in patterns:
            document = dict(pattern)
            document.update({
                "pattern_id": f"{trader_id}:{ANALYSIS_VERSION}:{pattern['pattern_key']}",
                "trader_id": trader_id,
                "analysis_version": ANALYSIS_VERSION,
                "computed_at": now,
            })
            documents.append(document)
        return self._upsert_many(
            COLLECTIONS["patterns"], "pattern_id", documents
        )

    def upsert_pattern_story_report(self, report: dict[str, Any]) -> dict[str, int]:
        """Persist immutable/versioned story artifacts using deterministic IDs."""
        return {
            "pattern_snapshots": self._upsert_many(
                COLLECTIONS["pattern_snapshots"],
                "snapshot_id",
                report.get("pattern_cards", []),
            ),
            "episode_pattern_links": self._upsert_many(
                COLLECTIONS["episode_pattern_links"],
                "link_id",
                report.get("episode_pattern_links", []),
            ),
            "story_events": self._upsert_many(
                COLLECTIONS["story_events"],
                "event_id",
                report.get("position_story_events", []),
            ),
        }

    def upsert_v3_2_report(self, report: dict[str, Any]) -> dict[str, int]:
        """Persist versioned V3.2 actions, assessments, stories, and summaries."""
        return {
            "economic_actions": self._upsert_many(
                COLLECTIONS["economic_actions"],
                "action_id",
                report.get("action_rows", []),
            ),
            "action_assessments": self._upsert_many(
                COLLECTIONS["action_assessments"],
                "assessment_id",
                report.get("action_assessments", []),
            ),
            "position_action_stories": self._upsert_many(
                COLLECTIONS["position_action_stories"],
                "story_id",
                report.get("position_stories", []),
            ),
            "trader_pattern_summaries": self._upsert_many(
                COLLECTIONS["trader_pattern_summaries"],
                "summary_id",
                [report["trader_summary"]] if report.get("trader_summary") else [],
            ),
        }

    def _upsert_many(self, collection_name: str, key: str, documents: Iterable[dict[str, Any]], chunk_size: int = 500) -> int:
        rows = list(documents)
        processed = 0
        collection = self.database[collection_name]
        for start in range(0, len(rows), chunk_size):
            group = rows[start : start + chunk_size]
            operations = [UpdateOne({key: row[key]}, {"$set": row}, upsert=True) for row in group]
            if operations:
                collection.bulk_write(operations, ordered=False)
                processed += len(operations)
        return processed

    def index_one_trader(
        self,
        audit: dict[str, Any],
        trades: list[NormalizedTrade],
        episodes: list[PositionEpisode],
        features: dict[str, Any],
    ) -> dict[str, int | str]:
        trader_id = trades[0].trader_id
        now = datetime.now(timezone.utc)
        trader = {
            "trader_id": trader_id,
            "evm_wallet": audit["evm_wallet"].lower(),
            "solana_wallet": audit["solana_wallet"],
            "status": "indexed",
            "analysis_version": ANALYSIS_VERSION,
            "updated_at": now,
        }
        self.database[COLLECTIONS["traders"]].update_one(
            {"trader_id": trader_id}, {"$set": trader, "$setOnInsert": {"created_at": now}}, upsert=True
        )

        grouped: dict[tuple[str, str], list[NormalizedTrade]] = defaultdict(list)
        for trade in trades:
            grouped[(trade.chain, trade.token_address)].append(trade)
        token_documents = []
        for (chain, token_address), token_trades in grouped.items():
            token_documents.append({
                "token_id": f"{chain}:{token_address}",
                "chain": chain,
                "token_address": token_address,
                "symbol": next((row.token_symbol for row in token_trades if row.token_symbol), None),
                "first_seen_at": min(row.timestamp for row in token_trades),
                "last_seen_at": max(row.timestamp for row in token_trades),
                "price_status": "pending",
                "updated_at": now,
            })
        tokens = self._upsert_many(COLLECTIONS["tokens"], "token_id", token_documents)
        trade_count = self._upsert_many(COLLECTIONS["trades"], "trade_id", map(trade_document, trades))
        position_count = self._upsert_many(COLLECTIONS["positions"], "episode_id", map(position_document, episodes))

        feature_document = {
            "feature_id": f"{trader_id}:{ANALYSIS_VERSION}:behavior_summary",
            "trader_id": trader_id,
            "analysis_version": ANALYSIS_VERSION,
            "feature_key": "behavior_summary",
            "values": features,
            "computed_at": now,
        }
        self.database[COLLECTIONS["features"]].update_one(
            {"feature_id": feature_document["feature_id"]}, {"$set": feature_document}, upsert=True
        )
        run_id = _run_id(trader_id, audit["cutoff"], audit["generated_at"])
        run = {
            "run_id": run_id,
            "trader_id": trader_id,
            "analysis_version": ANALYSIS_VERSION,
            "window_start": audit["cutoff"],
            "window_end": audit["generated_at"],
            "trade_count": trade_count,
            "token_count": tokens,
            "position_count": position_count,
            "status": "foundation_indexed",
            "updated_at": now,
        }
        self.database[COLLECTIONS["runs"]].update_one({"run_id": run_id}, {"$set": run}, upsert=True)
        return {"trader_id": trader_id, "trades": trade_count, "tokens": tokens, "positions": position_count, "run_id": run_id}
