import { ISessionState } from './models/ChatSession';

const TOPIC_KEYWORDS: Record<string, string[]> = {
  performance: ['performance', 'return', 'roi', 'profit', 'yield', '%', 'gain'],
  strategy: ['strategy', 'how does', 'agent', 'signal', 'convergence', 'polymarket', 'hyperliquid'],
  team: ['team', 'founder', 'robbin', 'who built', 'background', 'experience'],
  genesis: ['genesis', 'buy', 'price', 'fdv', 'token', 'yldr', 'invest', 'purchase'],
  timeline: ['when', 'timeline', 'q3', 'q4', 'tge', 'unlock', 'redeem'],
  risk: ['risk', 'safe', 'rug', 'loss', 'locked', 'audit', 'contract'],
  community: ['telegram', 'community', 'group', 'tg', 'discord', 'members'],
  vaults: ['vault', 'nba', 'btc', 'eth', 'world cup', 'geo', 'momentum', 'mean rev'],
};

const VAULT_KEYWORDS: Record<string, string[]> = {
  nba: ['nba', 'basketball', 'celtics', 'sharps'],
  world_cup: ['world cup', 'soccer', 'football', 'fifa'],
  geo: ['geo', 'geopolitics', 'politics', 'iran'],
  eth: ['eth', 'ethereum', 'mean rev', 'mean-rev'],
  btc: ['btc', 'bitcoin', 'momentum'],
};

const OBJECTION_KEYWORDS: Record<string, string[]> = {
  lockup: ['lock', 'locked', 'lockup', 'when can i get', 'withdraw', 'exit'],
  rug: ['rug', 'scam', 'trust', 'legit', 'fake', 'real'],
  loss: ['lose', 'loss', 'principal', 'what if it fails'],
  skip_token: ['just deposit', 'without token', 'skip token', 'no token'],
  idle: ['idle', 'waiting', 'before q3', 'doing nothing'],
};

export function detectTopics(message: string): string[] {
  const lower = message.toLowerCase();
  return Object.entries(TOPIC_KEYWORDS)
    .filter(([, keywords]) => keywords.some((kw) => lower.includes(kw)))
    .map(([topic]) => topic);
}

export function detectVaultInterest(message: string): string | null {
  const lower = message.toLowerCase();
  for (const [vault, keywords] of Object.entries(VAULT_KEYWORDS)) {
    if (keywords.some((kw) => lower.includes(kw))) return vault;
  }
  return null;
}

export function detectObjections(message: string): string[] {
  const lower = message.toLowerCase();
  return Object.entries(OBJECTION_KEYWORDS)
    .filter(([, keywords]) => keywords.some((kw) => lower.includes(kw)))
    .map(([objection]) => objection);
}

export function buildStateInjection(state: ISessionState): string {
  const parts = [
    `exchange ${state.exchange_count}`,
    `topics: ${state.topics_covered.length ? state.topics_covered.join(', ') : 'none'}`,
    `offer ${state.offer_presented ? 'presented' : 'not presented'}`,
    `nudge ${state.nudge_used ? 'used' : 'not used'}`,
  ];
  if (state.vault_interest) parts.push(`vault interest: ${state.vault_interest}`);
  if (state.objections_raised.length) parts.push(`objections: ${state.objections_raised.join(', ')}`);
  return `[State: ${parts.join(', ')}]`;
}

export function updateState(
  state: ISessionState,
  userMessage: string,
  agentResponse: string
): Partial<ISessionState> {
  const newTopics = detectTopics(userMessage);
  const vaultInterest = detectVaultInterest(userMessage);
  const objections = detectObjections(userMessage);

  const responseLower = agentResponse.toLowerCase();
  const offerPresented =
    state.offer_presented ||
    responseLower.includes('genesis') ||
    responseLower.includes('$9m fdv') ||
    responseLower.includes('500 slots');
  const nudgeUsed =
    state.nudge_used ||
    responseLower.includes('genesis is open') ||
    responseLower.includes('happy to keep chatting');
  const communityMentioned =
    state.community_mentioned ||
    responseLower.includes('community') ||
    responseLower.includes('telegram') ||
    responseLower.includes('tg group');

  return {
    exchange_count: state.exchange_count + 1,
    topics_covered: [...new Set([...state.topics_covered, ...newTopics])],
    vault_interest: vaultInterest || state.vault_interest,
    objections_raised: [...new Set([...state.objections_raised, ...objections])],
    offer_presented: offerPresented,
    nudge_used: nudgeUsed,
    community_mentioned: communityMentioned,
  };
}
