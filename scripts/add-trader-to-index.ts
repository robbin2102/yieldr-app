/**
 * Add Trader to Index
 *
 * Adds a trader wallet to be indexed by the Railway cron services.
 *
 * Usage:
 *   npx tsx scripts/add-trader-to-index.ts <protocol> <wallet> [wallets...]
 *
 * Examples:
 *   # Add single Hyperliquid trader
 *   npx tsx scripts/add-trader-to-index.ts hl 0x8af700ba841f30e0a3fcb0ee4c4a9d223e1efa05
 *
 *   # Add single Polymarket trader
 *   npx tsx scripts/add-trader-to-index.ts pm 0x2005d16a84ceefa912d4e380cd32e7ff827875ea
 *
 *   # Add multiple wallets at once
 *   npx tsx scripts/add-trader-to-index.ts hl 0xwallet1 0xwallet2 0xwallet3
 *
 *   # List all indexed traders
 *   npx tsx scripts/add-trader-to-index.ts list
 *
 *   # Remove a trader
 *   npx tsx scripts/add-trader-to-index.ts remove hl 0xwallet
 */

import dotenv from 'dotenv';
import mongoose from 'mongoose';
import path from 'path';

// Load environment
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

import MonitoredWallet from '../models/MonitoredWallet';
import { TraderProfile } from '../models/TraderProfile';

async function connectDB() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('ERROR: MONGODB_URI not set in .env.local');
    process.exit(1);
  }
  await mongoose.connect(mongoUri);
  console.log('Connected to MongoDB\n');
}

async function addHyperliquidTrader(walletAddress: string) {
  const normalized = walletAddress.toLowerCase();

  const result = await MonitoredWallet.findOneAndUpdate(
    { walletAddress: normalized, market: 'PERP', platform: 'HYPERLIQUID' },
    {
      walletAddress: normalized,
      market: 'PERP',
      platform: 'HYPERLIQUID',
      status: 'active',
      monitorInterval: 300000, // 5 minutes
      lastChecked: new Date(0),
      nextCheck: new Date()
    },
    { upsert: true, new: true }
  );

  console.log(`✅ Added HL trader: ${normalized}`);
  return result;
}

async function addPolymarketTrader(walletAddress: string) {
  const normalized = walletAddress.toLowerCase();

  // Create a minimal profile to mark for indexing
  const result = await TraderProfile.findOneAndUpdate(
    { wallet: normalized },
    {
      wallet: normalized,
      profiledAt: new Date(),
      periodDays: 30,
      // Minimal data - will be populated by indexer
      totalActivities: 0,
      buyCount: 0,
      sellCount: 0,
      redeemCount: 0,
      otherCount: 0,
      tradesPerDay: 0,
      volumeLabel: 'LOW',
      buyRatio: 0,
      strategyLabel: 'BUY_AND_HOLD',
      closedPositionsCount: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      grossProfit: 0,
      grossLoss: 0,
      netPnl: 0,
      profitFactor: 0,
      openPositionsCount: 0,
      openValue: 0,
      unrealizedPnl: 0,
      avgTradeSize: 0,
      medianTradeSize: 0,
      maxTradeSize: 0,
      label: 'PENDING_INDEX'
    },
    { upsert: true, new: true }
  );

  console.log(`✅ Added PM trader: ${normalized}`);
  return result;
}

async function removeTrader(protocol: string, walletAddress: string) {
  const normalized = walletAddress.toLowerCase();

  if (protocol === 'hl') {
    await MonitoredWallet.deleteOne({
      walletAddress: normalized,
      market: 'PERP',
      platform: 'HYPERLIQUID'
    });
    console.log(`🗑️  Removed HL trader: ${normalized}`);
  } else if (protocol === 'pm') {
    await TraderProfile.deleteOne({ wallet: normalized });
    console.log(`🗑️  Removed PM trader: ${normalized}`);
  }
}

async function listTraders() {
  console.log('═'.repeat(60));
  console.log('       INDEXED TRADERS');
  console.log('═'.repeat(60));

  // Hyperliquid traders
  const hlTraders = await MonitoredWallet.find({
    market: 'PERP',
    platform: 'HYPERLIQUID',
    status: 'active'
  });

  console.log(`\n📊 HYPERLIQUID TRADERS (${hlTraders.length}):`);
  if (hlTraders.length === 0) {
    console.log('   (none)');
  } else {
    hlTraders.forEach((t, i) => {
      console.log(`   ${i + 1}. ${t.walletAddress}`);
    });
  }

  // Polymarket traders
  const pmTraders = await TraderProfile.find({}, { wallet: 1, winRate: 1, netPnl: 1 });

  console.log(`\n📊 POLYMARKET TRADERS (${pmTraders.length}):`);
  if (pmTraders.length === 0) {
    console.log('   (none)');
  } else {
    pmTraders.forEach((t: any, i: number) => {
      const winRate = t.winRate ? `${t.winRate.toFixed(1)}%` : 'N/A';
      const pnl = t.netPnl ? `$${t.netPnl.toFixed(2)}` : 'N/A';
      console.log(`   ${i + 1}. ${t.wallet} | WR: ${winRate} | PnL: ${pnl}`);
    });
  }

  console.log('\n' + '═'.repeat(60));
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Usage:');
    console.log('  npx tsx scripts/add-trader-to-index.ts <protocol> <wallet> [wallets...]');
    console.log('  npx tsx scripts/add-trader-to-index.ts list');
    console.log('  npx tsx scripts/add-trader-to-index.ts remove <protocol> <wallet>');
    console.log('');
    console.log('Protocols: hl (Hyperliquid), pm (Polymarket)');
    console.log('');
    console.log('Examples:');
    console.log('  npx tsx scripts/add-trader-to-index.ts hl 0x8af700ba841f30e0a3fcb0ee4c4a9d223e1efa05');
    console.log('  npx tsx scripts/add-trader-to-index.ts pm 0x2005d16a84ceefa912d4e380cd32e7ff827875ea');
    console.log('  npx tsx scripts/add-trader-to-index.ts list');
    process.exit(1);
  }

  await connectDB();

  const command = args[0].toLowerCase();

  if (command === 'list') {
    await listTraders();
  } else if (command === 'remove') {
    const protocol = args[1]?.toLowerCase();
    const wallet = args[2];

    if (!protocol || !wallet) {
      console.error('Usage: npx tsx scripts/add-trader-to-index.ts remove <protocol> <wallet>');
      process.exit(1);
    }

    await removeTrader(protocol, wallet);
  } else if (command === 'hl' || command === 'pm') {
    const protocol = command;
    const wallets = args.slice(1);

    if (wallets.length === 0) {
      console.error('Please provide at least one wallet address');
      process.exit(1);
    }

    console.log(`Adding ${wallets.length} ${protocol.toUpperCase()} trader(s)...\n`);

    for (const wallet of wallets) {
      if (protocol === 'hl') {
        await addHyperliquidTrader(wallet);
      } else {
        await addPolymarketTrader(wallet);
      }
    }

    console.log(`\n✅ Done! Added ${wallets.length} trader(s)`);
  } else {
    console.error(`Unknown command: ${command}`);
    console.error('Use "hl", "pm", "list", or "remove"');
    process.exit(1);
  }

  await mongoose.disconnect();
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
