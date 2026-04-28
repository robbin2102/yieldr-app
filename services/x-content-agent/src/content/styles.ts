export type ContentStyle = 'narrative' | 'signal' | 'punchy';

export const STYLE_DESCRIPTIONS: Record<ContentStyle, string> = {
  narrative: `STYLE: NARRATIVE — Tell this as a story. Introduce the subject (trader/vault/position) as a character. Build up to the insight. Closing line should land like a punchline. Think long-form Twitter thread energy.`,
  signal: `STYLE: SIGNAL — Frame this as a just-detected alert. Something was just found. Build urgency without hype. Lead with what was detected, then explain why it matters. Clinical but compelling.`,
  punchy: `STYLE: PUNCHY — Short. Bold. 4-8 lines max. One shocking stat or outcome. One insight. One closing line. No bullets. No headers. Just the hit.`,
};

export function randomStyle(): ContentStyle {
  const styles: ContentStyle[] = ['narrative', 'signal', 'punchy'];
  return styles[Math.floor(Math.random() * styles.length)];
}

export function weightedVaultStyle(): ContentStyle {
  const r = Math.random();
  if (r < 0.40) return 'punchy';
  if (r < 0.75) return 'narrative';
  return 'signal';
}
