/**
 * Product Documentation Sections
 *
 * Structured reference content for the "Project Primer" daily educational posts.
 * The AI content agent rotates through one section per day (7 sections = weekly cycle).
 * Each section contains enough detail for an LLM to write a compelling, factual post.
 */

export interface DocSection {
  id: number;
  title: string;
  topic: string;
  keyPoints: string[];
  hook: string;
}

export const DOC_SECTIONS: DocSection[] = [
  {
    id: 1,
    title: 'What is Yieldr',
    topic: 'Platform overview — what Yieldr is and how it works',
    keyPoints: [
      'Yieldr is the platform for AI-native hedge funds onchain — not another DeFi vault wrapper, but a full fund infrastructure layer.',
      'Top traders launch vaults, and an AI agent stack runs the fund operations around them: investor matching, communication, allocation, monitoring.',
      'Investors deploy capital into vaults; agents manage the portfolio lifecycle from entry to exit.',
      'Every part of fund operations that doesn\'t require a human decision is handled by the agent stack — comms, rebalancing, risk monitoring, reporting.',
      'Currently live with 3 vaults trading on Polymarket: NBA Edge (basketball markets), Soccer Alpha (football/soccer markets), and Geopolitics (political and geopolitical event markets).',
      'The core thesis: a trader with edge shouldn\'t need a back office, a compliance team, and $10M in seed capital to run a fund. They need a vault and an agent stack.',
    ],
    hook: 'What if every profitable trader could run a hedge fund — without hiring a single person?',
  },
  {
    id: 2,
    title: 'The Problem',
    topic: 'Why the current hedge fund and DeFi vault landscape is broken',
    keyPoints: [
      'The hedge fund structure is 70 years old. Still locked behind accreditation walls, million-dollar minimums, and 2-and-20 fee models built for a pre-internet era.',
      'The world has roughly 10,000 hedge funds. Meanwhile, millions of traders with demonstrable edge will never run one because the operational overhead is prohibitive.',
      'DeFi vaults exist but a vault is not a fund — there\'s no investor matching, no communication layer, no retention mechanism, no drawdown management.',
      'Investors can\'t allocate across vaults at scale. There\'s no system for continuous allocation against risk-return targets — it\'s all manual, one vault at a time.',
      'Edge stays opaque: PnL is visible onchain but strategy isn\'t. Capital chases recent performance instead of understanding why a trader wins.',
      'The result: a massive supply-demand mismatch. Skilled traders can\'t attract capital efficiently, and investors can\'t find or evaluate them systematically.',
    ],
    hook: 'There are 10,000 hedge funds in the world. There should be a million. Here\'s what\'s stopping that.',
  },
  {
    id: 3,
    title: 'The Solution',
    topic: 'How Yieldr\'s agent stack solves the fund operations bottleneck',
    keyPoints: [
      'Yieldr\'s agent stack turns every top trader into a fund manager and every investor into a professional allocator — without either needing a team.',
      'Trader-side agents handle investor matching by risk profile, ongoing communication, and expectation management through drawdown periods. The trader focuses on trading.',
      'Investor-side agents understand each investor\'s risk-return goals, continuously allocate capital across vaults, rotate out underperformers, and rebalance portfolios.',
      'Edge detection agents go beyond surface-level PnL to analyze why a trader wins: entry patterns, position sizing logic, market selection tendencies, and timing.',
      'The full stack dissolves the operational constraint that historically required 20-50 employees to run a fund — replaced by agents that run 24/7 at marginal cost.',
      'This isn\'t automation of an old process. It\'s a new primitive: the AI-native fund, where the trader supplies edge and the agents supply everything else.',
    ],
    hook: 'A hedge fund needs ~40 people to operate. What if it needed zero — just one trader and an AI stack?',
  },
  {
    id: 4,
    title: 'Vaults & Agent Stack',
    topic: 'Technical architecture — vaults, smart contracts, and the agent layers',
    keyPoints: [
      'A Yieldr vault is a smart contract that holds investor capital, executes the trader\'s strategy onchain, and publishes real-time performance data.',
      'Vaults are non-custodial: investors deposit, withdraw, and track PnL directly through the contract. No counterparty risk from the platform.',
      'The agent stack has three layers: Trader-side (Matching Agent + Community Agent), Investor-side (Allocation Agent + Monitoring Agent), and Edge Detection (Trade Parsing Agent + Validation Agent).',
      'Trader-side Matching Agent pairs new investors with vaults that fit their risk tolerance. Community Agent handles investor updates, drawdown comms, and retention.',
      'Investor-side Allocation Agent deploys capital across multiple vaults to hit target risk-return profiles. Monitoring Agent tracks drift, flags underperformance, triggers rebalances.',
      'Edge Detection layer parses every trade to extract patterns — not just who wins, but entry timing, sizing relative to conviction, market selection bias, and consistency.',
      'Currently live with 3 vaults trading Yieldr project capital on Polymarket to stress-test and prove the agent stack before opening to external capital.',
    ],
    hook: 'Most DeFi "vaults" are just smart contracts with a deposit button. Here\'s what a real onchain fund looks like.',
  },
  {
    id: 5,
    title: 'Vision',
    topic: 'The long-term vision — a million AI-native hedge funds onchain',
    keyPoints: [
      'Yieldr\'s endgame: a million AI-native hedge funds operating onchain, each run by a trader with verified edge and a full agent stack.',
      'Agents handle investor matching, communication, allocation, and monitoring — dissolving the operational constraint that capped the world at 10,000 funds.',
      'A trader in Seoul, São Paulo, or Lagos with verified edge can launch a fund as easily as deploying a smart contract. Geography and credentials stop being gatekeepers.',
      'This creates an entirely new asset management market: open to anyone with skill, agent-operated at the infrastructure layer, performance-driven with full transparency, and onchain by default.',
      'The shift is from "funds as institutions" to "funds as software" — lightweight, composable, globally accessible, and running continuously without human operational overhead.',
      'Prediction markets (Polymarket) are the proving ground. The vision extends to perps, spot, liquidity provision, and any onchain strategy with measurable edge.',
    ],
    hook: 'The world doesn\'t need another DeFi protocol. It needs a new kind of fund — one that runs itself.',
  },
  {
    id: 6,
    title: 'Roadmap',
    topic: 'Phased rollout from internal vaults to open marketplace',
    keyPoints: [
      'Phase 1 (Live): Internal vaults — 3 Yieldr-operated vaults (NBA Edge, Soccer Alpha, Geopolitics) trading project capital on Polymarket to prove the agent stack.',
      'Phase 2 (Now): Capital raise and TGE — tiered Early Access from $9M to $34M FDV. 50% of raised funds go into vaults, 50% distributed as YLDR token.',
      'Phase 3: Marketplace opens on Polymarket — whitelisted traders can launch their own vaults. Allocation agents and edge detection agents go live for investors.',
      'Phase 4: Multi-protocol expansion — vaults extend to perps (Hyperliquid, Avantis), liquidity provision (Uniswap, Aerodrome), and the full agent stack deploys across chains.',
      'Phase 5: Open marketplace — anyone with verified edge can launch a vault. Fully agent-run fund operations with no whitelisting required.',
      'The progression is deliberate: prove with own capital → raise and distribute tokens → open to select traders → expand protocols → open to all.',
    ],
    hook: 'Phase 1 is live. Three vaults. Real capital. No external money yet — just Yieldr proving its own system works.',
  },
  {
    id: 7,
    title: 'YLDR Token',
    topic: 'Token economics, raise structure, and use of funds',
    keyPoints: [
      '210M total YLDR supply on Base network. Largest allocation is community at 41%, ensuring majority ownership stays with users.',
      'Full allocation: 41% community, 20% team (12-month cliff + 36-month linear vesting), 15% treasury, 10% strategic partners, 9% ecosystem development, 5% DEX liquidity.',
      'First raise sells 13.87% of total supply across 5 tiers ranging from $9M FDV to $34M FDV, averaging ~$18M FDV across tiers.',
      'Raise target is $5M. TGE (Token Generation Event) fires T+7 days from raise completion — no indefinite waiting.',
      'Use of funds: 50% deposited directly into vaults (skin in the game), 40% protocol development and go-to-market, 10% DEX liquidity provision.',
      'No VC tiers, no private rounds at preferential pricing. Retail investors and institutions buy at the same price — a deliberate break from typical crypto fundraising.',
      'The 50% vault deposit mechanic aligns incentives: raised capital is immediately put to work in the same vaults investors will use.',
    ],
    hook: 'No VC discount. No private round. Everyone — retail and institutions — gets the same price. Here\'s the YLDR token breakdown.',
  },
];
