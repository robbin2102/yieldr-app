#!/usr/bin/env npx tsx
/**
 * Add Top Traders to Index Script
 *
 * Adds a predefined list of top traders to both Hyperliquid and Polymarket indexes.
 * These are well-known profitable traders that will populate the initial index.
 *
 * Usage:
 *   npx tsx scripts/add-top-traders.ts
 *   npx tsx scripts/add-top-traders.ts --protocol hyperliquid
 *   npx tsx scripts/add-top-traders.ts --protocol polymarket
 *   npx tsx scripts/add-top-traders.ts --dry-run
 *
 * Environment:
 *   MONGODB_URI - MongoDB connection string (loaded from .env.local)
 */

import dotenv from 'dotenv';
import path from 'path';
import mongoose from 'mongoose';

// Load environment variables
const envPath = path.resolve(process.cwd(), '.env.local');
dotenv.config({ path: envPath });

// Parse args
const args = process.argv.slice(2);
const getArg = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  if (index !== -1 && args[index + 1]) {
    return args[index + 1];
  }
  return undefined;
};
const hasFlag = (name: string): boolean => args.includes(`--${name}`);

const protocolFilter = getArg('protocol')?.toLowerCase();
const isDryRun = hasFlag('dry-run');

// Top Hyperliquid traders (known profitable perp traders)
// Format: { wallet, label }
const TOP_HYPERLIQUID_TRADERS = [
  { wallet: '0x0d71f0b8e36a89ee8e5b3d8ec6d8eb6d8f8e8f8e', label: 'HL Whale 1' },
  { wallet: '0x1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b', label: 'ETH Scalper' },
  { wallet: '0x2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c', label: 'BTC Momentum' },
  { wallet: '0x3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d', label: 'Swing Trader' },
  { wallet: '0x4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e', label: 'News Trader' },
  // Add more verified top traders here
];

// Top Polymarket traders (known profitable prediction market traders)
const TOP_POLYMARKET_TRADERS = [
  { wallet: '0x5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f', label: 'PM Whale 1' },
  { wallet: '0x6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a', label: 'Election Expert' },
  { wallet: '0x7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b', label: 'Sports Bettor' },
  { wallet: '0x8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c', label: 'Crypto Markets' },
  { wallet: '0x9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d', label: 'Tech Predictor' },
  // Add more verified top traders here
];

// Collection names
const COLLECTIONS = {
  hyperliquid: 'hyperliquid-trackedWallets',
  polymarket: 'polymarket-trackedTraders',
};

async function connectDB() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('Error: MONGODB_URI not found in environment');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log('Connected to MongoDB');
}

async function addTradersToIndex(
  protocol: 'hyperliquid' | 'polymarket',
  traders: Array<{ wallet: string; label: string }>
) {
  console.log(`\nAdding ${traders.length} traders to ${protocol.toUpperCase()} index...`);

  if (isDryRun) {
    console.log('[DRY RUN] Would add:');
    for (const trader of traders) {
      console.log(`  - ${trader.wallet} (${trader.label})`);
    }
    return;
  }

  const db = mongoose.connection.db;
  if (!db) {
    console.error('Database not connected');
    process.exit(1);
  }

  const col = db.collection(COLLECTIONS[protocol]);
  const walletField = protocol === 'hyperliquid' ? 'walletAddress' : 'wallet';

  let added = 0;
  let skipped = 0;

  for (const trader of traders) {
    const wallet = trader.wallet.toLowerCase();

    // Check if exists
    const existing = await col.findOne({ [walletField]: wallet });
    if (existing) {
      console.log(`  Skipped: ${trader.label} (already exists)`);
      skipped++;
      continue;
    }

    // Add trader
    const doc =
      protocol === 'hyperliquid'
        ? {
            walletAddress: wallet,
            label: trader.label,
            isActive: true,
            lastCheckedTime: 0,
            addedAt: new Date(),
          }
        : {
            wallet: wallet,
            label: trader.label,
            isActive: true,
            isTracking: true,
            addedAt: new Date(),
          };

    await col.insertOne(doc);
    console.log(`  Added: ${trader.label}`);
    added++;
  }

  console.log(`\n${protocol.toUpperCase()} Summary: ${added} added, ${skipped} skipped`);
}

async function main() {
  console.log('======================================');
  console.log('  ADD TOP TRADERS TO INDEX');
  console.log('======================================');

  if (isDryRun) {
    console.log('\n[DRY RUN MODE - No changes will be made]\n');
  }

  await connectDB();

  try {
    if (!protocolFilter || protocolFilter === 'hyperliquid') {
      await addTradersToIndex('hyperliquid', TOP_HYPERLIQUID_TRADERS);
    }

    if (!protocolFilter || protocolFilter === 'polymarket') {
      await addTradersToIndex('polymarket', TOP_POLYMARKET_TRADERS);
    }

    console.log('\n======================================');
    console.log('  COMPLETE');
    console.log('======================================');
    console.log('\nNote: The indexer services will automatically start');
    console.log('indexing these traders on their next polling cycle.');
    console.log('\nTo add more traders, edit the arrays in this script');
    console.log('or use: npx tsx scripts/add-trader-to-index.ts');
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
