import connectDB from '@/lib/mongoose';
import { TxReceiptCache } from '@/models/TxReceiptCache';
import type { EdgeChainId } from './chains';

/**
 * Bulk-reads cached receipt logs for a batch of transaction hashes - one
 * Mongo query for the whole candidate list, not one per hash. Returns a
 * Map keyed by lowercased hash so callers can do a plain .get() per
 * candidate instead of re-querying.
 */
export async function getCachedReceipts(
  chain: EdgeChainId,
  hashes: string[]
): Promise<Map<string, { logs: any[] }>> {
  if (hashes.length === 0) return new Map();
  await connectDB();
  const docs = await TxReceiptCache.find(
    { chain, txHash: { $in: hashes.map((h) => h.toLowerCase()) } },
    { txHash: 1, logs: 1 }
  ).lean();
  const map = new Map<string, { logs: any[] }>();
  for (const d of docs as any[]) map.set(d.txHash, { logs: d.logs ?? [] });
  return map;
}

/**
 * Bulk-persists newly-fetched receipt logs. Uses $setOnInsert + upsert so a
 * race between two concurrent analysis runs never overwrites a good cached
 * value - receipts are immutable, so "first writer wins" is always correct.
 */
export async function cacheReceipts(
  chain: EdgeChainId,
  entries: { hash: string; logs: any[] }[]
): Promise<void> {
  if (entries.length === 0) return;
  await connectDB();
  await TxReceiptCache.bulkWrite(
    entries.map(({ hash, logs }) => ({
      updateOne: {
        filter: { chain, txHash: hash.toLowerCase() },
        update: { $setOnInsert: { chain, txHash: hash.toLowerCase(), logs, fetchedAt: new Date() } },
        upsert: true,
      },
    })),
    { ordered: false }
  );
}
