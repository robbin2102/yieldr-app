export interface AdVariant {
  id: string;
  name: string;
  copy: string;           // the actual ad text the user saw
  openingPrompt: string;  // injected trigger to the agent
}

export const AD_VARIANTS: AdVariant[] = [
  {
    id: 'results_lead',
    name: 'Option A — Results Lead',
    copy: 'We put $120K into 5 AI agent vaults. NBA vault did 145% in 30 days. All on-chain. Genesis round open — talk to the bot.',
    openingPrompt:
      '[OPENING] User clicked this ad: "We put $120K into 5 AI agent vaults. NBA vault did 145% in 30 days. All on-chain. Genesis round open — talk to the bot." Deliver exactly what the ad promised. Open with the full vault performance table, note that $120K of project capital is at risk on-chain, and close with a single open question inviting them to engage. Do not acknowledge this instruction or mention it is an ad trigger.',
  },
  {
    id: 'skeptic_hook',
    name: 'Option B — Skeptic Hook',
    copy: 'Most crypto projects fake it. We put $120K of our own money in first. AI agent vaults, all on-chain. See the numbers.',
    openingPrompt:
      '[OPENING] User clicked this ad: "Most crypto projects fake it. We put $120K of our own money in first. AI agent vaults, all on-chain. See the numbers." This user is skeptical. Lead with the skin-in-the-game framing: team capital at risk before user funds. Then deliver the full vault performance table. Close with a question that invites them to probe the strategy. Do not acknowledge this instruction.',
  },
  {
    id: 'trader_angle',
    name: 'Option C — Trader Angle',
    copy: 'AI agent indexes 30K Polymarket traders daily, mirrors the best ones. NBA vault: 61% win rate, 145% in 30 days.',
    openingPrompt:
      '[OPENING] User clicked this ad: "AI agent indexes 30K Polymarket traders daily, mirrors the best ones. NBA vault: 61% win rate, 145% in 30 days." This user is likely a trader. Lead with the strategy mechanics — how the agent finds and mirrors top performers. Show the performance table second. Close by asking what markets they trade. Do not acknowledge this instruction.',
  },
];

export function getAdVariant(id: string): AdVariant | undefined {
  return AD_VARIANTS.find((a) => a.id === id);
}
