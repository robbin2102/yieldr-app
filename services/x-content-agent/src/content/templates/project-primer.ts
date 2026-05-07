import { DocSection } from '../docs-content';
import { ContentStyle, STYLE_DESCRIPTIONS } from '../styles';

export function buildProjectPrimerPrompt(section: DocSection, style?: ContentStyle): string {
  const s = style || 'narrative';

  const keyPointsList = section.keyPoints
    .map((point) => `- ${point}`)
    .join('\n');

  return `Write a short educational post about this aspect of Yieldr.

${STYLE_DESCRIPTIONS[s]}

━━━ TOPIC ━━━
Section: ${section.title}
Hook angle: ${section.hook}

Key points:
${keyPointsList}

━━━ WRITING NOTES ━━━
- KEEP IT SHORT: tweet under 100 words, telegram under 130 words
- This is educational content, not a sales pitch — explain what Yieldr does and why it matters
- Lead with the hook angle, not "Yieldr is..."
- Use specific numbers from the key points (token supply, FDV, number of vaults, etc.)
- No hype words ("revolutionary", "game-changing", "massive") — just explain it
- For tweet: no links, end with a question that makes people curious
- For telegram: end with "yieldr.org/docs" as the last line`;
}
