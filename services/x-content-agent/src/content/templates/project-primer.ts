import { PrimerEntry } from '../docs-content';
import { ContentStyle, STYLE_DESCRIPTIONS } from '../styles';

export function buildProjectPrimerPrompt(entry: PrimerEntry, style?: ContentStyle): string {
  const s = style || 'narrative';

  return `Write a short educational post about this aspect of Yieldr.

${STYLE_DESCRIPTIONS[s]}

━━━ THE IDEA ━━━
Topic: ${entry.topic}
Core claim: ${entry.core_claim}
Supporting data: ${entry.supporting_data}
Yieldr's position: ${entry.yieldr_position}
Hook angle: ${entry.hook}

━━━ WRITING NOTES ━━━
- KEEP IT SHORT: tweet under 100 words, telegram under 130 words
- Lead with the core claim or hook angle — not "Yieldr is..."
- Use the supporting data as proof, not filler — cite specific numbers when available
- The Yieldr position is the "so what" — weave it in naturally, don't make it a sales pitch
- This is educational content: explain what exists and why it matters
- No hype words ("revolutionary", "game-changing", "massive") — just explain it
- For tweet: no links, end with a question that makes people curious
- For telegram: end with "yieldr.org/docs" as the last line`;
}
