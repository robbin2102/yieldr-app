/**
 * Test MongoDB connection and show data counts + last 5 records
 */
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config({ path: '.env.local' });

async function testMongo() {
  const uri = process.env.MONGODB_URI;

  if (!uri) {
    console.log('ERROR: MONGODB_URI not found in .env.local');
    process.exit(1);
  }

  console.log('\n🟢 Connecting to MongoDB...');
  await mongoose.connect(uri);
  console.log('   ✅ Connected!\n');

  const db = mongoose.connection.db;
  if (!db) {
    console.log('ERROR: Could not get database reference');
    process.exit(1);
  }

  // List all collections with counts
  const collections = await db.listCollections().toArray();
  console.log('📁 ALL COLLECTIONS (' + collections.length + ' total):');

  for (const col of collections.sort((a, b) => a.name.localeCompare(b.name))) {
    const count = await db.collection(col.name).countDocuments();
    console.log('   ' + col.name.padEnd(35) + count + ' docs');
  }

  // === POLYMARKET LAST 5 ===
  console.log('\n📌 LAST 5 POLYMARKET TRADES:');
  const polyTrades = await db.collection('polymarket-trades').find({}).sort({ timestamp: -1 }).limit(5).toArray();
  if (polyTrades.length === 0) {
    console.log('   (no trades found)');
  } else {
    polyTrades.forEach((t: any, i: number) => {
      const date = t.timestamp ? new Date(t.timestamp * 1000).toISOString().slice(0, 16) : 'N/A';
      const side = (t.side || '?').padEnd(4);
      const size = (t.usdcSize?.toFixed(2) || '0').padStart(8);
      const title = (t.title?.substring(0, 35) || 'N/A');
      console.log(`   ${i + 1}. [${date}] ${side} $${size} | ${title}...`);
    });
  }

  // === HYPERLIQUID LAST 5 ===
  console.log('\n📌 LAST 5 HYPERLIQUID FILLS:');
  const hlFills = await db.collection('hyperliquidfills').find({}).sort({ time: -1 }).limit(5).toArray();
  if (hlFills.length === 0) {
    console.log('   (no fills found)');
  } else {
    hlFills.forEach((f: any, i: number) => {
      const date = f.time ? new Date(f.time).toISOString().slice(0, 16) : 'N/A';
      const side = (f.side || '?').padEnd(5);
      const coin = (f.coin || '?').padEnd(6);
      const sz = String(f.sz || '0').padStart(8);
      const px = f.px || '0';
      console.log(`   ${i + 1}. [${date}] ${side} ${coin} sz:${sz} @ $${px}`);
    });
  }

  // === HYPERLIQUID METRICS ===
  console.log('\n📌 HYPERLIQUID METRICS:');
  const hlMetrics = await db.collection('hyperliquidmetrics').find({}).limit(5).toArray();
  if (hlMetrics.length === 0) {
    console.log('   (no metrics found)');
  } else {
    hlMetrics.forEach((m: any, i: number) => {
      console.log(`   ${i + 1}. Wallet: ${m.wallet?.substring(0, 10)}... | WinRate: ${m.winRate?.toFixed(1)}% | PnL: $${m.pnl?.allTime?.toFixed(2) || 'N/A'}`);
    });
  }

  // === POLYMARKET PROFILES ===
  console.log('\n📌 POLYMARKET TRADER PROFILES:');
  const profiles = await db.collection('traderprofiles').find({}).limit(5).toArray();
  if (profiles.length === 0) {
    console.log('   (no profiles found)');
  } else {
    profiles.forEach((p: any, i: number) => {
      console.log(`   ${i + 1}. Wallet: ${p.wallet?.substring(0, 10)}... | WinRate: ${p.winRate?.toFixed(1)}% | NetPnL: $${p.netPnl?.toFixed(2) || 'N/A'}`);
    });
  }

  await mongoose.disconnect();
  console.log('\n✅ MongoDB test complete');
}

testMongo().catch(e => {
  console.error('❌ FAILED:', e.message);
  process.exit(1);
});
