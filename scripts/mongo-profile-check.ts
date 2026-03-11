/**
 * Mongo Profile Check - Count profiled traders and sample a few
 *
 * Usage:
 *   npx tsx scripts/mongo-profile-check.ts
 *   npx tsx scripts/mongo-profile-check.ts --sample=10
 */

import mongoose from 'mongoose';

async function main() {
  const dotenv = await import('dotenv');
  const path = await import('path');
  for (const envPath of [path.resolve(process.cwd(), '.env.local'), path.resolve(process.cwd(), '.env')]) {
    const result = dotenv.config({ path: envPath });
    if (!result.error && process.env.MONGODB_URI) break;
  }

  await mongoose.connect(process.env.MONGODB_URI!);
  const db = mongoose.connection.db!;

  const args = process.argv.slice(2);
  const sampleArg = args.find(a => a.startsWith('--sample='));
  const sampleSize = sampleArg ? parseInt(sampleArg.split('=')[1]) : 5;

  const profiles = db.collection('polymarket-traderProfiles');
  const holders = db.collection('polyMarketHolders');

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('               TRADER PROFILE MONGO CHECK                       ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Counts
  const totalProfiled = await profiles.countDocuments();
  const totalHolders = await holders.countDocuments();
  const remaining = totalHolders - totalProfiled;

  console.log(`📦 polyMarketHolders (source):     ${totalHolders.toLocaleString()}`);
  console.log(`✅ polymarket-traderProfiles:      ${totalProfiled.toLocaleString()}`);
  console.log(`⏳ Remaining to profile:           ${remaining.toLocaleString()}`);
  console.log(`   Progress: ${((totalProfiled / totalHolders) * 100).toFixed(1)}%\n`);

  // Breakdown by insider_probability
  const insiderBreakdown = await profiles.aggregate([
    { $group: { _id: '$insider_probability', count: { $sum: 1 } } },
    { $sort: { count: -1 } }
  ]).toArray();

  console.log('Insider probability breakdown:');
  for (const b of insiderBreakdown) {
    console.log(`  ${(b._id ?? 'unknown').padEnd(10)} ${b.count.toLocaleString()}`);
  }

  // Breakdown by capital_trend
  const capitalBreakdown = await profiles.aggregate([
    { $group: { _id: '$capital_trend', count: { $sum: 1 } } },
    { $sort: { count: -1 } }
  ]).toArray();

  console.log('\nCapital trend breakdown:');
  for (const b of capitalBreakdown) {
    console.log(`  ${(b._id ?? 'null').padEnd(15)} ${b.count.toLocaleString()}`);
  }

  // Recent profiles
  const recentProfiles = await profiles
    .find({})
    .sort({ profiledAt: -1 })
    .limit(3)
    .project({ wallet: 1, profiledAt: 1, win_rate: 1, insider_probability: 1, capital_trend: 1, label: 1 })
    .toArray();

  console.log('\nMost recently profiled:');
  for (const p of recentProfiles) {
    const ago = p.profiledAt ? Math.round((Date.now() - new Date(p.profiledAt).getTime()) / 1000 / 60) : null;
    console.log(`  ${p.wallet} | wr:${p.win_rate?.toFixed(1) ?? 'n/a'}% | insider:${p.insider_probability ?? 'n/a'} | capital:${p.capital_trend ?? 'n/a'} | ${ago != null ? ago + 'm ago' : 'no date'}`);
  }

  // Sample N profiles
  console.log(`\n════ Sample ${sampleSize} random profiles ════\n`);
  const sample = await profiles.aggregate([
    { $sample: { size: sampleSize } },
    {
      $project: {
        wallet: 1,
        win_rate: 1,
        win_rate_sample_size: 1,
        profitFactor: 1,
        insider_probability: 1,
        insider_score: 1,
        capital_trend: 1,
        drawdown_trend: 1,
        label: 1,
        specialty: 1,
        profiledAt: 1,
        'timeframePnL.30d.roce': 1,
        avg_bet_size_usdc: 1,
      }
    }
  ]).toArray();

  for (const p of sample) {
    const roce = p.timeframePnL?.['30d']?.roce;
    console.log(`wallet:    ${p.wallet}`);
    console.log(`label:     ${p.label ?? 'n/a'}  |  specialty: ${p.specialty ?? 'n/a'}`);
    console.log(`wr:        ${p.win_rate?.toFixed(1) ?? 'n/a'}%  (n=${p.win_rate_sample_size ?? '?'})`);
    console.log(`pf:        ${p.profitFactor?.toFixed(2) ?? 'n/a'}  |  roce(30d): ${roce != null ? (roce * 100).toFixed(1) + '%' : 'n/a'}`);
    console.log(`capital:   ${p.capital_trend ?? 'n/a'}  |  drawdown: ${p.drawdown_trend ?? 'n/a'}`);
    console.log(`insider:   ${p.insider_probability ?? 'n/a'} (score: ${p.insider_score ?? 'n/a'})`);
    console.log(`avg_bet:   $${p.avg_bet_size_usdc?.toFixed(0) ?? 'n/a'} USDC`);
    console.log(`profiled:  ${p.profiledAt ? new Date(p.profiledAt).toISOString().slice(0, 16) : 'n/a'}`);
    console.log('─'.repeat(60));
  }

  await mongoose.connection.close();
}

main().catch(err => { console.error(err); process.exit(1); });
