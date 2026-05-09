/**
 * Product Documentation — Post-Sized Primer Entries
 *
 * Each entry is a single idea with enough context for the LLM to write
 * one focused, factual post. Rotates daily through the full list.
 *
 * Categories: problem (4), solution (4), product (4), vision (2) = 14 entries.
 * Roadmap and token entries excluded — too shallow for standalone posts.
 *
 * Fields:
 *   - id: unique key (category_nn)
 *   - topic: one-line subject for the post
 *   - core_claim: the single thesis the post should argue or explain
 *   - supporting_data: concrete numbers, names, or facts that back the claim
 *   - yieldr_position: how Yieldr specifically addresses this — the "so what"
 *   - hook: suggested opening angle (agent can rephrase)
 */

export interface PrimerEntry {
  id: string;
  topic: string;
  core_claim: string;
  supporting_data: string;
  yieldr_position: string;
  hook: string;
}

export const PRIMER_ENTRIES: PrimerEntry[] = [
  // ── PROBLEM ──────────────────────────────────────────────
  {
    id: 'problem_01',
    topic: 'Hedge fund access is broken',
    core_claim: '10,000 hedge funds exist. Millions of traders with real edge will never run one because the operational overhead is prohibitive.',
    supporting_data: 'The hedge fund structure is 70 years old. Accreditation walls, million-dollar minimums, 2-and-20 fee models, jurisdictional moats. A fund needs 20-50 employees just to operate.',
    yieldr_position: 'Yieldr replaces the back office with an AI agent stack. A trader with edge needs a vault and agents, not a compliance team and $10M in seed capital.',
    hook: 'There are 10,000 hedge funds in the world. There should be a million.',
  },
  {
    id: 'problem_02',
    topic: 'DeFi vaults are not funds',
    core_claim: 'A vault is not a fund. There\'s no investor matching, no communication layer, no retention mechanism, no drawdown management.',
    supporting_data: 'DeFi vaults today are deposit-and-pray. No system for continuous allocation against risk-return targets. No way for investors to evaluate why a trader wins vs. just seeing PnL.',
    yieldr_position: 'Yieldr builds the fund infrastructure layer on top of vaults — matching, comms, allocation, monitoring, edge detection. The vault is the primitive; the agent stack is the fund.',
    hook: 'Most DeFi "vaults" are just smart contracts with a deposit button. That\'s not a fund.',
  },
  {
    id: 'problem_03',
    topic: 'Edge stays opaque onchain',
    core_claim: 'PnL is visible onchain but strategy isn\'t. Capital chases recent performance instead of understanding why a trader wins.',
    supporting_data: 'No system separates skill from luck at scale. Investors see a green number and ape in. Drawdowns trigger panic exits. Nobody knows if a 60% win rate is edge or variance.',
    yieldr_position: 'Yieldr\'s Edge Detection agents parse every trade to extract patterns — entry timing, sizing relative to conviction, market selection bias, consistency. p-values, not vibes.',
    hook: 'Onchain PnL tells you who won. It doesn\'t tell you who\'s good.',
  },
  {
    id: 'problem_04',
    topic: 'Supply-demand mismatch in capital allocation',
    core_claim: 'Skilled traders can\'t attract capital efficiently, and investors can\'t find or evaluate them systematically.',
    supporting_data: 'Allocation is manual, one vault at a time. No continuous rebalancing. No risk-return targeting across multiple managers. The infrastructure doesn\'t exist.',
    yieldr_position: 'Investor-side Allocation Agents deploy capital across multiple vaults to hit target risk-return profiles. Monitoring Agents track drift and trigger rebalances automatically.',
    hook: 'Imagine picking stocks one at a time with no portfolio tools. That\'s how DeFi vault investing works today.',
  },

  // ── SOLUTION ─────────────────────────────────────────────
  {
    id: 'solution_01',
    topic: 'Why agents are the missing layer',
    core_claim: 'Without agents, every fund still needs human operators on both sides — that caps the world at thousands of funds.',
    supporting_data: 'Trader-side agents handle investor matching and community. Investor-side agents handle allocation and monitoring. Edge detection agents validate skill. All run 24/7 at marginal cost.',
    yieldr_position: 'With agents the operational constraint dissolves. The agent stack replaces the 20-50 people a traditional fund needs to operate.',
    hook: 'A hedge fund needs ~40 people to operate. What if it needed zero?',
  },
  {
    id: 'solution_02',
    topic: 'Trader-side agents explained',
    core_claim: 'A trader\'s job is to trade. Everything else — investor comms, matching, drawdown management, retention — should be automated.',
    supporting_data: 'Matching Agent pairs investors with vaults by risk tolerance. Community Agent handles updates, drawdown communications, expectation management. Trader never stops trading to write updates.',
    yieldr_position: 'Yieldr\'s trader-side agents let a solo trader run a fund that looks and feels institutional to investors — without hiring anyone.',
    hook: 'The best traders are terrible at investor relations. That\'s fine — agents handle it.',
  },
  {
    id: 'solution_03',
    topic: 'Investor-side agents explained',
    core_claim: 'Investors need portfolio-level allocation across managers, not manual one-vault-at-a-time decisions.',
    supporting_data: 'Allocation Agent understands each investor\'s risk-return goals. Continuously allocates across vaults, rotates out underperformers, rebalances. Monitoring Agent flags drift and underperformance.',
    yieldr_position: 'For the first time, a retail investor gets the same portfolio construction that a family office gets — powered by agents instead of analysts.',
    hook: 'Family offices have portfolio managers. Retail DeFi investors have... a list of vaults. Until now.',
  },
  {
    id: 'solution_04',
    topic: 'Edge detection — separating skill from luck',
    core_claim: 'The hardest problem in fund management isn\'t finding traders. It\'s knowing which ones are actually skilled vs. lucky.',
    supporting_data: 'Edge Detection agents analyze entry patterns, position sizing logic, market selection tendencies, timing consistency. Statistical validation via p-values — not just PnL.',
    yieldr_position: 'Yieldr ranks traders by statistical edge, not recent returns. A trader with a 0.00000001 p-value isn\'t lucky — that\'s verified, measurable skill.',
    hook: 'A 70% win rate means nothing without knowing the sample size. Here\'s how Yieldr separates skill from luck.',
  },

  // ── PRODUCT ──────────────────────────────────────────────
  {
    id: 'product_01',
    topic: 'What a Yieldr vault actually is',
    core_claim: 'A Yieldr vault is a non-custodial smart contract that holds investor capital, executes the trader\'s strategy onchain, and publishes real-time performance data.',
    supporting_data: 'Investors deposit, withdraw, and track PnL directly through the contract. No counterparty risk from the platform. Every trade is verifiable onchain.',
    yieldr_position: 'Currently live with 3 vaults trading Yieldr project capital on Polymarket: NBA Edge, Soccer Alpha, and Geopolitics. Proving the system with own money first.',
    hook: 'No counterparty risk. No withdrawal gates. Every trade onchain. Here\'s how Yieldr vaults work.',
  },
  {
    id: 'product_02',
    topic: 'The three-layer agent stack',
    core_claim: 'Yieldr\'s agent stack has three layers that together replace the entire operational team of a traditional fund.',
    supporting_data: 'Layer 1: Trader-side (Matching Agent + Community Agent). Layer 2: Investor-side (Allocation Agent + Monitoring Agent). Layer 3: Edge Detection (Trade Parsing Agent + Validation Agent).',
    yieldr_position: 'Each layer solves a distinct bottleneck. Together they dissolve the operational constraint that historically required 20-50 employees.',
    hook: '6 AI agents. 3 layers. Zero employees. That\'s the Yieldr fund stack.',
  },
  {
    id: 'product_03',
    topic: 'Live vaults on Polymarket',
    core_claim: 'Yieldr is live with 3 vaults trading real capital on Polymarket — NBA Edge, Soccer Alpha, and Geopolitics.',
    supporting_data: 'NBA Edge focuses on basketball prediction markets. Soccer Alpha covers football/soccer globally. Geopolitics trades political and geopolitical event markets. All run by top-ranked traders with verified statistical edge.',
    yieldr_position: 'These vaults trade Yieldr\'s own project capital. The system is being stress-tested and proven before opening to external investors.',
    hook: 'Three vaults. Three categories. Real capital. No outside money yet — Yieldr is proving its own system first.',
  },
  {
    id: 'product_04',
    topic: 'AI-native fund vs. traditional fund',
    core_claim: 'This isn\'t automation of an old process. It\'s a new primitive: the AI-native fund, where the trader supplies edge and agents supply everything else.',
    supporting_data: 'Traditional fund: trader + analysts + risk team + compliance + IR + ops + legal = 20-50 people. AI-native fund: trader + agent stack = 1 person + software.',
    yieldr_position: 'The shift is from "funds as institutions" to "funds as software" — lightweight, composable, globally accessible, running 24/7 without human overhead.',
    hook: 'A traditional hedge fund is an institution. An AI-native fund is software. That\'s a category shift, not an upgrade.',
  },

  // ── VISION ───────────────────────────────────────────────
  {
    id: 'vision_01',
    topic: 'A million funds onchain',
    core_claim: 'Yieldr\'s endgame: a million AI-native hedge funds operating onchain, each run by a trader with verified edge and a full agent stack.',
    supporting_data: 'Agents dissolve the operational constraint that capped the world at 10,000 funds. Geography and credentials stop being gatekeepers.',
    yieldr_position: 'A trader in Seoul, São Paulo, or Lagos with verified edge can launch a fund as easily as deploying a smart contract.',
    hook: 'What happens when the cost of running a fund drops to near zero? A million funds happen.',
  },
  {
    id: 'vision_02',
    topic: 'Beyond prediction markets',
    core_claim: 'Prediction markets are the proving ground. The vision extends to perps, spot, liquidity provision, and any onchain strategy with measurable edge.',
    supporting_data: 'Polymarket validates the agent stack in a clean, outcome-driven market. Next: Hyperliquid perps, Avantis trading, Uniswap/Aerodrome LP, multi-chain deployment.',
    yieldr_position: 'The agent stack is market-agnostic. Once proven on prediction markets, it deploys to any onchain strategy where edge can be measured.',
    hook: 'Polymarket is chapter one. Perps, LP, spot — every onchain strategy with measurable edge is on the roadmap.',
  },
];
