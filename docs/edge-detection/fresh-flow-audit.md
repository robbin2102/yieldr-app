# Fresh Edge Detection V3.3 audit

The authoritative source is `/Users/robbin/Documents/ChatGPT/fomo-traders-analysis/fomo-trade-tracer`. The prior space-named source audit was wrong and is superseded. All three extraction dependencies and the real V3.3 economics, pattern and story engines exist. The source checkout is read-only.

## Architecture

Each wallet submission creates a random scan ID and a 90-day window ending at submission. It dispatches an authenticated job to the separate Python worker. All twenty progress stages represent completed work. Inputs may reuse immutable transaction evidence or Mongo candles, but the normalized trades, features, V3.3 outputs, assessments and stories are recomputed.

The worker composes reusable source operations instead of invoking a runner that requires prepared files. It performs atomic USD enrichment, source external-flow classification and FIFO accounting. Portfolio results retain unknown acquisition cost and price gaps. Existing Top Traders summaries are not candidates for a main wallet result.

Outputs are keyed by scan ID, normalized wallet and worker generation. The generation becomes readable only after ownership/window validation and complete persistence. Leases recover interrupted jobs with bounded attempts. Source versions, per-file hashes, fixed window and computation time are persisted; exact source versions are model `3.3.0`, rule `2026-09-09.2`, analysis `0.1.0`.

## Source import and verification

`services/fomo-edge-analysis/vendor/manifest.json` contains 50 explicitly selected Python files: production operation import closure plus matching test dependencies. No source `.env`, raw output or unrelated cohort export was copied. All copied files remain byte-identical to the authoritative source.

- 37 imported source tests passed.
- 26 service tests passed, including source hash integrity, V3.3 FIFO outcomes, receipt enrichment, Solana batch parsing, own-wallet holdings, secret allowlisting, cross-wallet rejection and cache idempotency.
- 16 TypeScript tests passed. TypeScript check passed.

## Live eyezenhour evidence

The current-window scan resolves the exact supplied pair:

- EVM `0x085d22d9d77ac81ee8fa3472aa45a6e51676a9a0`
- Solana `2w8StCWiNWvvqxcir3FmVzrG6Y4iHBT4bRp6eN814gJd`

The first V3.3 live run completed all twenty stages. Provider evidence contained 629 BNB transfers and 32 Robinhood transfers, all incoming and none matching the authoritative Fomo settlement classifier. Base returned no transfers in this window. An independent Solana `getSignaturesForAddress` check returned no signatures. RPC chain IDs were verified.

Consequently this pair produced **0 verified trade legs, 0 economic actions, 0 closed positions**, and `insufficient_behavior_sample`. Two live wallet holdings were returned. This proves fresh execution and ownership; it does not prove non-empty extraction for this particular wallet or that the account has no trading activity elsewhere. No positions or validated patterns were invented or borrowed. A known onchain Fomo transaction from this pair would be needed to investigate any mismatch with activity visible in the Fomo UI.

## Current boundaries

Transfer-contaminated tokens remain excluded from pattern dollar claims because the source episode/action model is trade-only; source portfolio accounting separately handles external adjustments. Candle backfill requests only missing contiguous spans, defaults to 50 calls per scan and explicitly reports remaining gaps. Current valuations occur after the trade cutoff. EVM native gas balances are outside the source portfolio adapter. The known source Fomo UI extraction coverage gap remains a development issue; this migration does not claim complete UI reconciliation.

Railway service `fomo-edge-analysis` was created and configured with root `/services/fomo-edge-analysis`, its own worker start command and `/health`. It has no deployment. Provider/Mongo/internal-auth variables must be entered manually in that service's Variables tab. No other Railway service was altered.

Final force-fresh acceptance: scan `0a9910c6a5aa4f5a433aae1f4b7c24f836bda84e7813aaa667c43eff2d21b634`, window `2026-07-14T17:32:39.276Z`–`2026-10-12T17:32:39.276Z`, all 20 stages complete. Real-provider API assertions passed, including separate Top Traders. Full application build passed. No secret-value matches were found in the feature files.

## Solana metadata cache correction

