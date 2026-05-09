export function buildCommunityPromptPrompt(): string {
  return `Generate a community engagement post — a poll for both X and Telegram.

━━━ OUTPUT FORMAT ━━━
Return ONLY valid JSON in this exact shape:
{
  "type": "post",
  "tweet": "the X poll question text",
  "telegram": "the TG context line before the poll",
  "poll": {
    "question": "poll question (max 300 chars)",
    "options": ["Option 1", "Option 2", "Option 3", "Option 4"]
  }
}

━━━ TOPIC IDEAS ━━━
Pick ONE angle. IMPORTANT: do NOT default to "which category has the most edge" — that topic has been overused. Pick something fresh.

PREDICTION MARKETS:
- "Biggest edge on Polymarket right now: early entries, late fades, or volume-weighted accumulation?"
- "What kills more prediction market bettors: overleveraging or holding losers too long?"
- "If you could only trade one market type for 6 months, what would it be?" (binary outcomes / multi-outcome / range markets / conditional)
- "How do you size a position when the odds are 50/50 but your conviction is high?"

TRADING PSYCHOLOGY:
- "You're up 80% on a position and the market is still moving. Take profit or let it ride?"
- "A trader with 55% win rate and 3:1 risk-reward vs 80% win rate and 1:1 — who do you back?"
- "What's the hardest part of systematic trading?" (sticking to rules / handling drawdowns / sizing correctly / ignoring noise)
- "Do you set stop losses on prediction markets or just hold to resolution?"

CRYPTO & MARKETS:
- "What's the most underrated onchain strategy right now?" (LP / prediction markets / perps / arb)
- "AI agents running trading strategies — gimmick or the future of fund management?"
- "Base, Solana, Arbitrum, or Ethereum mainnet — where's the most alpha right now?"
- "What matters more: the trader's skill or the market they choose to trade?"

SPORTS & EVENTS:
- "NBA playoffs: do sharp bettors make more from spreads, totals, or player props?"
- "Is there more edge in major events (elections, finals) or obscure markets nobody watches?"
- "Soccer betting edge: pre-match analysis or live in-play?"
- "Which upcoming event has the most mispriced odds right now?"

META:
- "How many trades per day is optimal?" (1-3 / 5-10 / 20+ / it depends on strategy)
- "Would you rather follow a trader with 3 months of 200% ROCE or 12 months of 30% ROCE?"
- "What do you check first: win rate, profit factor, sample size, or recent PnL?"
- "Copy trading vs building your own strategy — which path builds more long-term wealth?"

━━━ WRITING NOTES ━━━
TWEET (X post):
- This is a genuine question that starts a conversation — not a quiz
- Keep under 80 words
- No links, no hashtags, no Yieldr mentions
- Make it something a prediction market trader would actually want to reply to
- The tweet text accompanies the poll — don't repeat the poll question, add context instead

TELEGRAM TEXT:
- Brief context line + "Vote below 👇"
- Keep under 60 words

POLL (both X and Telegram):
- Question: clear, under 300 characters
- Options: exactly 4, each under 100 characters
- Cover the realistic range of answers — no joke options
- Make it genuinely debatable — not obvious

CRITICAL:
- Do NOT make polls about vault performance, vault categories, or "which vault/category has more edge"
- Do NOT mention Yieldr, vaults, or any specific Yieldr product
- The poll should feel like it's from a trading community, not a product account
- Every poll should be on a DIFFERENT topic — variety is key`;
}
