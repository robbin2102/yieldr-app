# Yieldr V5 QA — 13 October 2026

Final result: **passed for this local implementation**. Production build, 72 Python tests and 17 TypeScript tests passed. The app and worker are running locally; these changes have not been deployed.

## Reference and evidence

Visual reference: `/Users/robbin/Downloads/yieldr-v5-design (1).zip`, extracted to `/tmp/yieldr-v5-reference/yieldr-v5-design/`. X2-Scan, X3-Edge and X4-Terminal PNG/HTML supply the layout, typography, palette and orb. The uploaded Yieldr icon is used unchanged.

Saved evidence directory: `/Users/robbin/.codex/visualizations/2026/10/12/01a13082-66ca-74d3-9221-b82eee662fe3/yieldr-v5-qa/oct13/`.

Final captures: `scan-desktop-final.png`, `result-desktop-final.png`, `result-mobile-final.png`, and `terminal-desktop.png`. Acceptance evidence: `fresh-scan-acceptance.log`, `cached-scan-acceptance.log`, `python-tests.log`, `typescript-tests.log`. Earlier QA history is retained as `design-qa-history.md` in that directory; its earlier source and pipeline blockers are superseded by the current fresh-flow audit.

Desktop viewport requested 1440×1100, export approximately 1432×1094. Mobile requested 390×844, export approximately 382×827. Original PNGs are 2×; the result reference was normalized to 1440px for comparison. Source and rendered pages were inspected together, with readable focused checks of charts and labels. These export differences and real data differences preclude a pixel-identical claim. Temporary viewport overrides were reset.

## Findings and corrections

- Resolved P1: the scan orb stretched into an ellipse because of a flex rule. It is now a fixed 44px animated source orb.
- Resolved P1: the Edge Print showed only central P&L when nothing passed validation. Actual observed patterns now produce faded, explicitly unproven spokes.
- Resolved P2: negative-only patterns left excessive empty chart space and long labels clipped. The view adapts to the actual sign distribution and uses short labels; mobile includes a readable amount legend.
- Resolved P2: oversized scan charts and lengthy evidence pushed progress content down. The scan uses a 150px compact dot chart, short cards and actual stage/action counts.
- Resolved P2: finding heading weights and center value typography drifted from the source. Bold headings and monospaced values are restored.
- Resolved P2: the mobile center sublabel overlapped its value. The final mobile capture verifies separated labels.

No outstanding P0/P1/P2 visual defect was identified in the inspected states. Terminal retains the supplied desktop design inside its preview; full mobile Terminal functionality is not claimed.

## Fidelity and intentional differences

Typography: Manrope UI, Instrument Serif display and JetBrains Mono values. Layout: compact progress, real chronological dots, source-style finding cards, radial result and animated agent dock. Colors: near-black canvas, navy panels, green wins and coral losses. Assets: supplied logo, vector charts and original Terminal HTML/runtime. Copy: short behavior descriptions and position events replace repeated narratives and rejected-validation jargon.

The reference uses illustrative 212-action data and multiple validated patterns. The verified wallet has 79 actions, 17 closed positions (16 priced), and two priced observed patterns. The UI shows this actual evidence, not invented validation or dots. Unconnected live feeds are hidden. The agent is a static preview, and Terminal clearly labels its illustrative data and unavailable functionality.

## Functional acceptance

The submitted Solana wallet `GkppTxihoHLNug82HFRyH4mC1ReECgmf2qu3UxufNM7B` completed all 20 stages in scan `f6d52833ba91cd9a9e3a36fde2e97befe5a04fcc050ec2877934c8563669d12b`. Real holdings and position previews arrived during analysis. No companion EVM wallet was included.

A second browser submission opened the same result directly with `cached=1`. The Mongo log and run are checked for matching wallet, completed generation, scope, engine version and age strictly below 72 hours. Last scan time is visible. A transient cold database connection error recovered on retry; the completed browser submission and final reload succeeded.

All 14 SPL holdings received readable metadata; native SOL is a separate holding. A repeat metadata probe resolved all 14 with zero new provider requests. Tests cover bulk requests, per-token locks, independent metadata/pool/price expiry and negative cache behavior. An existing unique Mongo index mismatch in the background refresh worker was corrected and the restarted queue verified clear.

Four historical open episodes reconcile to two still held and two transferred out, with source ledger evidence. Story titles show coin names and transfer states. Agent preset and typed question paths both display the development message and navigate to the original Terminal preview with its UI-only banner. No trading or agent execution is implied.

Historical OHLC coverage remains partial and no repeatable edge has been validated for this wallet. Those limitations remain visible and are not replaced with fabricated findings. Source analysis files remain unchanged and hash-verified. See `docs/edge-detection/fresh-flow-audit.md` for the data-flow audit.

## Streaming revision — 13 October, final result: passed

Reference animation was inspected in `screens/X2-Scan.dc.html`: its title phases, count, progress track and incrementally populated dots are the target interaction. The source uses illustrative timer-generated data; the implementation uses actual returned activity, pricing totals and completed market windows. X2 PNG was reviewed alongside updated captures. The existing palette, fonts, logo and orb are retained.

