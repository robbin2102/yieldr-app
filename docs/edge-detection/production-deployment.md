# Edge MVP production deployment

Public entry: **https://app.yieldr.org/edge**. Keep the landing site in the `yieldr` project and the app in `yieldr-app`. The landing site's “Find your edge” CTA should link to that URL, never a localhost or scan-specific result URL.

## 1. Railway worker first

Use the existing **yieldr-app → production → fomo-edge-analysis** service. Connect `robbin2102/yieldr-app`, branch `main`, root directory `/services/fomo-edge-analysis`. If selecting a config file from the repository root, its path is `/services/fomo-edge-analysis/railway.toml`. The service uses the Dockerfile in its root; start command is `uvicorn main:app --host 0.0.0.0 --port $PORT --workers 1`, health path `/health`. Keep one replica for the MVP.

Set private service variables:

- `MONGODB_URI` and `MONGODB_DATABASE=yieldr`, matching Vercel.
- `YIELDR_INTERNAL_SECRET`, matching Vercel; use a strong random server secret.
- `ALCHEMY_BASE_RPC_URL`, `ALCHEMY_BNB_RPC_URL`, `ALCHEMY_HOOD_RPC_URL`, `ALCHEMY_SOLANA_RPC_URL`.
- `COINGECKO_API_KEY`, `COINGECKO_API_PLAN` matching the paid account.

Use the existing private configuration sources; never commit `.env.local` or expose these as `NEXT_PUBLIC_*`. Deploy the worker and generate an HTTPS domain under Railway Networking. Verify `/health` succeeds and logs show the worker running. Historical-price backfill defaults to 50 calls per scan; missing coverage stays explicitly marked.

## 2. Existing Vercel app

Use the existing `yieldr-app` Vercel project connected to this repository, production branch `main`, repository root, Next.js framework, normal npm install/build. Preserve the existing app's other variables. Use a supported Node LTS runtime (22.x), not the local Node 25 workaround.

Set Production server variables:

- `MONGODB_URI`, `MONGODB_DATABASE=yieldr`.
- `YIELDR_INTERNAL_SECRET`, exactly matching Railway.
- `EDGE_ANALYSIS_SERVICE_URL=https://<generated-worker-domain>` (base URL only).

Remove `EDGE_ALLOW_LOCAL_SERVICE` and `EDGE_ALLOW_FORCE_FRESH` from Production. Redeploy after changing environment variables. Vercel serves the UI and short API requests; Railway runs the long analysis and metadata jobs.

## 3. Domain and landing CTA

In Vercel → yieldr-app → Settings → Domains, add `app.yieldr.org` if not already assigned. At the DNS provider, add the exact record Vercel requests and wait for verification/TLS. No path rewrite is required: `/edge` is a real application route.

In the separate `yieldr` landing repository, set every “Find your edge” CTA href to `https://app.yieldr.org/edge`, then deploy that landing project after acceptance succeeds. This change is not included in the app repository.

Alternative: attach `edge.yieldr.org` to the same app, then add a host-specific redirect from `/` to `/edge`. Avoid changing the app's root globally, since other app journeys use it. The app subdomain is simpler for this release.

## 4. Acceptance before promoting the CTA

Open the production `/edge`, submit a wallet, verify progress, holdings and final result. Resubmit it and confirm the compatible completed scan is reused with its timestamp. Confirm Terminal is clearly marked as a UI preview and links back to the result. Check Railway logs for provider/auth errors and that Vercel calls the HTTPS worker successfully. The AI terminal and live trader feed are MVP previews, not live execution features.

References: https://vercel.com/docs/domains/set-up-custom-domain and https://docs.railway.com/deployments/monorepo.
