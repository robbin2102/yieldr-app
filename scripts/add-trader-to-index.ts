#!/usr/bin/env npx tsx
/**
 * Add Trader to Index Script
 *
 * Usage:
 *   npx tsx scripts/add-trader-to-index.ts --protocol <protocol> --wallet <wallet> [--label <label>]
 *   npx tsx scripts/add-trader-to-index.ts --protocol hyperliquid --wallet 0x... --label "Top ETH Trader"
 *   npx tsx scripts/add-trader-to-index.ts --protocol polymarket --wallet 0x... --label "Prediction Master"
 *   npx tsx scripts/add-trader-to-index.ts --list --protocol hyperliquid
 *   npx tsx scripts/add-trader-to-index.ts --remove --protocol hyperliquid --wallet 0x...
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

// Parse command line arguments
const args = process.argv.slice(2);
const getArg = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  if (index !== -1 && args[index + 1]) {
    return args[index + 1];
  }
  return undefined;
};
const hasFlag = (name: string): boolean => args.includes(`--${name}`);

const protocol = getArg('protocol')?.toLowerCase();
const wallet = getArg('wallet')?.toLowerCase();
const label = getArg('label');
const isList = hasFlag('list');
const isRemove = hasFlag('remove');
const isHelp = hasFlag('help') || hasFlag('h');

// Help message
function showHelp() {
  console.log(`
Add Trader to Index Script
==========================

Adds traders to Hyperliquid or Polymarket indexer for tracking.

Usage:
  npx tsx scripts/add-trader-to-index.ts --protocol <protocol> --wallet <wallet> [--label <label>]

Commands:
  Add trader:    --protocol <hyperliquid|polymarket> --wallet <address> [--label <name>]
  List traders:  --list --protocol <hyperliquid|polymarket>
  Remove trader: --remove --protocol <hyperliquid|polymarket> --wallet <address>

Examples:
  # Add a Hyperliquid trader
  npx tsx scripts/add-trader-to-index.ts --protocol hyperliquid --wallet 0x1234... --label "Top ETH Trader"

  # Add a Polymarket trader
  npx tsx scripts/add-trader-to-index.ts --protocol polymarket --wallet 0x5678... --label "Election Expert"

  # List all tracked Hyperliquid traders
  npx tsx scripts/add-trader-to-index.ts --list --protocol hyperliquid

  # Remove a trader from tracking
  npx tsx scripts/add-trader-to-index.ts --remove --protocol polymarket --wallet 0x1234...

Options:
  --protocol    Protocol to use: hyperliquid or polymarket (required)
  --wallet      Wallet address to add/remove (required for add/remove)
  --label       Human-readable label for the trader (optional)
  --list        List all tracked traders for the protocol
  --remove      Remove trader from tracking
  --help, -h    Show this help message
`);
}

// MongoDB connection
async function connectDB() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('Error: MONGODB_URI not found in environment');
    console.error('Make sure .env.local exists with MONGODB_URI set');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log('Connected to MongoDB');
}

// Collection names
const COLLECTIONS = {
  hyperliquid: 'hyperliquid-trackedWallets',
  polymarket: 'polymarket-trackedTraders',
};

// Add trader to index
async function addTrader(protocol: string, wallet: string, label?: string) {
  const collection = COLLECTIONS[protocol as keyof typeof COLLECTIONS];
  if (!collection) {
    console.error(`Invalid protocol: ${protocol}`);
    process.exit(1);
  }

  const db = mongoose.connection.db;
  if (!db) {
    console.error('Database not connected');
    process.exit(1);
  }

  const col = db.collection(collection);

  // Check if already exists
  const existing = await col.findOne({
    [protocol === 'hyperliquid' ? 'walletAddress' : 'wallet']: wallet
  });

  if (existing) {
    console.log(`Trader ${wallet} already exists in ${protocol} index`);
    if (label && existing.label !== label) {
      await col.updateOne(
        { [protocol === 'hyperliquid' ? 'walletAddress' : 'wallet']: wallet },
        { $set: { label, isActive: true, isTracking: true } }
      );
      console.log(`Updated label to: ${label}`);
    }
    return;
  }

  // Add new trader
  const doc = protocol === 'hyperliquid'
    ? {
        walletAddress: wallet,
        label: label || wallet.slice(0, 10) + '...',
        isActive: true,
        lastCheckedTime: 0,
        addedAt: new Date(),
      }
    : {
        wallet: wallet,
        label: label || wallet.slice(0, 10) + '...',
        isActive: true,
        isTracking: true,
        addedAt: new Date(),
      };

  await col.insertOne(doc);
  console.log(`Added ${wallet} to ${protocol} index`);
  if (label) {
    console.log(`Label: ${label}`);
  }
}

// List all tracked traders
async function listTraders(protocol: string) {
  const collection = COLLECTIONS[protocol as keyof typeof COLLECTIONS];
  if (!collection) {
    console.error(`Invalid protocol: ${protocol}`);
    process.exit(1);
  }

  const db = mongoose.connection.db;
  if (!db) {
    console.error('Database not connected');
    process.exit(1);
  }

  const col = db.collection(collection);
  const traders = await col.find({}).toArray();

  console.log(`\n${protocol.toUpperCase()} Tracked Traders (${traders.length}):`);
  console.log('='.repeat(80));

  if (traders.length === 0) {
    console.log('No traders tracked yet.');
    return;
  }

  for (const trader of traders) {
    const wallet = protocol === 'hyperliquid' ? trader.walletAddress : trader.wallet;
    const isActive = trader.isActive ? '✓' : '✗';
    const label = trader.label || 'No label';
    const addedAt = trader.addedAt ? new Date(trader.addedAt).toLocaleDateString() : 'Unknown';

    console.log(`${isActive} ${wallet}`);
    console.log(`  Label: ${label}`);
    console.log(`  Added: ${addedAt}`);
    if (trader.lastCheckedTime || trader.lastIndexedAt) {
      const lastCheck = trader.lastCheckedTime
        ? new Date(trader.lastCheckedTime).toISOString()
        : new Date(trader.lastIndexedAt).toISOString();
      console.log(`  Last indexed: ${lastCheck}`);
    }
    console.log('');
  }
}

// Remove trader from tracking
async function removeTrader(protocol: string, wallet: string) {
  const collection = COLLECTIONS[protocol as keyof typeof COLLECTIONS];
  if (!collection) {
    console.error(`Invalid protocol: ${protocol}`);
    process.exit(1);
  }

  const db = mongoose.connection.db;
  if (!db) {
    console.error('Database not connected');
    process.exit(1);
  }

  const col = db.collection(collection);
  const walletField = protocol === 'hyperliquid' ? 'walletAddress' : 'wallet';

  const result = await col.updateOne(
    { [walletField]: wallet },
    { $set: { isActive: false, isTracking: false } }
  );

  if (result.matchedCount === 0) {
    console.log(`Trader ${wallet} not found in ${protocol} index`);
  } else {
    console.log(`Removed ${wallet} from ${protocol} tracking (set isActive=false)`);
  }
}

// Main
async function main() {
  if (isHelp) {
    showHelp();
    process.exit(0);
  }

  if (!protocol) {
    console.error('Error: --protocol is required');
    showHelp();
    process.exit(1);
  }

  if (!['hyperliquid', 'polymarket'].includes(protocol)) {
    console.error(`Error: Invalid protocol "${protocol}". Use "hyperliquid" or "polymarket"`);
    process.exit(1);
  }

  await connectDB();

  try {
    if (isList) {
      await listTraders(protocol);
    } else if (isRemove) {
      if (!wallet) {
        console.error('Error: --wallet is required for remove');
        process.exit(1);
      }
      await removeTrader(protocol, wallet);
    } else {
      if (!wallet) {
        console.error('Error: --wallet is required');
        showHelp();
        process.exit(1);
      }
      await addTrader(protocol, wallet, label);
    }
  } finally {
    await mongoose.disconnect();
    console.log('\nDone.');
  }
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