Resolved P1: initial history and holdings were silent until whole-chain operations finished. History now streams page results; holdings run across chains in parallel and publish each token batch. Resolved P1: the complete position array arrived in one shot. Verified positions now enter the chart as each token's market history is checked, with a short reveal animation limited to received records. The initial neutral activity chart explicitly distinguishes transactions from verified trades. Total counts are shown only when known. The long pricing phase uses a weighted progress range and active sweep.

Resolved P2: 1,218 tiny holdings dominated this wallet's sidebar. Known values below $10 are hidden with an asterisk note, remaining values are sorted descending, and unknown prices remain visible. Resolved P1: Terminal logo and My edge returned to wallet entry. Both now return to the originating result; banner return and agent-to-Terminal scan identity were also checked in the browser.

Evidence directory: `/Users/robbin/.codex/visualizations/2026/10/12/01a13082-66ca-74d3-9221-b82eee662fe3/yieldr-v5-qa/streaming/`. Captures include `scan-pricing.png` (requested 1440×1000), `scan-mobile.png` (390×844), `scan-dots-early.png`, `scan-dots-later.png`, `scan-completed.png` and `terminal-links.png` (normal desktop viewport). Temporary viewport overrides were reset. Mobile progress text and chart fit without clipping. Final screenshots show 4, 9 and 17 positions respectively; all observed data remains factual rather than matching fictional reference numbers. Unconnected live feed stays hidden as in the accepted preceding implementation.

Final acceptance scan `fbd33cab9164dd484342c46ed24e2c13a7fcdd26edf5f436171cdd0d6d9e986d` completed all 20 stages in 209 seconds. Activity appeared at 6 seconds and coin data at 8 seconds; the full inventory arrived at 51 seconds. There were 154 actions, 17 closed positions (15 priced), 1,241 balances (1,235 priced), and 23 displayed holdings including 6 unpriced tokens. Progressive market-window counts and growing dot arrays were recorded throughout. Optional market refresh does not block completed balance reconciliation. These are observed timings for this run, not a latency guarantee.

Validation: 77 Python tests, 17 TypeScript tests, production build and whitespace checks passed. Added regression tests cover page publication before fetching finishes, new-token bulk metadata yielding balances without redundant RPC calls, independent chain completion, progressive market-window dots, and nonblocking optional price refresh. Vendor source hashes remain unchanged. Final worker log is clean. Local app and worker remain running; no deployment was performed.

## Historical-price diagnostic correction — 13 October

The worker now uses the supported pool OHLCV endpoint, batches Mongo reads/journals and preserves HTTP failure status. Access-denied progress copy explicitly explains cached-history fallback. No visual layout or source assets changed. Browser acceptance verified the corrected wallet scan advanced through historical pricing to Testing against luck with 718 actions and 165 closed positions. Full scan completed in 149.62 seconds; historical pricing took 74.24 seconds. Earlier partial scans using the restricted token endpoint are excluded from cache reuse. Tests: 80 Python, 18 TypeScript and production build passed. Historical coverage remains explicitly partial; no claim of complete price history or a continuous market feed is made. Final result: passed for this local correction.

## Compact Your coins — 13 October, final result: passed

Compared the supplied 2:32:18 AM V5 sidebar reference with the populated completed scan at desktop and 390px mobile widths. Retained navy panel, fine row dividers, small labels, monospaced aligned values and compact spacing. Rows now show identity/value, truncated quantity/holding return, and left-aligned copy address/profit. Removed repeated full names, origin/cost paragraphs and individual timestamps. No trader-flow bars are invented when those feeds are unavailable. Small holdings remain hidden with a single footnote.

Unrealized dollar and percentage returns use the existing remaining cost basis; unknown basis stays an em dash. The current wallet's visible coins have unknown basis, so no returns are fabricated. Exact-decimal quantity truncation and positive/negative/unknown return cases are covered by tests. Address remains visible after copying; copy state was verified in desktop and mobile. No browser console errors. 20 TypeScript tests and production build passed. Captures: `yieldr-v5-qa/compact-coins/desktop.png` and `mobile.png` in the task visualization directory. No remaining P0/P1/P2 issues for this sidebar revision.

## Terminal wide-screen correction — 13 October, final result: passed

The reference X4-Terminal PNG fills its width with three columns in a 380:740:320 ratio. The embedded implementation retained fixed pixel panel widths after its outer canvas became fluid, leaving unused space beyond 1440px. Changed the three panels to proportional flex sizing with content minimum widths. Browser comparison at 1920×1080 confirms the right panel reaches the viewport edge; at 1440×1000 the original proportions remain intact. Existing preview banner and illustrative interactions remain unchanged. Evidence: task visualization `yieldr-v5-qa/terminal-wide.png`. Static HTML style-only correction; no application build required. No remaining P0/P1/P2 findings for the reported wide-screen gap.
