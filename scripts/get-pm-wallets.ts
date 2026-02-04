#!/usr/bin/env npx tsx
/**
 * Quick script to get top polymarket wallets from existing profiles
 */
import dotenv from 'dotenv';
import path from 'path';
import mongoose from 'mongoose';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

async function main() {
  await mongoose.connect(process.env.MONGODB_URI!);
  const db = mongoose.connection.db!;

  const profiles = await db
    .collection('polymarket-traderProfiles')
    .find({})
    .sort({ netPnl: -1 })
    .limit(8)
    .project({ wallet: 1, label: 1, netPnl: 1, winRate: 1 })
    .toArray();

  console.log('\nTop 8 Polymarket Traders:\n');
  profiles.forEach((p, i) => {
    console.log(
      `${i + 1}. ${p.wallet}`
    );
    console.log(`   Label: ${p.label || 'No label'}`);
    console.log(`   PnL: $${p.netPnl?.toFixed(2) || 'N/A'} | Win Rate: ${p.winRate?.toFixed(1) || 'N/A'}%\n`);
  });

  await mongoose.disconnect();
}

main().catch(console.error);
