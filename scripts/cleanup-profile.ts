/**
 * Cleanup Profile Data - Delete stale profile to force re-profile
 *
 * Usage:
 *   npx tsx scripts/cleanup-profile.ts <wallet>           # Show profile data
 *   npx tsx scripts/cleanup-profile.ts <wallet> --delete  # Delete and re-profile
 */

import mongoose from 'mongoose';

async function main() {
  // Load env
  const dotenv = await import('dotenv');
  const path = await import('path');
  const envLocations = [
    path.resolve(process.cwd(), '.env.local'),
    path.resolve(process.cwd(), '.env'),
  ];
  for (const envPath of envLocations) {
    const result = dotenv.config({ path: envPath });
    if (!result.error && process.env.MONGODB_URI) break;
  }

  const args = process.argv.slice(2);
  const wallet = args.find(a => a.startsWith('0x'))?.toLowerCase();
  const shouldDelete = args.includes('--delete');

  if (!wallet) {
    console.log('Usage: npx tsx scripts/cleanup-profile.ts <wallet> [--delete]');
    console.log('\nExamples:');
    console.log('  npx tsx scripts/cleanup-profile.ts 0x1bc0d88ca86b9049cf05d642e634836d5ddf4429');
    console.log('  npx tsx scripts/cleanup-profile.ts 0x1bc0d88ca86b9049cf05d642e634836d5ddf4429 --delete');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI!);
  const db = mongoose.connection.db!;

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('                    PROFILE DATA CHECK                          ');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`Wallet: ${wallet}\n`);

  // Check profile data
  const profile = await db.collection('polymarket-traderProfiles').findOne({ wallet });

  if (!profile) {
    console.log('No profile found for this wallet.\n');
    await mongoose.connection.close();
    return;
  }

  console.log('=== CACHED PROFILE DATA ===');
  console.log(`Label: ${profile.label}`);
  console.log(`Profiled At: ${profile.profiledAt}`);
  console.log(`Period: ${profile.periodDays} days`);
  console.log(`Win Rate: ${profile.winRate?.toFixed(1)}%`);
  console.log(`Net P&L: $${profile.netPnl?.toLocaleString()}`);
  console.log('');

  console.log('=== TOP OPEN POSITIONS (cached) ===');
  console.log(`Count: ${profile.topOpenPositions?.length || 0}`);
  if (profile.topOpenPositions?.length > 0) {
    profile.topOpenPositions.slice(0, 5).forEach((p: any, i: number) => {
      console.log(`  ${i + 1}. ${p.outcome} - ${p.title?.substring(0, 50)}...`);
      console.log(`     Price: ${(p.curPrice * 100).toFixed(0)}¢, Value: $${p.currentValue?.toFixed(2)}`);
    });
    if (profile.topOpenPositions.length > 5) {
      console.log(`  ... and ${profile.topOpenPositions.length - 5} more`);
    }
  }
  console.log('');

  console.log('=== RECENT CLOSED POSITIONS (cached) ===');
  console.log(`Count: ${profile.recentClosedPositions?.length || 0}`);
  if (profile.recentClosedPositions?.length > 0) {
    profile.recentClosedPositions.slice(0, 5).forEach((p: any, i: number) => {
      console.log(`  ${i + 1}. [${p.status}] ${p.outcome} - ${p.title?.substring(0, 40)}...`);
      console.log(`     P&L: $${p.realizedPnl?.toFixed(2)}`);
    });
  }
  console.log('');

  // Check openPositions collection (from refresh-positions API)
  const openPos = await db.collection('polymarket-openPositions')
    .find({ walletAddress: wallet })
    .sort({ currentValue: -1 })
    .toArray();

  console.log('=== LIVE POSITIONS (from refresh-positions) ===');
  console.log(`Count: ${openPos.length}`);
  if (openPos.length > 0) {
    openPos.slice(0, 5).forEach((p: any, i: number) => {
      console.log(`  ${i + 1}. ${p.outcome} - ${p.title?.substring(0, 50)}...`);
      console.log(`     Price: ${(p.curPrice * 100).toFixed(0)}¢, Value: $${p.currentValue?.toFixed(2)}`);
    });
    if (openPos.length > 5) {
      console.log(`  ... and ${openPos.length - 5} more`);
    }
  }
  console.log('');

  // Compare
  console.log('=== COMPARISON ===');
  const cachedCount = profile.topOpenPositions?.length || 0;
  const liveCount = openPos.length;
  if (cachedCount !== liveCount) {
    console.log(`MISMATCH: Cached has ${cachedCount} positions, Live has ${liveCount}`);
  } else {
    console.log(`Counts match: ${cachedCount} positions`);
  }
  console.log('');

  if (shouldDelete) {
    console.log('=== DELETING STALE DATA ===');

    // Delete profile
    await db.collection('polymarket-traderProfiles').deleteOne({ wallet });
    console.log('Deleted profile from polymarket-traderProfiles');

    // Delete cached positions
    await db.collection('polymarket-openPositions').deleteMany({ walletAddress: wallet });
    console.log('Deleted positions from polymarket-openPositions');

    console.log('\nDone! Now re-profile this trader in the UI or run:');
    console.log(`  curl -X POST http://localhost:3000/api/copy-trading/profile-trader \\`);
    console.log(`    -H "Content-Type: application/json" \\`);
    console.log(`    -d '{"wallet": "${wallet}", "label": "${profile.label}"}'`);
  } else {
    console.log('To delete stale data and force re-profile, run with --delete flag:');
    console.log(`  npx tsx scripts/cleanup-profile.ts ${wallet} --delete`);
  }

  console.log('\n═══════════════════════════════════════════════════════════════\n');
  await mongoose.connection.close();
}

main().catch(console.error);
