# Yieldr V5 Edge Detection

`/edge` starts a new on-demand, 90-day wallet scan. Next.js handles the UI and authenticated job dispatch; the separate Python worker computes the actual V3.3 analysis. Main results are always scan-owned. Top Traders is a separate Mongo-backed module.

## Current documentation

- [Fresh-flow audit and real eyezenhour acceptance](fresh-flow-audit.md)
- [Worker setup, source provenance and Railway configuration](../../services/fomo-edge-analysis/README.md)
- [Source manifest](../../services/fomo-edge-analysis/vendor/manifest.json)
- [Local runbook](runbook.md)
- [Environment variable names](environment.md)
- [Read-only Mongo inventory](mongo-audit.json)

Authoritative source: `/Users/robbin/Documents/ChatGPT/fomo-traders-analysis/fomo-trade-tracer`. The prior audit of the space-named directory was incorrect. The real V3.3 engine and extraction scripts are imported with hashes and matching tests. Model `3.3.0`, rule `2026-09-09.2`, analysis `0.1.0` are taken from source constants.

Routes: `/edge`, `/edge/scan/[scanId]`, `/edge/result/[scanId]`, `/edge/terminal`. APIs: `POST /api/edge/scans`; `GET /api/edge/scans/{id}` and `/result`, `/positions`, `/holdings`, `/stories`; `GET /api/edge/traders/validated`.

The supplied six design references govern the layout. The original Yieldr logo is used. Actual counts, empty/insufficient states, coverage gaps and attribution replace fictional sample results. The landing illustration is explicitly illustrative. Terminal remains a development preview.

The feature is isolated from legacy trading pages/services. No trades or alerts are executed. No secrets are exposed to the browser. The new Railway worker service is configured but not deployed; manually configure its server variables before deployment.
