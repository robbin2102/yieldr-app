/** Read-only integration check against the restored environment. Outputs counts, never documents. */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local", quiet: true });
import assert from "node:assert/strict";
async function main() {
  const {
    lookupTrader,
    summaryFor,
    readResult,
    readPositions,
    readHoldings,
    readStories,
    validatedTraders,
  } = await import("../../lib/edge/repository");
  const evm = "0x288c3eadfdbef55ac51fed48272c757a899d5045",
    sol = "3YonHL3UNTv53MYFxyYAuaUwFjERNTJ8sUrgQS7BHuYq";
  const [a, b, unknown] = await Promise.all([
    lookupTrader(evm),
    lookupTrader(sol),
    lookupTrader("0x0000000000000000000000000000000000000000"),
  ]);
  assert.ok(a && b);
  assert.equal(a.trader_id, b.trader_id);
  assert.equal(unknown, null);
  console.log("EVM/Solana identity and unknown wallet: passed");
  const knownSummary = await summaryFor(a.trader_id);
  console.log("Original pilot has compatible summary:", !!knownSummary);
  const top = await validatedTraders(3);
  assert.ok(top.length);
  const summaryId = top[0].summaryId;
  const result = await readResult(summaryId);
  assert.equal(result.modelVersion, "3.3.0");
  assert.equal(result.ruleVersion, "2026-09-09.2");
  console.log(
    "Verified window present:",
    !!result.windowStart,
    !!result.windowEnd,
  );
  assert.ok(result.windowStart && result.windowEnd);
  const [positions, holdings, stories] = await Promise.all([
    readPositions(summaryId),
    readHoldings(summaryId),
    readStories(summaryId),
  ]);
  console.log("Position counts:", positions.length, result.closedPositions);
  assert.equal(positions.length, result.closedPositions);
  assert.ok(stories.items.length);
  assert.ok(top.every((t) => t.validatedCount > 0));
  console.log(
    JSON.stringify({
      result: "passed",
      closedPositions: positions.length,
      storiesPage: stories.items.length,
      holdingsStatus: holdings.status,
      holdingsStale: holdings.stale,
      validatedTraders: top.length,
    }),
  );
}
main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("Live check failed:", e.name, e.code || "");
    process.exit(1);
  });
