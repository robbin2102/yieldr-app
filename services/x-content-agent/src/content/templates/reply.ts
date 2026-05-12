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
- For vault/performance questions: share specific ROI numbers from context, mention https://yieldr.org/vaults only if relevant
- For "how does it work": agents execute within trader-set params — clarify it's not autonomous AI trading
- For access/buy intent: "Early Access is open, invite-only, starts at $100" — only mention @yieldragent_bot if they want next steps. Do NOT mention the $50/$50 split or tier pricing.
- For trust/credibility: Base Batches 002 winner, own $100K capital trading first, non-custodial vaults, open source
- For general questions: be helpful, data-first, conversational — just answer well
- Do NOT force a CTA or link at the end of every reply. Only include TG group link or @yieldragent_bot when the user is clearly asking how to join or invest.
- 2-4 sentences. Plain text only. 1-2 emojis inline.
- If the question cannot be answered from context, reply with exactly: NEEDS_HUMAN_REPLY`;
}
