/**
 * Base Ecosystem Posting Template
 * Generates posts based on content from top Base accounts
 */

export function buildBasePostingPrompt(data: {
  sourcePost?: { text: string; author: string; tweetId: string };
  context?: string;
}): string {
  const { sourcePost, context } = data;

  return `Generate a Base ecosystem post for X from the Yieldr (@yieldrdotorg) perspective.

${sourcePost ? `BASE COMMUNITY POST (from @${sourcePost.author}):
"${sourcePost.text.substring(0, 200)}"
` : ''}

YIELDR CONTEXT FOR BASE:
- Yieldr is building Agentic Trading Vaults on Base
- Winner of Base Batches 002 and Incubase accelerator
- Everything on-chain on Base, fully verifiable
- AI agents trade Polymarket, returns compound in on-chain vaults
- $100K project capital deployed first before public access
${context || ''}

Create a Base ecosystem post that:
1. ${sourcePost ? 'Builds on the source post topic with Yieldr perspective' : 'Shares genuine Base ecosystem insight'}
2. Shows Yieldr as an active Base community builder
3. Adds value with trading/DeFi/AI perspective
4. Does NOT shill — contribute genuine alpha to the conversation
5. Ends with a question driving engagement
6. Ends with varied CTA inviting users to ask @yieldrdotorg for more Base alpha
7. Max 280 characters
${sourcePost ? `8. This is type "quote" referencing tweet ID ${sourcePost.tweetId}` : '8. This is type "post"'}`;
}
