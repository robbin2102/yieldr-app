export function buildCommunityPromptPrompt(context?: { vaultData?: any; marketTrends?: string[] }): string {
  const vaultSection = context?.vaultData
    ? `\n━━━ VAULT CONTEXT (optional reference) ━━━
Vault: ${context.vaultData.name || 'N/A'}
ROI since launch: ${context.vaultData.performance?.vaultROI != null ? (context.vaultData.performance.vaultROI > 0 ? '+' : '') + context.vaultData.performance.vaultROI.toFixed(1) + '%' : 'N/A'}
30d ROCE: ${context.vaultData.performance?.periodROCE != null ? context.vaultData.performance.periodROCE.toFixed(1) + '%' : 'N/A'}
Win rate: ${context.vaultData.performance?.winRate != null ? context.vaultData.performance.winRate.toFixed(1) + '%' : 'N/A'}
Specialty: ${context.vaultData.specialty || 'Multi-category'}
You CAN reference this data to ground the poll in real performance — e.g. "Our NBA vault is up X% this month — which category do you think outperforms next?"
But do NOT make the poll about Yieldr itself.\n`
    : '';

  const trendsSection = context?.marketTrends?.length
    ? `\n━━━ TRENDING TOPICS ━━━\n${context.marketTrends.map(t => `- ${t}`).join('\n')}\nYou can use these to make the poll timely and relevant.\n`
    : '';

  return `Generate a community engagement post — a poll for Telegram and a discussion question for X.

━━━ OUTPUT FORMAT ━━━
Return ONLY valid JSON in this exact shape:
{
  "type": "post",
  "tweet": "the X question/discussion post",
  "telegram": "the TG version",
  "poll": {
    "question": "poll question for TG (max 300 chars)",
    "options": ["Option 1", "Option 2", "Option 3", "Option 4"]
  }
}
${vaultSection}${trendsSection}
━━━ TOPIC IDEAS ━━━
Pick ONE angle or invent a similar one:
- "Which market category has the most edge right now?" (NBA / Soccer / Politics / Crypto)
- "What matters more when picking a trader to follow?" (Win rate / Profit factor / Consistency / Risk management)
- "Best entry strategy?" (Follow smart money / Fade the public / Wait for insider signals / Size into dips)
- Questions about specific upcoming events (elections, finals, tournaments)
- "Would you deposit into a vault that's down 15% in 30d but has 600% all-time ROI?"
- Risk tolerance questions — "How much drawdown can you stomach before pulling out?"
- Meta-strategy questions — "Do you diversify across vaults or go all-in on one category?"
- Timing questions — "Is it better to enter prediction markets early or wait for sharper odds?"

━━━ WRITING NOTES ━━━
TWEET (X post):
- This is a genuine discussion question — conversational, not a formal poll
- Keep under 80 words — just the question + brief context
- No links, no hashtags, no "What do you think about Yieldr?" self-promo
- Make it something a prediction market trader would actually want to reply to
- End with the question, not a CTA

TELEGRAM TEXT:
- Brief context line + "Vote below"
- Keep under 60 words
- Conversational but slightly more direct than the tweet

POLL (Telegram):
- Question: clear, under 300 characters
- Options: exactly 4, each under 100 characters
- Cover the realistic range of answers — no joke options, no "all of the above"
- Make it genuinely debatable — not obvious, not too niche

GENERAL:
- The topic should be about prediction markets, trading, crypto, or sports betting strategy
- Do NOT make it about Yieldr as a product — it should feel like a community discussion
- Avoid yes/no polls — multi-option polls get more engagement
- If vault context is provided you can reference real data, but the poll should still be broadly interesting`;
}
