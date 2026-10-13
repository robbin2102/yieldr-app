# ⚡ Yieldr

**Invest in the edge, not the trade.**

Yieldr finds out whether an onchain trader actually has an edge or just got lucky. Paste a FOMO wallet and Yieldr breaks the last 90 days of trades into named, repeatable patterns, stress-tests each one, and shows which behaviours made money, which lost it, and the evidence behind every finding.

[Launch Edge Detection](https://app.yieldr.org/edge) · [Website](https://www.yieldr.org) · [Build Log](https://www.yieldr.org/build-in-public) · [X](https://x.com/yieldrdotorg) · [Telegram](https://t.me/yieldrdotorg)

---

## 🏛️ Colosseum Submission: Edge Detection MVP

| | |
| --- | --- |
| **Live app** | [app.yieldr.org/edge](https://app.yieldr.org/edge) |
| **Code to review** | `/edge` (frontend) and `services/fomo-edge-analysis` (pattern detection + validation engine) |
| **Chains** | Solana (main dataset), Base, Robinhood Chain |
| **Integration** | FOMO (live), pump.fun (in progress) |
| **Status** | Edge Detection is live. The Terminal is a labeled UI preview; its data and interactions are illustrative. |

Everything outside those paths is earlier Yieldr infrastructure (see [Earlier work](#-earlier-work)).

---

## 🎯 The Problem

About 95% of meme traders lose money. On FOMO alone, only ~5% of ~429K traders are in profit, and collectively they lost ~$1B in 90 days.

Every trade is public, yet nobody can tell from a PnL number whether a wallet's results come from skill or from one lucky trade. Traders can't see why they win or lose, and anyone who wants to back a good trader is betting blind.

## 💡 How It Works

1. **Read the record.** Rebuild every swap in a wallet's last 90 days and join it to token price history.
2. **Find the patterns.** Group behaviour into named patterns across entry, sizing, exit, timing and restraint, e.g. *High-Conviction Dip Buyer*, *Fast Loss Cutter*, *Peak Capturer*.
3. **Try to kill each one.** A pattern only counts as edge if it survives:
   - removing the single best trade
   - stripping the top 5% of outliers
   - holding out tokens it was never fitted to
   - scoring forward on unseen trades
4. **Show the evidence.** Each validated edge is scored on strength, occurrences, token breadth and luck risk. Early observations stay separate from validated findings.
5. **Flag the leaks.** Risk patterns like *Post-Loss Tilt* and *Overtrading* are detected the same way, so traders see what's costing them.

Read-only: no keys, no approvals.

## 📊 Traction

| Metric | Value |
| --- | --- |
| Trades analysed | 100,542 |
| Wallets analysed | 1,284 |
| Validated edges | 47 |
| Paying Genesis subscribers (pre-launch) | 30 |

## 🗺️ Roadmap

| Stage | What | When |
| --- | --- | --- |
| **Edge Detection** | Find and validate your edge from a FOMO wallet | ✅ Live |
| **Terminal** | Validated patterns of the top holders in each coin, plus insider and side-wallet tracking | ◐ Building |
| **pump.fun** | Edge Detection for pump.fun traders | ◐ Building |
| **Agent Vaults** | Pick proven patterns, launch a vault, an agent runs it and others back it | ○ Q1 2027 |

## 🛠️ Tech Stack

| Component | Technology |
| --- | --- |
| Chains | Solana, Base, Robinhood Chain |
| Onchain data | Alchemy RPC, Chainstack, GeckoTerminal |
| Social data | X API |
| AI | Claude, ChatGPT (pattern explanations, narrative analysis), MCP |
| Agent execution (planned) | Definitive API/MCP |
| Frontend | Next.js, React, Vite, TypeScript, Tailwind CSS |
| Backend | Python, Railway |
| Database | MongoDB, Postgres |
| Hosting | Vercel, Cloudflare |
| Dev tools | Claude Code, Codex, ChatGPT, GitHub |

## 🧱 Earlier Work

Yieldr started in November 2025 with edge-detection agents for prediction markets and perps. That version won the **Base Batches 002 Builder Track**. In August–September 2026 Yieldr went through the **Circuit Accelerator** (Base × Newcampus, Singapore) and moved into meme and alt markets, where most traders actually are.

This repo still contains that earlier infrastructure: Polymarket, Hyperliquid and Avantis integrations, trader analytics, market-data indexers, MCP tools and agent execution services. It's kept for reference and isn't part of this submission.

## 🔨 Building in Public

Built solo, full time, since November 2025. Weekly build logs with real numbers at [yieldr.org/build-in-public](https://www.yieldr.org/build-in-public).

## ⚠️ Disclaimer

Historical evidence, not a forecast or trading recommendation. Nothing here is financial advice or an offer of any security. Agent Vaults are not open to outside deposits. Trading involves substantial risk; past behaviour does not guarantee future results.

## 📜 License

MIT. See [LICENSE](LICENSE).