A scan for `GkppTxihoHLNug82HFRyH4mC1ReECgmf2qu3UxufNM7B` fetched 227 activity records but failed during extraction with a PyMongo BSON integer overflow. JSON-RPC unsigned integers can exceed BSON's signed int64 range (notably Solana account metadata). The adapter now stores out-of-range RPC integers losslessly using a dedicated BSON binary subtype and restores Python integers on cache reads. The source engine is unchanged. Regression coverage exercises real BSON encoding and extraction metadata cache reuse, including `2**64-1` and nested large integers. A missing linked EVM identity is partial coverage, not this failure's cause.

Live recovery passed: scan `fb676f3d8e39e607986c44f45bf4335cd1b4d1a2e71dd45a01c91d4e49a984f2` completed all 20 stages with 227 activity records, 79 atomically priced trade legs/economic actions, 17 closed positions (16 included in dollar totals), 4 open episodes and 15 live holdings. All output endpoint ownership assertions passed, and the browser displayed the correct wallet, positions and holdings. Three cached metadata responses contained oversized `.value.rentEpoch` values, confirming the failing field. Price coverage remains partial after the configured 50-call backfill budget; the sample remains insufficient for validated-edge claims. All 66 Python tests pass, including three new integer/cache regressions.

## October 13: three-day reuse and token enrichment

The latest user request supersedes the earlier always-recompute policy. A submitted wallet now looks up `fomo_analysis_edge_analysis_logs` first. Reuse requires age strictly below 72 hours, current model/rule/cache revision, submitted-only scope, a completed scan and the exact committed output generation. The original analysis timestamp/window are preserved. No other trader summary or linked-chain wallet is substituted.

Live acceptance: `f6d52833ba91cd9a9e3a36fde2e97befe5a04fcc050ec2877934c8563669d12b` completed 79 Solana actions, 17 closed episodes and four historically open episodes. The next POST returned the same ID with `cached: true`. The running scan exposed 15 holdings before extraction completed and 17 position dots before OHLC/pattern checks finished. The log and bounded outputs/evidence are persisted.

All 14 SPL holdings resolved to names/symbols in `fomo_analysis_tokens`; native SOL is separate. A repeat real-token cache probe returned 14/14 names with zero provider requests. Tests cover a single 14-token batch, 30-token boundaries, independent TTLs, negative/error caches and per-token locks. Current price retrieval is independent of historical candle backfill and cannot alter historical analysis figures.

Open-episode reconciliation uses canonical chain+mint. KABUTSTR and ENTROPY still have current balances. The inventory audit confirms POKEMON transferred out 8,572,141.384131 tokens and blast transferred out 11,496,126.035238 tokens, leaving zero known/unknown inventory. These are transfers, not realized sale profit. The new scan's holdings and analysis log record `transferred_out` for both.

UI changes retain observed labels, actual N values, timestamped balances/prices and the original analysis scope. The rejected-validation wall is hidden from the product UI; full engine evidence remains in Mongo. The agent only opens a clearly labeled Terminal preview using the supplied V5 Terminal source. No AI job or trading action is executed. Earlier source findings and historical limits above remain audit history, not current cache/scope behavior.

## Incremental progress and large-wallet holdings — 13 October

The reported EVM wallet (`0x3db7aa3c32bfe723e6818787c5da74a543abe2eb`) has 1,241 ERC-20 balances, explaining why serial metadata work delayed the initial experience. History now emits 100-row page progress across concurrent chains. Separate concurrent holdings workers publish each available chain and each <=30-token market batch. Known decimals come from Mongo; unknown coins get bulk CoinGecko metadata/prices before RPC metadata fallback. Only verified priced holdings below $10 are hidden in the UI; unpriced holdings remain explicit.

Final live acceptance scan: `fbd33cab9164dd484342c46ed24e2c13a7fcdd26edf5f436171cdd0d6d9e986d`. Initial activity appeared at 6 seconds (83 transactions), and 37 balances at 8 seconds (34 priced). All 1,241 balances were available at 51 seconds, with 1,218 below $10 hidden. These are measured timings for this wallet and environment, not latency guarantees. Market-history progress publishes completed/total checks and releases position dots by token as checks finish, rather than one FIFO-sized burst. Outcome colors are not assigned to unclassified activity.

