# Local Edge Detection runbook

Run the Next.js app and the Python worker together. Mongo provides the durable queue.

1. Install app dependencies and the Python worker's `requirements.txt` in a virtual environment.
2. Run `python run_local.py --source-env '/Users/robbin/Documents/ChatGPT/fomo-traders-analysis/fomo-trade-tracer/.env'` from `services/fomo-edge-analysis`.
3. Ensure ignored app `.env.local` has its Mongo configuration, matching `YIELDR_INTERNAL_SECRET`, `EDGE_ANALYSIS_SERVICE_URL=http://127.0.0.1:8001`, and `EDGE_ALLOW_LOCAL_SERVICE=true`.
4. Build the app with `NODE_OPTIONS=--no-experimental-webstorage npm run build` and start with `NODE_OPTIONS=--no-experimental-webstorage npm run start -- --hostname 127.0.0.1 --port 3100`. Stop any old production server before rebuilding `.next` to avoid stale chunk 404s.
5. Open `/edge` and submit the wallet. Progress reflects completed worker stages. A new submission always creates a new scan.

For real-provider acceptance, enable local `EDGE_ALLOW_FORCE_FRESH=true`, then run `node scripts/edge/check-fresh-api.cjs` from the repo root. It checks the supplied eyezenhour pair, exact V3.3 provenance, fresh window, all 20 stages, own holdings/positions/stories and independent Top Traders. Empty evidence is valid and must remain explicit.

Failed jobs contain a safe failure code, active stage and sanitized diagnostic file/function/line. Never log provider exception bodies or URLs. Interrupted jobs recover after lease expiration, with at most three attempts. Results are not visible until a generation is published completely.

Production worker configuration and manual variable entry are documented in the [worker README](../../services/fomo-edge-analysis/README.md). Railway is configured but not deployed.
