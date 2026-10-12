import type {
  Classification,
  EdgeResult,
  Finding,
  FindingStatus,
  Identity,
  Json,
  Position,
  Story,
} from "@/types/edge";
export const MODEL_VERSION = "3.3.0";
export const RULE_VERSION = "2026-09-09.2";
export const ANALYSIS_VERSION = "0.1.0";
export type RecordData = Record<string, any>; // Untrusted BSON is narrowed at the DTO boundary below.
export function walletInput(
  input: unknown,
): { wallet: string; type: "evm" | "solana" } | null {
  if (typeof input !== "string") return null;
  const value = input.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(value))
    return { wallet: value.toLowerCase(), type: "evm" };
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return null;
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = BigInt(0);
  for (const char of value) n = n * BigInt(58) + BigInt(alphabet.indexOf(char));
  let bytes = 0;
  while (n > 0) {
    bytes++;
    n >>= BigInt(8);
  }
  const leading = value.match(/^1*/)?.[0].length || 0;
  return bytes + leading === 32 ? { wallet: value, type: "solana" } : null;
}
export function decimal(value: unknown): string | null {
  const raw =
    typeof value === "string"
      ? value
      : typeof value === "number" && Number.isFinite(value)
        ? String(value)
        : value &&
            typeof value === "object" &&
            "_bsontype" in value &&
            value._bsontype === "Decimal128"
          ? String(value)
          : null;
  return raw !== null &&
    /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw)
    ? raw
    : null;
}
export function count(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
}
export function iso(v: unknown): string | null {
  if (!(v instanceof Date) && typeof v !== "string") return null;
  const date = new Date(v);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
export function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
export function strings(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string")
    : [];
}
export function json(v: unknown): Json {
  if (v == null) return null;
  if (v instanceof Date) return iso(v);
  if (typeof v === "object" && "_bsontype" in v) return decimal(v); // No ObjectIds cross the boundary.
  if (Array.isArray(v)) return v.map(json);
  if (typeof v === "object")
    return Object.fromEntries(
      Object.entries(v)
        .filter(([k]) => k !== "_id")
        .map(([k, x]) => [k, json(x)]),
    );
  return typeof v === "string" || typeof v === "boolean"
    ? v
    : typeof v === "number" && Number.isFinite(v)
      ? v
      : null;
}
export function identity(r: RecordData): Identity {
  return {
    id: r.trader_id,
    name: str(r.username) || str(r.x_handle) || "Fomo trader",
    evmWallet: str(r.evm_wallet),
    solanaWallet: str(r.solana_wallet),
  };
}
export function compatible(s: RecordData): boolean {
  return (
    s.model_version === MODEL_VERSION &&
    s.rule_version === RULE_VERSION &&
    s.analysis_status === "completed" &&
    s.analysis_window_days === 90
  );
}
export function latestCompatible(rows: RecordData[]): RecordData | null {
  return (
    rows
      .filter(compatible)
      .sort(
        (a, b) =>
          (iso(b.computed_at) || "").localeCompare(iso(a.computed_at) || "") ||
          String(a.summary_id).localeCompare(String(b.summary_id)),
      )[0] || null
  );
}
export function classify(summary: RecordData | null): Classification {
  if (!summary || !compatible(summary)) return "known_fomo_analysis_pending";
  const s = summary.price_readiness?.status;
  if (
    [
      "insufficient_behavior_sample",
      "blocked_price_coverage",
      "blocked_price_and_sample_size",
    ].includes(s)
  )
    return s;
  return s === "ready" ? "analyzed_fomo_wallet" : "known_fomo_analysis_pending";
}
const statuses: FindingStatus[] = [
  "validated_positive_edge",
  "validated_risk_pattern",
  "candidate_under_review",
  "observed_behavior",
  "observed_risk",
  "insufficient_evidence",
  "rejected_hypothesis",
];
export function finding(p: RecordData, ready: boolean): Finding {
  let status: FindingStatus = statuses.includes(p.finding_status)
    ? p.finding_status
    : "insufficient_evidence";
  // Unknown/inconsistent validation cannot be promoted by UI or stale model records.
  if (
    status.startsWith("validated_") &&
    (!ready ||
      p.publication?.is_validated_edge !== true ||
      p.pattern_model_version !== MODEL_VERSION ||
      p.rule_version !== RULE_VERSION)
  )
    status = "insufficient_evidence";
  const e = p.historical_evidence || {};
  return {
    id: str(p.key) || "unknown",
    name: str(p.name) || "Finding",
    description: str(p.description) || "",
    status,
    n: count(e.completed_observation_count),
    positions: count(e.independent_position_count),
    tokens: count(e.independent_token_count),
    winRate: decimal(e.win_rate_percent),
    averageReturn: decimal(e.realized_expectancy_pct),
    medianReturn: decimal(e.median_realized_return_pct),
    pnl: decimal(e.realized_pnl_usd),
    health: str(p.validation?.recent_health) || "insufficient_evidence",
    failedChecks: strings(p.failed_checks),
    evidence: json({
      historicalEvidence: e,
      baseline: p.trader_baseline_evidence,
      comparison: p.comparison,
      payoffShape: p.payoff_shape,
      validation: p.validation,
      publication: p.publication,
    }),
  };
}
export function resultDto(
  trader: RecordData,
  s: RecordData,
  run: RecordData | null,
): EdgeResult {
  const e = s.trader_economics || {};
  const readiness = s.price_readiness || {};
  return {
    identity: identity(trader),
    summaryId: s.summary_id,
    modelVersion: s.model_version,
    ruleVersion: s.rule_version,
    analysisVersion: str(run?.analysis_version),
    analyzedAt: iso(s.computed_at),
    windowStart: iso(run?.window_start),
    windowEnd: iso(run?.window_end),
    windowDays: s.analysis_window_days,
    classification: classify(s),
    readiness: {
      status: str(readiness.status) || "unknown",
      failedChecks: strings(readiness.failed_checks),
      evidence: json(readiness),
    },
    economicActions: count(s.economic_action_count),
    closedPositions: count(s.closed_position_count),
    openPositions: count(s.open_position_count),
    findings: (s.pattern_findings || []).map((p: RecordData) =>
      finding(p, readiness.status === "ready"),
    ),
    performance: {
      realizedPnl: decimal(e.realized_pnl_usd),
      unrealizedPnl: decimal(e.unrealized_pnl_usd),
      totalPnl: decimal(e.realized_plus_unrealized_pnl_usd),
      capitalAtStart: decimal(e.starting_portfolio_capital_usd),
      openCostBasis: decimal(e.remaining_open_cost_basis_usd),
      winRate: decimal(e.win_rate_percent),
      averageReturn: decimal(e.average_completed_position_return_pct),
      medianReturn: decimal(e.median_trade_return_pct),
      averageWinner: decimal(e.average_win_pct),
      averageLoser: decimal(e.average_loss_pct),
      payoffRatio: decimal(e.payoff_ratio),
      profitFactor: decimal(e.profit_factor),
      provenance: str(e.provenance?.realized_pnl) || "unavailable",
    },
    exclusions: {
      unattributedDisposals: count(s.opening_inventory_disposal_count),
      partiallyAttributedDisposals: count(
        s.partially_attributed_disposal_count,
      ),
      excludedProceeds: decimal(
        e.sale_proceeds_excluded_for_unknown_inventory_usd,
      ),
    },
  };
}
export function positionDto(p: RecordData): Position | null {
  const closedAt = iso(p.closed_at);
  if (!closedAt) return null;
  const fullyPriced =
    p.buy_count > 0 &&
    p.sell_count > 0 &&
    p.priced_buy_count === p.buy_count &&
    p.priced_sell_count === p.sell_count;
  const pnl = fullyPriced ? decimal(p.realized_pnl_usd) : null;
  // Existing episodes expose whole-episode notionals, not verified FIFO lot cost.
  // A radius must remain unavailable unless an explicit verified cost is persisted.
  return {
    episodeId: p.episode_id,
    chain: p.chain,
    tokenAddress: p.token_address,
    tokenSymbol: str(p.token_symbol),
    openedAt: iso(p.opened_at),
    closedAt,
    realizedPnlUsd: pnl,
    verifiedAcquisitionCostUsd: decimal(p.verified_acquisition_cost_usd),
    returnPct: decimal(p.realized_return_pct),
    pricingStatus:
      pnl !== null
        ? "priced"
        : p.priced_buy_count || p.priced_sell_count
          ? "partial"
          : "unavailable",
    includedInDollarTotals: pnl !== null,
    buyCount: count(p.buy_count) || 0,
    sellCount: count(p.sell_count) || 0,
  };
}
export function storyDto(s: RecordData): Story {
  return {
    id: s.story_id,
    episodeId: s.position_id,
    symbol: str(s.token_symbol) || s.token_address,
    chain: s.chain,
    state: s.position_state,
    narrative: str(s.plain_english_story) || "",
    chapters: (s.chapters || []).map((c: RecordData) => ({
      id: c.chapter_id,
      at: iso(c.occurred_at),
      action: c.action_type,
      description: str(c.what_happened) || "",
      outcome: str(c.actual_progress?.plain_english),
      pattern:
        str(c.primary_supported_pattern?.pattern_name) ||
        str(c.primary_pattern_context?.pattern_name),
      status:
        str(c.primary_supported_pattern?.finding_status) ||
        str(c.primary_pattern_context?.finding_status),
      priorEvidence: json(c.primary_pattern_context?.prior_historical_evidence),
      correction: json(c.correction || c.supersedes_chapter_id),
    })),
  };
}
export function chartPoints(
  positions: Position[],
  width = 800,
  height = 240,
  window?: { start: string; end: string },
) {
  const sorted = [...positions].sort(
    (a, b) =>
      a.closedAt.localeCompare(b.closedAt) ||
      a.episodeId.localeCompare(b.episodeId),
  );
  const times = sorted.map((p) => Date.parse(p.closedAt));
  const min = window ? Date.parse(window.start) : Math.min(...times),
    max = window ? Date.parse(window.end) : Math.max(...times);
  const magnitude = Math.max(
    1,
    ...sorted.map((p) => Math.abs(Number(p.realizedPnlUsd) || 0)),
  );
  return sorted.map((p, i) => ({
    position: p,
    x:
      max === min
        ? width / 2
        : 16 + ((times[i] - min) / (max - min)) * (width - 32),
    y:
      height / 2 -
      ((Number(p.realizedPnlUsd) || 0) / magnitude) * (height / 2 - 20),
    radius:
      p.verifiedAcquisitionCostUsd === null
        ? 6
        : Math.min(
            14,
            Math.max(
              6,
              Math.sqrt(Math.max(0, Number(p.verifiedAcquisitionCostUsd))) / 8,
            ),
          ),
    hollow: !p.includedInDollarTotals,
  }));
}
