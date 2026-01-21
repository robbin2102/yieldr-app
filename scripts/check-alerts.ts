import { MongoClient } from 'mongodb';

async function check() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.log('MONGODB_URI not set');
    process.exit(1);
  }

  const client = new MongoClient(uri);
  await client.connect();

  const url = new URL(uri);
  const dbName = url.pathname.replace('/', '') || 'polymarket-test';
  const db = client.db(dbName);

  // Check tracked traders
  const trackedTraders = await db.collection('polymarket-trackedTraders')
    .find({ isActive: true, isTracking: true })
    .project({ wallet: 1, label: 1 })
    .toArray();
  console.log('\n=== Tracked Traders (isActive & isTracking) ===');
  console.log('Count:', trackedTraders.length);
  trackedTraders.forEach(t => console.log('  -', t.label || t.wallet));

  // Check alerts count
  const alertsCount = await db.collection('polymarket-tradeAlerts').countDocuments({});
  console.log('\n=== Trade Alerts Count ===');
  console.log('Total alerts:', alertsCount);

  // Sample alert
  if (alertsCount > 0) {
    const sampleAlert = await db.collection('polymarket-tradeAlerts').findOne({});
    console.log('\n=== Sample Alert Structure ===');
    console.log(Object.keys(sampleAlert || {}));
  }

  // Get wallets from tracked traders
  const wallets = trackedTraders.map(t => t.wallet.toLowerCase());

  // Check if we have alerts for these wallets
  if (wallets.length > 0) {
    const matchingAlerts = await db.collection('polymarket-tradeAlerts')
      .countDocuments({ traderWallet: { $in: wallets } });
    console.log('\n=== Alerts for Tracked Traders ===');
    console.log('Count:', matchingAlerts);
  }

  await client.close();
}

check().catch(console.error);
