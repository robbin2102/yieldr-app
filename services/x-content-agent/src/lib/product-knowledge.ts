/**
 * Product Knowledge — MongoDB-backed context blocks
 *
 * Fetches relevant product knowledge blocks from the product_knowledge
 * collection based on keyword matching against incoming text.
 */

import { getDB } from './db';

const MAX_BLOCKS = 4;
const DEFAULT_BLOCK_IDS = ['what_is_yieldr', 'early_access', 'achievements'];

export async function getRelevantBlocks(text: string): Promise<string> {
  const db = await getDB();
  const col = db.collection('product_knowledge');
  const textLower = text.toLowerCase();

  const allBlocks = await col.find({ active: true }).toArray();

  if (allBlocks.length === 0) {
    console.warn('[ProductKnowledge] No blocks found in product_knowledge collection');
    return '';
  }

  const scored = allBlocks
    .map((block) => {
      const keywords = (block.keywords as string[]) || [];
      const hits = keywords.filter((kw) => textLower.includes(kw)).length;
      return { id: String(block._id), content: block.content as string, hits };
    })
    .filter((b) => b.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, MAX_BLOCKS);

  if (scored.length === 0) {
    const defaults = allBlocks.filter((b) =>
      DEFAULT_BLOCK_IDS.includes(String(b._id))
    );
    return defaults.map((b) => b.content).join('\n\n---\n\n');
  }

  return scored.map((b) => b.content).join('\n\n---\n\n');
}
