# Fresh Fomo Edge Analysis worker

FastAPI acknowledges durable Mongo scan jobs. One leased worker performs fresh, wallet-owned V3.3 analysis; Next.js never performs the long computation. Existing trader summaries are used only by the separate Top Traders module.

## Source and provenance

Authoritative read-only checkout: `/Users/robbin/Documents/ChatGPT/fomo-traders-analysis/fomo-trade-tracer` (hyphenated parent).

The earlier space-named checkout was incomplete and has been superseded. `vendor/manifest.json` records the exact recursive Python dependency closure, SHA-256 hashes, extraction dependencies, matching test files and migration time. No environment file, output artifacts, caches or credentials were imported. V3.3 intentionally imports older shared pattern specifications; its actual entry point is `run_v3_3_pattern_engine`, not the V3.2 engine.

Source constants: model `3.3.0`, rule `2026-09-09.2`, analysis `0.1.0`. Every scan and result records these versions, source hashes, submission-frozen window and computation timestamp. Vendored source files are unmodified; adapters live outside `vendor/`.

## Fresh execution

The worker resolves the exact submitted wallet only (never automatically adds a companion wallet); fetches or incrementally refreshes 90-day EVM transfers and Solana transactions; runs the source settlement/delta parsers; enriches every leg using atomic receipt/quote USD evidence; normalizes and deduplicates; classifies external inventory; replays FIFO and reconstructs episodes; loads Mongo candles and backfills only contiguous missing windows; builds behavioral and price features; runs V3.3 attribution, patterns, assessments and stories; queries live RPC balances and available current prices; builds source FIFO/P&L reporting; then publishes scan-owned output by an atomic generation pointer.

Raw evidence and immutable receipts may be cached. Compatible completed derived analyses are reused for strictly less than 72 hours by Next.js before a job is created. Incompatible, expired, failed or incomplete runs are never reused. A cached range advances only after its complete provider fetch succeeds. The five-minute overlap repairs delayed indexing. `forceFresh` repeats analysis and refreshes the delta; it does not discard immutable evidence.

Pattern gates remain those of V3.3. Transfer-contaminated or unknown-cost token economics are conservatively withheld from pattern validation because the source action/episode engines are trade-only; the portfolio reporter separately includes source inventory adjustments. No unknown receipt becomes zero-cost profit. Missing prices are not interpolated. Five-minute candles must be provider-native and complete at the scan endpoint. Default OHLC backfill budget is 50 requests per scan (`EDGE_MAX_OHLC_CALLS`); remaining gaps and budget exhaustion are explicit. Native SOL balances are included; EVM native gas balances are not yet in the source portfolio adapter. Live holdings valuation occurs after the frozen trade cutoff and discloses both times.

## Local launch

Use a virtual environment and install `requirements.txt`; test dependencies are `pytest`, `mongomock`, and `httpx`.

From this directory:

```sh
python run_local.py --source-env '/Users/robbin/Documents/ChatGPT/fomo-traders-analysis/fomo-trade-tracer/.env'
```

The launcher reads only required server variable names in memory. RPC/CoinGecko configuration comes from that local source; Mongo and the internal shared secret prefer the app's ignored `.env.local`, so the worker consumes the same queue as Next.js. TARGET wallet variables are deliberately unused. No credentials are copied or printed.

Next.js local variables: `EDGE_ANALYSIS_SERVICE_URL=http://127.0.0.1:8001`, `EDGE_ALLOW_LOCAL_SERVICE=true`, and the matching `YIELDR_INTERNAL_SECRET`. Optional local-only `EDGE_ALLOW_FORCE_FRESH=true` enables the acceptance test. Start Next.js on port 3100. With Node 25, use `NODE_OPTIONS=--no-experimental-webstorage` for the existing app build/start.

## Railway

A separate empty service named `fomo-edge-analysis` has been created in project `yieldr-app`, production environment. Root is `/services/fomo-edge-analysis`; start command is `uvicorn main:app --host 0.0.0.0 --port $PORT --workers 1`; health check is `/health`. No deployment or secrets were uploaded. No existing Avantis or other service was changed.

Manually enter these server variables in **this new service's Variables tab**:

