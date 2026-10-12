import test from "node:test";
import assert from "node:assert/strict";
import { Decimal128, ObjectId } from "mongodb";
import {
  walletInput,
  decimal,
  json,
  latestCompatible,
  classify,
  finding,
  positionDto,
  chartPoints,
  storyDto,
  MODEL_VERSION,
  RULE_VERSION,
} from "../../lib/edge/domain";
const summary = (extra = {}) => ({
  summary_id: "s",
  model_version: MODEL_VERSION,
  rule_version: RULE_VERSION,
  analysis_status: "completed",
  analysis_window_days: 90,
  computed_at: "2026-09-09",
  price_readiness: { status: "ready" },
  ...extra,
});
test("wallet validation normalizes EVM but preserves exact Solana case and byte length", () => {
  assert.equal(
    walletInput(" 0xABCDEF1234567890123456789012345678901234 ")?.wallet,
    "0xabcdef1234567890123456789012345678901234",
  );
  assert.equal(
    walletInput("3YonHL3UNTv53MYFxyYAuaUwFjERNTJ8sUrgQS7BHuYq")?.type,
    "solana",
  );
  for (const x of [null, {}, "@name", "0x123", "z".repeat(44), "1".repeat(33)])
    assert.equal(walletInput(x), null);
  assert.equal(walletInput("1".repeat(32))?.type, "solana");
});
test("Decimal128 remains exact and BSON identifiers do not cross the DTO boundary", () => {
  const n = "12345678901234567890.12345678901234";
  assert.equal(decimal(Decimal128.fromString(n)), n);
  assert.deepEqual(
    json({
      _id: new ObjectId(),
      value: Decimal128.fromString(n),
      date: new Date("2026-01-01"),
    }),
    { value: n, date: "2026-01-01T00:00:00.000Z" },
  );
  for (const x of ["NaN", Infinity, "Infinity", "", {}])
    assert.equal(decimal(x), null);
});
test("newer incompatible rules never replace a compatible completed result", () => {
  assert.equal(
    latestCompatible([
      summary({
        summary_id: "new",
        rule_version: "2027-01-01",
        computed_at: "2027-01-01",
      }),
      summary(),
      summary({
        summary_id: "failed",
        analysis_status: "failed",
        computed_at: "2026-10-01",
      }),
    ])?.summary_id,
    "s",
  );
  assert.equal(latestCompatible([summary({ model_version: "3.2.0" })]), null);
});
test("backend readiness states preserved, unknown readiness fails closed", () => {
  for (const status of [
    "insufficient_behavior_sample",
    "blocked_price_coverage",
    "blocked_price_and_sample_size",
  ])
    assert.equal(classify(summary({ price_readiness: { status } })), status);
  assert.equal(classify(summary()), "analyzed_fomo_wallet");
  assert.equal(
    classify(summary({ price_readiness: {} })),
    "known_fomo_analysis_pending",
  );
});
test("validation cannot be inferred from descriptive status or positive returns", () => {
  const p = {
    key: "p",
    finding_status: "validated_positive_edge",
    pattern_model_version: MODEL_VERSION,
    rule_version: RULE_VERSION,
    publication: { is_validated_edge: true },
    historical_evidence: {
      win_rate_percent: 30,
      median_realized_return_pct: -5,
      realized_expectancy_pct: 12,
    },
  };
  assert.equal(finding(p, true).status, "validated_positive_edge");
  assert.equal(finding(p, false).status, "insufficient_evidence");
  assert.equal(
    finding({ ...p, publication: {} }, true).status,
    "insufficient_evidence",
  );
  assert.equal(
    finding({ ...p, finding_status: "observed_behavior" }, true).status,
    "observed_behavior",
  );
});
const episode = (
  id: string,
  close: string,
  pnl: string | null,
  cost: string | null,
) =>
  positionDto({
    episode_id: id,
    chain: "base",
    token_address: "0x1",
    closed_at: close,
    buy_count: 2,
    sell_count: 1,
    priced_buy_count: 2,
    priced_sell_count: 1,
    realized_pnl_usd: pnl,
    verified_acquisition_cost_usd: cost,
  })!;
test("chart chronological order, sign, magnitude, radius clamps, zero and one cases", () => {
  assert.deepEqual(chartPoints([]), []);
  const points = chartPoints([
    episode("b", "2026-08-03", "-20", "100000000"),
    episode("a", "2026-08-01", "10", "1"),
    episode("c", "2026-08-02", null, null),
  ]);
  assert.deepEqual(
    points.map((p) => p.position.episodeId),
    ["a", "c", "b"],
  );
  assert.ok(points[0].x < points[1].x && points[1].x < points[2].x);
  assert.ok(points[0].y < 120 && points[2].y > 120);
  assert.equal(points[1].y, 120);
  assert.equal(points[1].hollow, true);
  assert.equal(points[0].radius, 6);
  assert.equal(points[2].radius, 14);
  assert.equal(120 - points[0].y, (points[2].y - 120) / 2);
  assert.equal(chartPoints([points[0].position])[0].x, 400);
});
test("partial USD pricing is hollow and excluded; legacy buy volume is not verified FIFO cost", () => {
  const p = positionDto({
    episode_id: "x",
    closed_at: "2026-08-01",
    buy_count: 2,
    sell_count: 1,
    priced_buy_count: 1,
    priced_sell_count: 1,
    realized_pnl_usd: "50",
    buy_notional_usd: "100",
  })!;
  assert.equal(p.realizedPnlUsd, null);
  assert.equal(p.includedInDollarTotals, false);
  assert.equal(p.verifiedAcquisitionCostUsd, null);
  assert.equal(p.pricingStatus, "partial");
  assert.equal(positionDto({ closed_at: null }), null);
});
test("story adapter preserves original chapters and correction references without substituting later aggregate evidence", () => {
  const s = storyDto({
    story_id: "s",
    position_id: "p",
    chapters: [
      {
        chapter_id: "original",
        what_happened: "Bought",
        primary_pattern_context: {
          prior_historical_evidence: { completed_purchase_count: 4 },
          current_aggregate_evidence: { completed_purchase_count: 200 },
        },
      },
      {
        chapter_id: "correction",
        supersedes_chapter_id: "original",
        what_happened: "Corrected source",
      },
    ],
  });
  assert.equal(s.chapters.length, 2);
  assert.deepEqual(s.chapters[0].priorEvidence, {
    completed_purchase_count: 4,
  });
  assert.equal(s.chapters[1].correction, "original");
});
test("chart uses full analysis window, not the first and last trades as synthetic bounds", () => {
  const p = episode("x", "2026-07-16T00:00:00Z", "1", null);
  const point = chartPoints([p], 800, 240, {
    start: "2026-07-01T00:00:00Z",
    end: "2026-07-31T00:00:00Z",
  })[0];
  assert.equal(point.x, 400);
});
