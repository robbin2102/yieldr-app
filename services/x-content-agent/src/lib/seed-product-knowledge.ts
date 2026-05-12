/**
 * Product Knowledge Seeder — upserts all blocks into MongoDB.
 * Safe to call on every startup (idempotent via upsert).
 */

import { getDB } from './db';

const BLOCKS: Record<string, { content: string; keywords: string[] }> = {
  what_is_yieldr: {
    content: `Yieldr is a platform for trader-defined, agent-operated hedge funds onchain. Traders launch vaults, set their strategy and risk parameters. Agents do 3 things: execute trades within those params, match investors to grow the vault, and manage the vault community.

What Yieldr does:
- For Traders: Launch a vault. Set your strategy and risk limits. Agents execute your trades, find matching investors, and handle all community management — you stay focused on the edge.
- For Investors: Set your target yield. Agents automatically allocate across vaults that fit, monitor continuously, and rotate capital as performance shifts.
- For the Market: A new primitive — traders run strategy, agents run execution and operations, capital flows to verified edge. Trustless, transparent, global.

Website: https://yieldr.org | Docs: https://yieldr.org/docs`,
    keywords: ['what is', 'yieldr', 'platform', 'product', 'explain', 'overview', 'use case'],
  },

  problem_and_solution: {
    content: `Is this copy trading? No. Copy trading just mirrors trades. Yieldr's edge detection layer parses every trade to identify WHY returns happen — entry timing, sizing logic, market selection, holding periods. Agents allocate based on validated edge, not just recent PnL.

How is this different from existing DeFi vaults? A vault is not a fund. Existing vaults (dHEDGE, Enzyme) handle execution — they don't bring in investors, communicate strategy, or allocate across the market. Yieldr's agent stack handles all of that.

Why now? Verifiable trader performance at scale + agents capable of real operational decisions + smart contracts for non-custodial fund structures.

The Problem: Hedge funds locked behind accreditation walls and million-dollar minimums. Millions of traders could run one. Almost none ever will. A vault without agents is just a pool. Yieldr makes it a fund.`,
    keywords: ['problem', 'why', 'different', 'unique', 'compare', 'competitor', 'copy trading', 'copy trade', 'dhedge', 'enzyme', 'why now'],
  },

  vaults: {
    content: `Yieldr vaults are trader-defined, agent-operated funds onchain. Traders set the strategy and risk parameters. Agents execute within those limits — no autonomous trading decisions.

Current state — 3 internal test strategies on Polymarket ($100K project capital):
NBA Edge — ROI: +589.8%
Soccer Alpha — screens traders who beat market prices at p < 0.0001
Geopolitics — ROI: +462.9%

Combined ~300% return in 6 months. Live: https://yieldr.org/vaults

What if a vault loses money? Drawdowns are real. Risk parameters tighten when edge decays, allocation rotates out of underperformers. All performance visible onchain in real time.

Phase 4 expands to perps (Hyperliquid, Avantis) and liquidity (Uniswap, Aerodrome).`,
    keywords: ['vault', 'vaults', 'performance', 'roi', 'return', 'nba', 'soccer', 'geopolit', 'polymarket', 'win rate', 'pnl', 'drawdown', 'trading', 'smart contract', 'non-custodial', 'deposit', 'withdraw'],
  },

  agent_stack: {
    content: `Agents have 3 exact functions in Yieldr:

1. Trade Execution — agents execute trades within the strategy and risk parameters the trader defines. The trader sets the playbook; agents run it. No autonomous decision-making on what to trade.

2. Investor Matching (growth) — agents find and match investors whose target yield and risk profile fit the vault's strategy.

3. Community Management (ops) — agents handle all investor communication: queries, strategy context, performance updates, holding the relationship through drawdowns.

Investor-Side Agents:
- Allocation Agent: learns your target yield and risk tolerance. Allocates capital across vaults that fit, sizes positions, rotates out of underperformers.
- Monitoring Agent: tracks every vault position continuously, flags edge decay, strategy drift, or risk creep before it shows in PnL.

Edge Detection Layer: identifies traders with statistically rare edges — corrected win rate, ROCE, PnL consistency, insider scoring. Distinguishes structural edge from luck.`,
    keywords: ['agent', 'agents', 'ai', 'matching', 'allocation', 'monitoring', 'edge', 'execute', 'strategy', 'automated', 'who trades', 'who runs'],
  },

  early_access: {
    content: `Early Access is invite-only. Tiered from $9M FDV (Genesis) to $34M FDV (Scale). Total raise target: $5M.

How the $50/$50 split works: Every $100 contributed = $50 deposited into an agent-managed vault (NBA Edge, Soccer Alpha, or Geopolitics — your choice) + $50 in YLDR at your tier price. Vault deposits are withdrawable anytime, no lock-up.

Tier prices (first-come, first-served):
GENESIS: $9M FDV, $0.0429/YLDR
PRE-SEED: $12M FDV, $0.0571/YLDR
SEED: $18M FDV, $0.0857/YLDR
GROWTH: $25M FDV, $0.1190/YLDR
SCALE: $34M FDV, $0.1619/YLDR

Invite mechanics: One invite per TG account. Min $100, max $100K. Non-US users only.
Wallet/payment: USDC or USDT on any EVM chain from any EVM wallet.

YLDR token sale goes live June 2026. Get early invite: message @yieldragent_bot on Telegram or join https://t.me/+bKuyducVGqliNGVl`,
    keywords: ['early access', 'invest', 'invite', 'tier', 'genesis', 'presale', 'ico', 'minimum', 'maximum', 'how much', '$100', 'split', 'join', 'participate', 'buy', 'contribute', 'fdv', 'price'],
  },

  tokenomics: {
    content: `YLDR Token — 210M fixed supply, deployed on Base. No private rounds at preferential pricing — retail and institutions allocate at the same price, first come first served.

Timeline: Early Access open NOW. YLDR token sale goes live June 2026. TGE fires T+7 days after $5M raise target is hit. Early invites: @yieldragent_bot on Telegram.

Allocation (210M total):
41% → Public/Community (86.1M)
20% → Team & Contributors — 12-month cliff + 36-month vesting
15% → Treasury & Operations
10% → Strategic Reserve
9% → Ecosystem Incentives
5% → Liquidity Provision

What stops YLDR dumping? Team tokens locked under 12-month cliff + 36-month vesting. No VC allocations with preferential pricing.

Use of funds per $100: $50 → vault deposits, $40 → protocol dev & GTM, $10 → DEX liquidity. DEX listing at TGE. CEX listings are roadmap items.`,
    keywords: ['token', 'yldr', 'supply', 'tokenomics', 'vesting', 'cliff', 'dump', 'tge', 'token sale', 'when is tge', 'when tge', 'sale start', 'claim', 'utility', 'cex', 'exchange', 'list', 'fdv', 'dex', 'listing'],
  },

  roadmap: {
    content: `Yieldr launched Q4 2025.

Phase 1 Live (Q4 2025): Three internal vaults (NBA Edge, Soccer Alpha, Geopolitics) trading project capital on Polymarket.
Phase 2 Now: Capital Raise & TGE — tiered Early Access open, $5M raise target, TGE fires T+7 days after target.
Phase 3 Next (Q4 2026): Marketplace opens — whitelisted external traders launch vaults, allocation + edge detection agents go live. Trader whitelist applications open Q3 2026.
Phase 4 Planned: Multi-protocol expansion into perps (Hyperliquid, Avantis) and liquidity (Uniswap, Aerodrome).
Phase 5 (Vision): Open Marketplace — anyone with verified onchain edge can launch a vault.`,
    keywords: ['roadmap', 'phase', 'when', 'launch', 'launched', 'timeline', 'next', 'expand', 'perps', 'avantis', 'aerodrome', 'marketplace', 'future', 'when did', 'how long'],
  },

  team: {
    content: `Yieldr team:

Robbin Arora — Founder
Ex-KPMG (finance) · Ex-BCG (strategy consulting) · 5+ years onchain trading & dapp building
Built Deed (https://deed-so.vercel.app/) — tokenized Twitch streams & Roblox games on Solana & Base, reached $3M volume
Base Batches 002 Winner (900+ projects globally)
X: https://x.com/robbin_arora | Onchain: defirobbin.base.eth

Manas — Full-Stack Engineer · ex-Zaapi, SureBright
Vipin — Senior Tech Lead · ex-Zendesk

India & US based. 275+ commits, 60K+ lines of code since Oct 2025.`,
    keywords: ['team', 'who', 'founder', 'robbin', 'manas', 'vipin', 'doxxed', 'background', 'experience', 'kpmg', 'bcg', 'deed', 'base batches', 'anonymous'],
  },

  achievements: {
    content: `Yieldr by the numbers — 6 months building in public since October 2025. Full log: https://www.yieldr.org/build-in-public

Recognition:
- Base Batches 002 Winner, Builder Track (February 2026) — 900+ projects
- $10K Base Grant recipient

Vaults and trading:
- NBA Edge vault: +589.8% ROI
- Geopolitics vault: +462.9% ROI
- ~300% combined return across project capital in 6 months

Codebase:
- 62,500+ lines of code
- 275+ commits across 631 files
- 60+ features shipped, 114+ bug fixes

Infrastructure delivered: market intelligence service (20+ indicators, 100 assets tracked hourly), AI Hedge Fund Trader Profiler, MCP Server with 7 live tools, real-time trade monitoring across Avantis/Hyperliquid/Polymarket, 1,500+ tracked wallets.`,
    keywords: ['base batches', 'achievement', 'achieved', 'credentials', 'track record', 'traction', 'milestones', 'progress', 'commits', 'lines of code', 'grant', 'winner', 'roi', 'return', 'performance', 'proof of work', 'build in public'],
  },

  faq_user: {
    content: `Investment FAQs:
- Min $100, max $100K per TG account. One invite — not shareable.
- Every $100 = $50 vault deposit (withdrawable anytime) + $50 YLDR at tier price.
- Choose vault at contribution: NBA Edge, Soccer Alpha, or Geopolitics.
- Non-US users only. Non-accredited investors welcome outside US.
- Pay in USDC or USDT on any EVM chain. Any EVM wallet works. No need to pre-bridge to Base.

Risk: Vaults can have drawdown periods — trading risk is real. Vaults are not insured. Vault contracts are non-custodial — funds sit in the smart contract, not with Yieldr.

Traders: Whitelist applications open Q3 2026 (Phase 3). Express interest in the group now.`,
    keywords: ['minimum', 'maximum', 'how much', '$100', 'non-us', 'us user', 'united states', 'country', 'kyc', 'accredited', 'tax', 'legal', 'wallet', 'metamask', 'usdc', 'usdt', 'pay', 'bridge', 'evm', 'risk', 'insur', 'lose', 'loss', 'withdraw', 'lock', 'redeem', 'drawdown', 'ambassador', 'referral'],
  },

  faq_trust: {
    content: `Trust & verification:
- Vault smart contracts deploy in Phase 3 (Q4 2026). Formal audit planned before Phase 3.
- Today's vaults trade only Yieldr's own $100K project capital — no user funds at risk yet.
- Treasury in Safe multisig: 0xB56C6247F39A992dbcF172a4308386A23d0ea15C — all movements onchain.
- All trades on Polymarket — visible onchain. yieldr.org/vaults pulls directly from onchain.
- Open source: 275+ commits, 60K+ lines of code.
- Is this a security? Yieldr can't give legal/regulatory advice — treatment varies by jurisdiction. US Early Access is not open. Consult a local advisor.`,
    keywords: ['audit', 'secure', 'security', 'rug', 'scam', 'trust', 'multisig', 'treasury', 'verify', 'proof', 'transparency', 'open source', 'regulation', 'is this a security', 'project capital', 'where does'],
  },

  community_and_contact: {
    content: `Connect with Yieldr:
- Telegram community: https://t.me/yieldrdotorg
- Join Yieldr Community (group): https://t.me/+bKuyducVGqliNGVl
- X / Twitter: https://x.com/yieldrdotorg
- GitHub: https://github.com/robbin2102/yieldr-app
- Website: https://yieldr.org | Docs: https://yieldr.org/docs | Live vaults: https://yieldr.org/vaults
- Founder Robbin Arora on X: https://x.com/robbin_arora

Invites go out via Telegram first. Get an invite: message @yieldragent_bot or join https://t.me/+bKuyducVGqliNGVl`,
    keywords: ['community', 'telegram', 'twitter', 'contact', 'support', 'github', 'social', 'links', 'x profile', 'twitter profile', 'project link'],
  },

  trust_and_security: {
    content: `Security at Yieldr:
- Non-custodial smart contracts — investors hold control at all times.
- Deposit and withdraw directly through the contract, no intermediary, no lock-up.
- Build log is public. Treasury in Safe multisig at 0xB56C6247F39A992dbcF172a4308386A23d0ea15C.
- Base Batches 002 Winner (selected from 900+ projects).
- Codebase open source: 275+ commits, 60K+ lines shipped since Oct 2025.
- All current vaults are in testing phase trading project capital only — no external user funds at risk.`,
    keywords: ['audit', 'secure', 'non-custodial', 'custody', 'multisig', 'open source', 'onchain'],
  },
};

export async function seedProductKnowledge(): Promise<void> {
  try {
    const db = await getDB();
    const col = db.collection('product_knowledge');

    let count = 0;
    for (const [key, val] of Object.entries(BLOCKS)) {
      await col.updateOne(
        { _id: key as any },
        {
          $set: {
            content: val.content,
            keywords: val.keywords,
            last_reviewed: new Date('2026-05-09'),
            active: true,
          },
        },
        { upsert: true },
      );
      count++;
    }

    console.log(`[Init] Seeded ${count} product knowledge blocks`);
  } catch (error: any) {
    console.error('[Init] Product knowledge seed failed:', error.message);
  }
}