- `ALCHEMY_BASE_RPC_URL`, `ALCHEMY_BNB_RPC_URL`, `ALCHEMY_HOOD_RPC_URL`, `ALCHEMY_SOLANA_RPC_URL`
- `COINGECKO_API_KEY`, `COINGECKO_API_PLAN`
- `MONGODB_URI`, `MONGODB_DATABASE` (the same queue database used by the app)
- `YIELDR_INTERNAL_SECRET` (match Vercel's server secret)

`FOMOSCAN_API_KEY` is optional for future identity enrichment; current scans use the verified Mongo wallet mapping and direct RPC holdings. `TARGET_WALLET` / `TARGET_SOLANA_WALLET` are not service configuration. Never use `NEXT_PUBLIC_*` for any of these.

After code and variables are ready, deploy this directory as its own service. Set Vercel's server-side `EDGE_ANALYSIS_SERVICE_URL` to its HTTPS endpoint. Production must not enable local-service or development force-fresh flags.

## Checks

```sh
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=vendor python -m pytest vendor/tests -q
PYTHONDONTWRITEBYTECODE=1 python -m pytest tests -q
```

From the repository root: `node --import tsx --test tests/edge/*.test.ts`, `node scripts/edge/check-fresh-api.cjs` (local real-provider integration).

The eyezenhour acceptance scan completes with only its submitted wallet, independent source hashes, a current 90-day window, own holdings and insufficient evidence when no verified Fomo trades exist. An empty result is not replaced with a top trader. See `docs/edge-detection/fresh-flow-audit.md` for observed live counts and limitations.

## Scan reuse and coin cache (October 13 update)

`fomo_analysis_edge_analysis_logs` stores completed analysis identity, scope, versions, window, stats, findings, holdings/reconciliation, and generation-owned output/evidence references. It is retained as history, not deleted after three days. Cache revision `submitted-wallet-v2` excludes earlier auto-linked scans. Final publication still requires a committed generation and exact wallet ownership.

`fomo_analysis_tokens` holds names, symbols, images, decimals, current price timestamps and top-pool information. Metadata TTL is 30 days; pool TTL 24 hours; price TTL 5 minutes; missing-token TTL 24 hours; provider error backoff 30 minutes. Mongo per-token leases deduplicate concurrent requests, batches contain at most 30 tokens. Native SOL balances remain separate from wrapped-token balances; the wrapped-SOL mint supplies the quote, never literal `SOL` pool discovery.

Holdings are read concurrently with transaction extraction. The scan publishes cached/enriched holdings and completed-position previews before OHLC/pattern checks finish. Final outputs remain fenced to the worker generation. A separate metadata worker consumes `fomo_analysis_edge_metadata_jobs` for completed pages; these jobs expire after one day. Refreshing names/prices does not repeat the wallet analysis or reinterpret the saved holdings quantity as a fresh balance. Prices and balance snapshots have separate visible timestamps.

The live Solana check completed 79 actions and 17 closed positions. All 14 SPL names resolved, and resubmission reused the same scan ID. Of four historically open Fomo episodes, KABUTSTR and ENTROPY remain held; blast and POKEMON were fully transferred out according to inventory evidence.

Metadata-only requests for historical position/story coins do not refresh their prices every five minutes. Only currently held coins use that short price TTL; historical coin names and pool records use the longer TTLs. This keeps routine page refreshes to the minimum holdings batch.

### Incremental scan progress (13 October)

History is fetched concurrently across supported chains and published after each 100-row page. Pending activity dots stay neutral until trading outcomes are verified. Extraction publishes actual priced-leg/receipt counts; the market-history pass releases position dots per checked token and reports its completed/total windows. Counters reveal only data already returned, and fetching shows an active sweep while the upstream total is unknown.

Holdings queries run concurrently with history and with each other. EVM balances reuse Mongo decimals; new tokens use <=30-address CoinGecko batches for decimals, names and prices, with batched RPC metadata only for unsupported tokens. Every market batch updates the preview. Completed balance inventory is joined to accounting without waiting for optional market-price refreshes; token refreshes continue in the background. UI hides known values below $10, sorts remaining balances by value, and retains unpriced balances.

Terminal receives the originating scan ID; its logo, My edge navigation and banner return link lead back to that result.

Historical OHLCV now uses the pool endpoint with the requested token explicitly specified. The token-address OHLCV endpoint was rejected by the existing account (HTTP 401) despite working token metadata requests. History reads and job journals are batched; preview writes are throttled; HTTP errors and access-blocked flags remain in coverage diagnostics. Historical candles are persisted as each successful response arrives. The 50-call budget and missing-data exclusions remain enforced. This is on-demand backfill, not a continuous OHLCV daemon.

### Bounded historical-price concurrency

Historical pool requests now overlap up to four network waits (`EDGE_OHLC_CONCURRENCY`, clamped to 1–4; default 4). A single shared CoinGecko client retains its one-second request-start limiter, including retries. The first request probes access before fan-out; a 401/403 stops scheduling more work and drains the bounded in-flight set. Error status comes from the request's own exception rather than another thread's shared metrics.

Cache coverage, sparse-response cooldowns and duplicate job IDs are checked before reserving the existing `EDGE_MAX_OHLC_CALLS` budget (default 50). Scheduling does not raise that budget or lower the rate interval. Candle persistence and preview updates remain on the coordinator thread, with progress advancing as each token's scheduled work finishes. Setting concurrency to 1 restores sequential operation. No new production variables are required. A full 50-request backfill still needs roughly 50 seconds of request spacing; the improvement overlaps response latency and database writes rather than promising instant cold scans.
