# Server environment configuration

Values must never appear in logs, documentation, chat, committed files or `NEXT_PUBLIC_*` variables.

The authoritative analysis checkout's `.env` is used only as a local secret source by `services/fomo-edge-analysis/run_local.py`. It is not copied. The launcher allowlists four Alchemy RPC names plus CoinGecko configuration; it ignores all TARGET wallet defaults. Mongo and internal service authentication prefer the app's existing ignored `.env.local`.

| Variable | Consumer |
|---|---|
| MONGODB_URI, MONGODB_DATABASE | App and worker, same scan database |
| YIELDR_INTERNAL_SECRET | App and worker, matching server-only secret |
| EDGE_ANALYSIS_SERVICE_URL | App, worker HTTPS endpoint; localhost only in development |
| EDGE_ALLOW_LOCAL_SERVICE | App local testing only |
| EDGE_ALLOW_FORCE_FRESH | App local acceptance testing only |
| ALCHEMY_BASE_RPC_URL | Worker Base extraction and balances |
| ALCHEMY_BNB_RPC_URL | Worker BNB extraction and balances |
| ALCHEMY_HOOD_RPC_URL | Worker Robinhood extraction and balances |
| ALCHEMY_SOLANA_RPC_URL | Worker Solana extraction and balances |
| COINGECKO_API_KEY, COINGECKO_API_PLAN | Worker missing candles and current valuation |
| EDGE_MAX_OHLC_CALLS | Optional worker per-scan call budget, default 50 |
| FOMOSCAN_API_KEY | Optional future identity enrichment; not required by the current pipeline |

Railway variables must be entered manually in the new `fomo-edge-analysis` service, never an existing Avantis service. Do not put TARGET_WALLET or TARGET_SOLANA_WALLET in product configuration: every scan derives ownership from the submitted wallet and verified identity.

See the [worker README](../../services/fomo-edge-analysis/README.md) for local startup and deployment steps.
