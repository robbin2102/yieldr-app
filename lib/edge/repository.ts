import "server-only";
import type { Document } from "mongodb";
import { edgeDb } from "./db";
import {
  ANALYSIS_VERSION,
  MODEL_VERSION,
  RULE_VERSION,
  compatible,
  resultDto,
  positionDto,
  storyDto,
  identity,
  decimal,
  iso,
  str,
  walletInput,
} from "./domain";
import { EdgeError } from "./config";
import type { Holdings, TopTrader } from "@/types/edge";
const version = { model_version: MODEL_VERSION, rule_version: RULE_VERSION };
const projection = (fields: string) =>
  Object.fromEntries([["_id", 0], ...fields.split(" ").map((k) => [k, 1])]);
const traderFields = projection(
  "trader_id username x_handle evm_wallet solana_wallet fomo_user_id",
);
const summaryFields = projection(
  "summary_id trader_id model_version rule_version analysis_status analysis_window_days computed_at trade_leg_count economic_action_count closed_position_count open_position_count price_readiness pattern_findings trader_economics opening_inventory_disposal_count partially_attributed_disposal_count",
);
const positionFields = projection(
  "episode_id trader_id chain token_address token_symbol opened_at closed_at buy_count sell_count priced_buy_count priced_sell_count realized_pnl_usd verified_acquisition_cost_usd realized_return_pct analysis_version",
);
export async function lookupTrader(input: string) {
  const w = walletInput(input);
  if (!w) return null;
  const db = await edgeDb();
  return db
    .collection("fomo_analysis_traders")
    .findOne(
      { [w.type === "evm" ? "evm_wallet" : "solana_wallet"]: w.wallet },
      { projection: traderFields, maxTimeMS: 5000 },
    );
}
export async function summaryFor(traderId: string) {
  const db = await edgeDb();
  return db
    .collection("fomo_analysis_trader_pattern_summaries")
    .findOne(
      {
        ...version,
        trader_id: traderId,
        analysis_status: "completed",
        analysis_window_days: 90,
      },
      {
        projection: summaryFields,
        sort: { computed_at: -1, summary_id: 1 },
        maxTimeMS: 5000,
      },
    );
}
export async function readResult(summaryId: string) {
  const db = await edgeDb();
  const s = await db
    .collection("fomo_analysis_trader_pattern_summaries")
    .findOne(
      { ...version, summary_id: summaryId },
      { projection: summaryFields, maxTimeMS: 5000 },
    );
  if (!s || !compatible(s)) throw new EdgeError("result_unavailable", 404);
  const [t, run] = await Promise.all([
    db
      .collection("fomo_analysis_traders")
      .findOne(
        { trader_id: s.trader_id },
        { projection: traderFields, maxTimeMS: 5000 },
      ),
    db
      .collection("fomo_analysis_runs")
      .findOne(
        {
          trader_id: s.trader_id,
          analysis_version: ANALYSIS_VERSION,
          trade_count: s.trade_leg_count,
          position_count: s.closed_position_count + s.open_position_count,
        },
        {
          projection: projection(
            "analysis_version window_start window_end status updated_at position_count trade_count",
          ),
          sort: { updated_at: -1 },
          maxTimeMS: 5000,
        },
      ),
  ]);
  if (!t) throw new EdgeError("result_unavailable", 404);
  return resultDto(
    t,
    s,
    run &&
      iso(run.window_end) &&
      Date.parse(iso(run.window_end)!) <= Date.parse(s.computed_at)
      ? run
      : null,
  );
}
export async function readPositions(summaryId: string) {
  const r = await readResult(summaryId);
  if (!r.windowStart || !r.windowEnd)
    throw new EdgeError("analysis_window_unavailable", 409);
  const db = await edgeDb();
  const rows = await db
    .collection("fomo_analysis_position_episodes")
    .find(
      {
        trader_id: r.identity.id,
        analysis_version: ANALYSIS_VERSION,
        closed_at: {
          $gte: new Date(r.windowStart),
          $lte: new Date(r.windowEnd),
        },
      },
      { projection: positionFields, maxTimeMS: 8000 },
    )
    .sort({ closed_at: 1, episode_id: 1 })
    .limit(10001)
    .toArray();
  if (rows.length > 10000) throw new EdgeError("result_too_large", 409);
  if (r.closedPositions !== null && rows.length !== r.closedPositions) throw new EdgeError("position_revision_mismatch", 409);
  return rows
    .map(positionDto)
    .filter((x): x is NonNullable<typeof x> => x !== null);
}
export async function readHoldings(summaryId: string): Promise<Holdings> {
  const r = await readResult(summaryId);
  const db = await edgeDb();
  const wallets: Document[] = [];
  if (r.identity.evmWallet) wallets.push({ evm_wallet: r.identity.evmWallet });
  if (r.identity.solanaWallet)
    wallets.push({ solana_wallet: r.identity.solanaWallet });
  const [snapshot, open] = await Promise.all([
    wallets.length
      ? db
          .collection("fomo_analysis_trader_portfolio_snapshots")
          .findOne(
            { $or: wallets },
            {
              projection: projection(
                "valuation_at source positions.chain positions.token_address positions.symbol positions.quantity positions.price_usd positions.market_value_usd positions.remaining_cost_basis_usd positions.cost_basis_status",
              ),
              sort: { valuation_at: -1 },
              maxTimeMS: 5000,
            },
          )
      : null,
    db
      .collection("fomo_analysis_position_episodes")
      .find(
        {
          trader_id: r.identity.id,
          analysis_version: ANALYSIS_VERSION,
          closed_at: null,
        },
        {
          projection: projection("episode_id chain token_address"),
          maxTimeMS: 5000,
        },
      )
      .limit(10000)
      .toArray(),
  ]);
  if (!snapshot)
    return {
      status: "unavailable",
      observedAt: null,
      source: null,
      stale: true,
      items: [],
    };
  const observedAt = iso(snapshot.valuation_at);
  return {
    status: "available",
    observedAt,
    source: str(snapshot.source),
    stale: !observedAt || Date.now() - Date.parse(observedAt) > 15 * 60 * 1000,
    items: (snapshot.positions || []).map((p: Document) => ({
      chain: p.chain,
      tokenAddress: p.token_address,
      symbol: str(p.symbol),
      quantity: decimal(p.quantity),
      price: decimal(p.price_usd),
      value: decimal(p.market_value_usd),
      costBasis: decimal(p.remaining_cost_basis_usd),
      costBasisStatus: str(p.cost_basis_status) || "unknown",
      openEpisodeIds: open
        .filter(
          (e) => e.chain === p.chain && e.token_address === p.token_address,
        )
        .map((e) => e.episode_id),
      externalReceipt: null,
    })),
  };
}
export async function readStories(summaryId: string, offset = 0) {
  const r = await readResult(summaryId);
  const db = await edgeDb();
  const rows = await db
    .collection("fomo_analysis_position_action_stories")
    .find(
      { ...version, trader_id: r.identity.id },
      {
        projection: projection(
          "story_id position_id token_symbol token_address chain position_state plain_english_story chapters.chapter_id chapters.occurred_at chapters.action_type chapters.what_happened chapters.actual_progress.plain_english chapters.primary_supported_pattern.pattern_name chapters.primary_supported_pattern.finding_status chapters.primary_pattern_context.pattern_name chapters.primary_pattern_context.finding_status chapters.primary_pattern_context.prior_historical_evidence chapters.correction chapters.supersedes_chapter_id",
        ),
        maxTimeMS: 8000,
      },
    )
    .sort({ position_id: 1 })
    .skip(offset)
    .limit(21)
    .toArray();
  return {
    items: rows.slice(0, 20).map(storyDto),
    nextOffset: rows.length > 20 ? offset + 20 : null,
  };
}
export async function validatedTraders(limit: number): Promise<TopTrader[]> {
  const db = await edgeDb();
  // Latest compatible summary first, then validation: never resurrect an older edge.
  const rows = await db
    .collection("fomo_analysis_trader_pattern_summaries")
    .aggregate(
      [
        {
          $match: {
            ...version,
            analysis_status: "completed",
            analysis_window_days: 90,
          },
        },
        { $sort: { computed_at: -1, summary_id: 1 } },
        { $group: { _id: "$trader_id", latest: { $first: "$$ROOT" } } },
        { $replaceRoot: { newRoot: "$latest" } },
        {
          $match: {
            "price_readiness.status": "ready",
            pattern_findings: {
              $elemMatch: {
                finding_status: "validated_positive_edge",
                "publication.is_validated_edge": true,
                pattern_model_version: MODEL_VERSION,
                rule_version: RULE_VERSION,
              },
            },
          },
        },
        { $sort: { priority_rank: 1, trader_id: 1 } },
        { $limit: limit },
        { $project: summaryFields },
      ],
      { maxTimeMS: 8000 },
    )
    .toArray();
  return Promise.all(
    rows.map(async (s) => {
      const t = await db
        .collection("fomo_analysis_traders")
        .findOne(
          { trader_id: s.trader_id },
          { projection: traderFields, maxTimeMS: 5000 },
        );
      return {
        identity: identity(t || s),
        summaryId: s.summary_id,
        validatedCount: (s.pattern_findings || []).filter(
          (p: Document) =>
            p.finding_status === "validated_positive_edge" &&
            p.publication?.is_validated_edge === true &&
            p.pattern_model_version === MODEL_VERSION &&
            p.rule_version === RULE_VERSION,
        ).length,
        modelVersion: s.model_version,
        ruleVersion: s.rule_version,
        analyzedAt: iso(s.computed_at),
      };
    }),
  );
}
