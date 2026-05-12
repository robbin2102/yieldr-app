/**
 * Manual seed script for product_knowledge collection.
 * Safe to re-run — uses upsert.
 *
 * Usage: npx ts-node src/scripts/seed-product-knowledge.ts
 *
 * Note: This also runs automatically on service startup via index.ts.
 */

import { connectDB, closeDB } from '../lib/db';
import { seedProductKnowledge } from '../lib/seed-product-knowledge';

async function main() {
  await connectDB();
  await seedProductKnowledge();
  await closeDB();
  process.exit(0);
}

main().catch((err) => {
  console.error('[Seed] Failed:', err);
  process.exit(1);
});
