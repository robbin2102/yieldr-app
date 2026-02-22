#!/usr/bin/env ts-node

/**
 * Test Trader Profiler
 * Uses the same connection method as the working API
 */

import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local', override: true });

import { MongoClient } from 'mongodb';

const API_BASE = 'https://data-api.polymarket.com';

// Extract database name from URI (same logic as lib/mongodb.ts)
function extractDbName(mongoUri: string): string {
  try {
    const url = new URL(mongoUri);
    const dbName = url.pathname.replace('/', '');
    return dbName || 'polymarket-test';
  } catch {
    const match = mongoUri.match(/\/([^/?]+)(\?|$)/);
    return match?.[1] || 'polymarket-test';
  }
}

async function main() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('MONGODB_URI not found');
    process.exit(1);
  }

  const dbName = extractDbName(mongoUri);
  console.log('MongoDB URI:', mongoUri.replace(/:[^:@]+@/, ':****@'));
  console.log('Database name extracted:', dbName);

  const client = new MongoClient(mongoUri);
  await client.connect();
  console.log('Connected to MongoDB\n');

  const db = client.db(dbName);

  // List all collections
  console.log('Collections in', dbName + ':');
  const collections = await db.listCollections().toArray();
  collections.forEach(c => console.log('  -', c.name));

  // Check polyMarketHolders
  console.log('\nChecking polyMarketHolders collection...');
  const holdersCount = await db.collection('polyMarketHolders').countDocuments();
  console.log('polyMarketHolders count:', holdersCount);

  // Try aggregation
  console.log('\nRunning aggregation...');
  const pipeline = [
    { $unwind: '$holders' },
    { $group: { _id: { $toLower: '$holders.proxyWallet' } } },
    { $count: 'total' }
  ];
  const result = await db.collection('polyMarketHolders').aggregate(pipeline).toArray();
  console.log('Unique traders:', result[0]?.total || 0);

  // Also check yieldr database directly
  console.log('\n--- Checking yieldr database directly ---');
  const yieldrDb = client.db('yieldr');
  const yieldrCollections = await yieldrDb.listCollections().toArray();
  console.log('Collections in yieldr:');
  yieldrCollections.forEach(c => console.log('  -', c.name));

  const yieldrHoldersCount = await yieldrDb.collection('polyMarketHolders').countDocuments();
  console.log('\nyieldr.polyMarketHolders count:', yieldrHoldersCount);

  await client.close();
  console.log('\nDone');
}

main().catch(console.error);
