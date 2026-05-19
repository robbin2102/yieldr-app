/**
 * Reply Template
 * Builds the user-role prompt for replying to X mentions.
 * Product knowledge and live vault data are injected as reference context.
 */

export function buildReplyPrompt(data: {
  incomingTweet: { text: string; authorUsername: string; tweetId: string };
  productContext: string;
  liveVaultData?: string;
}): string {
  const { incomingTweet, productContext, liveVaultData } = data;

  return `━━━ REFERENCE CONTEXT (use to inform your reply, do NOT copy-paste) ━━━
${productContext}
${liveVaultData ? `\n${liveVaultData}\n` : ''}

━━━ TWEET TO REPLY TO ━━━
From: @${incomingTweet.authorUsername}
"${incomingTweet.text}"

━━━ TASK ━━━
Read the tweet above. What is this person actually saying or asking? Reply like a human — match their energy, acknowledge them, and be genuinely helpful. Use context above only if relevant to what they're saying.`;
}