Trade counts and price-history counts have distinct labels. The upstream provider does not supply a total while history is being paged; that phase shows the actual fetched count and an active indicator. Known totals appear during pricing and later checks. Optional price refresh no longer delays completed inventory reconciliation. Terminal keeps the scan ID through agent preview navigation, and its logo/My edge/banner links return to that result.

## Historical-price bottleneck — AUYLj5k…uLLQv

The original scan `5b822602fd17adba79c28a465403bfcf502e98d118fbffe26049eeb4206c3bad` ran from 20:47:11 to 21:01:08 UTC (about 14 minutes). The historical-price stage alone ran from 20:49:55 to 21:00:38 UTC (about 10m43s). It processed 717 trade legs, 164 closed episodes, 174 traded tokens and 272 required history windows. Current holdings were separate: 35 balances, 34 valued.

A controlled request with the configured Pro-mode key reproduced HTTP 401 on the token OHLCV endpoint: the provider requires Analyst plan or above for that endpoint. All 50 attempts during the scan were journaled only as `provider_unavailable`; none produced new Edge candles. The scan still used 18,518 pre-existing candles from the legacy price collection. Mongo reads measured approximately 0.305 seconds each. Sequential per-window reads, gap-job writes/reads and twice-per-window preview writes therefore dominated even after the 50-call budget was spent.

The pool OHLCV endpoint returned HTTP 200 with the same key. The corrected adapter uses that supported endpoint with an explicit token address (base/quote identity is never guessed). It batches exact-window Mongo reads, preloads job/pool metadata, batches job journals and throttles market preview writes. Compound indexes support candle and job lookup. HTTP status codes and access-blocked diagnostics are retained without credentials; 401/403 opens a circuit instead of repeating 50 times. Old token-endpoint partial scans are not eligible for the three-day cache.

Live adapter acceptance on one of this wallet's failed ranges persisted 43 provider-native candles in 4.34 seconds. Repeating that range returned those same 43 candles in 2.16 seconds with zero new API calls. The range remained honestly partial (58 absent intervals); sparse provider responses are not interpolated. Recent successful range coverage prevents repeated requests for its empty subranges.

Architecture clarification: wallet spot prices and token metadata are cached/refreshed by backend workers during scans and through deduplicated refresh jobs. Historical OHLCV is an on-demand backfill during analysis. Pending candle jobs are a journal, not an independently running continuous candle indexer. No real-time market websocket feed is claimed.

Full corrected scan `6619f289f36763c8d47e38f3765d50cd6c42cb1731b2cf99dfe8003abbe618cc` completed in 149.62 seconds (156 seconds including submission/poll overhead). Historical pricing took 74.24 seconds instead of 642.64 seconds. Its 50 pool-history requests produced no provider errors. The Edge candle collection reached 3,652 persisted rows; the analysis used 22,170 total cached/fetched candles. Coverage remains partial: 27,519 absent intervals across 251 windows, with the 50-call budget reached. This budget is explicit rather than silently interpreted as complete coverage.

The live wallet changed between submissions: the corrected scan has 718 actions, 165 closed positions (153 priced), 4 open episodes, and 34 current holdings (33 priced). It remains submitted-wallet-only. The unaffected analytical source and thresholds were not modified. Validation: 80 Python tests, 18 TypeScript tests, production build, actual successful persistence/reuse probe and full live scan passed.

## Bounded parallel historical backfill

Replaced sequential missing-candle network requests with a rolling pool of up to four in flight, following a single access probe. All attempts share the existing source client's one-second request-start limiter. Cache-first planning, unique job IDs, sparse-response cooldown and the 50-job cap are retained. Only the coordinator merges prices, persists candles and publishes progress. Request-local exception status avoids cross-thread metric attribution. Access denial stops refilling the pool; already in-flight work is drained.

Validation: 82 worker/vendor tests passed, including a barrier test proving simultaneous requests, budget reservation and duplicate suppression, repeat-scan zero-call cache reuse, initial and mid-flight access-denial behavior, and source hash integrity. No paid acceptance scan was triggered for this change. Actual production speedup remains workload-dependent; no new end-to-end timing is claimed.
