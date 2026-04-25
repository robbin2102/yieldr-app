/**
 * Base Ecosystem Posting Template
 * Generates posts connecting Base ecosystem news to Yieldr
 */

export function buildBasePostingPrompt(data: {
  sourcePost?: { text: string; author: string; tweetId: string };
  context?: string;
}): string {
  const { sourcePost, context } = data;

  return `Generate a Base ecosystem post${sourcePost ? ' as a quote tweet' : ''}.

${sourcePost ? `SOURCE POST BY @${sourcePost.author}:
"${sourcePost.text.substring(0, 200)}"

This is a quote tweet — build on their point with Yieldr's angle.` : 'Generate a standalone Base ecosystem post.'}

YIELDR CONTEXT:
- Yieldr is live on Base — on-chain vaults, public treasury, verifiable trades
- Winner of Base Batches 002 and Incubase
- $100K project capital already deployed and earning
- Early Access: $100 → $50 Base USDC at 4.5% APY + $50 YLDR at $9M FDV
${context || ''}

IMPORTANT RULES:
- Connect the Base ecosystem topic to Yieldr's on-chain execution angle
- Add alpha — something specific about Base or on-chain trading that the audience gains
- Don't shill Yieldr directly — position as a builder in the Base community sharing perspective
- One clean insight, one Yieldr connection, one question
- If quote tweet: acknowledge their point, then add Yieldr's angle
- End with a question that connects to prediction markets or on-chain trading
- Max 280 characters
${sourcePost ? `- Type: "quote", target_post_id: "${sourcePost.tweetId}"` : '- Type: "post"'}`;
}
