/**
 * Reply Template
 * Generates contextual replies to mentions and comments
 */

export function buildReplyPrompt(data: {
  incomingTweet: { text: string; authorUsername: string; tweetId: string };
  context?: {
    vaultData?: any;
    traderData?: any;
    marketData?: any;
  };
}): string {
  const { incomingTweet, context } = data;

  let contextBlock = '';
  if (context?.vaultData) {
    contextBlock += `\nVAULT DATA: ${JSON.stringify(context.vaultData).substring(0, 300)}`;
  }
  if (context?.traderData) {
    contextBlock += `\nTRADER DATA: ${JSON.stringify(context.traderData).substring(0, 300)}`;
  }
  if (context?.marketData) {
    contextBlock += `\nMARKET DATA: ${JSON.stringify(context.marketData).substring(0, 300)}`;
  }

  return `Generate a reply to this tweet mentioning @yieldrdotorg.

INCOMING TWEET (from @${incomingTweet.authorUsername}):
"${incomingTweet.text}"
Tweet ID: ${incomingTweet.tweetId}

${contextBlock ? `RELEVANT DATA:${contextBlock}` : ''}

Reply rules:
1. Answer their question FIRST with real data if available
2. Be helpful, sharp, and data-first
3. If they ask about vaults/performance/access, share real numbers and warmly guide to TG channel or yieldr.org
4. If they show buying intent, mention Early Access details
5. Keep it concise (2-4 sentences max)
6. End with an invitation to ask more or check yieldr.org
7. Use 1-2 emojis naturally
8. Type is "reply" to tweet ID ${incomingTweet.tweetId}`;
}
