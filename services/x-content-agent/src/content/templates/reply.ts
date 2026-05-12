/**
 * Reply Template
 * Builds the user-role prompt for replying to X mentions.
 * Product knowledge and live vault data are injected as context blocks.
 */

export function buildReplyPrompt(data: {
  incomingTweet: { text: string; authorUsername: string; tweetId: string };
  productContext: string;
  liveVaultData?: string;
}): string {
  const { incomingTweet, productContext, liveVaultData } = data;

  return `━━━ PRODUCT KNOWLEDGE ━━━
${productContext}

${liveVaultData ? `━━━ LIVE VAULT DATA ━━━\n${liveVaultData}\n` : ''}
━━━ TWEET TO REPLY TO ━━━
From: @${incomingTweet.authorUsername}
Tweet ID: ${incomingTweet.tweetId}
"${incomingTweet.text}"

━━━ REPLY INSTRUCTIONS ━━━
- Answer their question FIRST using real data from the context blocks above
- For vault/performance questions: share specific ROI numbers from context, link to https://yieldr.org/vaults for live data
- For "how does it work": agents execute within trader-set params — clarify it's not autonomous AI trading
- For access/buy intent: $100 min, $50 vault + $50 YLDR split, invite-only, June 2026 token sale, non-US only — direct to @yieldragent_bot
- For trust/credibility: Base Batches 002 winner, own $100K capital trading first, non-custodial vaults, open source
- For general questions: be helpful and data-first, end with a hook to dig deeper
- Always close with one clear CTA: community link (https://t.me/+bKuyducVGqliNGVl) or bot (@yieldragent_bot)
- 2-4 sentences. Plain text only. 1-2 emojis inline.
- If the question cannot be answered from context, reply with exactly: NEEDS_HUMAN_REPLY`;
}
