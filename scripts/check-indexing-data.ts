/**
 * Check MongoDB data from indexing
 * Verifies market and holder data before bulk profiling
 */

import 'dotenv/config';
import mongoose from 'mongoose';

// Import models
import PolyMarket from '../models/PolyMarket';
import PolyMarketHolder from '../models/PolyMarketHolder';

async function checkIndexingData() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('              POLYMARKET INDEXING DATA CHECK                    ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Connect to MongoDB
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('ERROR: MONGODB_URI not found in environment');
    process.exit(1);
  }

  await mongoose.connect(mongoUri);
  console.log('Connected to MongoDB\n');

  try {
    // 1. Check PolyMarket collection
    console.log('─── POLYMARKET COLLECTION ───');
    const totalMarkets = await PolyMarket.countDocuments();
    const marketsWithHolders = await PolyMarket.countDocuments({ holdersIndexed: true });
    const activeMarkets = await PolyMarket.countDocuments({ active: true });
    const closedMarkets = await PolyMarket.countDocuments({ closed: true });

    console.log(`Total markets:           ${totalMarkets.toLocaleString()}`);
    console.log(`Markets with holders:    ${marketsWithHolders.toLocaleString()}`);
    console.log(`Active markets:          ${activeMarkets.toLocaleString()}`);
    console.log(`Closed markets:          ${closedMarkets.toLocaleString()}`);

    // Categories breakdown
    const categories = await PolyMarket.aggregate([
      { $group: { _id: '$category', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 }
    ]);
    console.log('\nTop 10 Categories:');
    categories.forEach((cat, i) => {
      console.log(`  ${i + 1}. ${cat._id || 'Unknown'}: ${cat.count}`);
    });

    // 2. Check PolyMarketHolder collection
    console.log('\n─── POLYMARKETHOLDER COLLECTION ───');
    const totalHolderRecords = await PolyMarketHolder.countDocuments();
    console.log(`Total holder records:    ${totalHolderRecords.toLocaleString()}`);

    // Get unique wallets count using aggregation
    const uniqueWalletsResult = await PolyMarketHolder.aggregate([
      { $unwind: '$holders' },
      { $group: { _id: { $toLower: '$holders.proxyWallet' } } },
      { $count: 'total' }
    ]);
    const uniqueWallets = uniqueWalletsResult[0]?.total || 0;
    console.log(`Unique trader wallets:   ${uniqueWallets.toLocaleString()}`);

    // Total holders across all records
    const totalHoldersResult = await PolyMarketHolder.aggregate([
      { $unwind: '$holders' },
      { $count: 'total' }
    ]);
    const totalHolders = totalHoldersResult[0]?.total || 0;
    console.log(`Total holder entries:    ${totalHolders.toLocaleString()}`);

    // Sample holder record
    const sampleHolder = await PolyMarketHolder.findOne().lean();
    if (sampleHolder) {
      console.log('\nSample Holder Record:');
      console.log(`  Market:     ${sampleHolder.marketQuestion?.substring(0, 50)}...`);
      console.log(`  Token:      ${sampleHolder.tokenId?.substring(0, 20)}...`);
      console.log(`  Outcome:    ${sampleHolder.outcome}`);
      console.log(`  # Holders:  ${sampleHolder.holders?.length || 0}`);
      console.log(`  Top Holder: ${sampleHolder.topHolderWallet?.substring(0, 20)}... ($${sampleHolder.topHolderAmount?.toLocaleString()})`);
    }

    // 3. Top holders by total amount across all markets
    console.log('\n─── TOP 10 HOLDERS BY TOTAL AMOUNT ───');
    const topHolders = await PolyMarketHolder.aggregate([
      { $unwind: '$holders' },
      {
        $group: {
          _id: { $toLower: '$holders.proxyWallet' },
          totalAmount: { $sum: '$holders.amount' },
          marketCount: { $sum: 1 },
          name: { $first: '$holders.name' },
          pseudonym: { $first: '$holders.pseudonym' },
        }
      },
      { $sort: { totalAmount: -1 } },
      { $limit: 10 }
    ]);

    topHolders.forEach((h, i) => {
      const displayName = h.name || h.pseudonym || h._id.substring(0, 16) + '...';
      console.log(`  ${i + 1}. ${displayName}`);
      console.log(`     Wallet: ${h._id.substring(0, 20)}...`);
      console.log(`     Total:  $${h.totalAmount.toLocaleString()} across ${h.marketCount} markets`);
    });

    // 4. Check for existing trader profiles
    console.log('\n─── EXISTING TRADER PROFILES ───');
    const db = mongoose.connection.db;
    if (db) {
      const profilesCollection = db.collection('polymarket-traderProfiles');
      const existingProfiles = await profilesCollection.countDocuments();
      console.log(`Existing profiles:       ${existingProfiles.toLocaleString()}`);

      if (existingProfiles > 0) {
        console.log(`Traders to profile:      ${(uniqueWallets - existingProfiles).toLocaleString()} remaining`);
      } else {
        console.log(`Traders to profile:      ${uniqueWallets.toLocaleString()} (all)`);
      }
    }

    // Summary
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('                         SUMMARY                               ');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`Markets indexed:         ${totalMarkets.toLocaleString()}`);
    console.log(`Unique traders found:    ${uniqueWallets.toLocaleString()}`);
    console.log(`Ready for bulk-profile:  ${uniqueWallets > 0 ? 'YES ✓' : 'NO - Run indexing first'}`);
    console.log('═══════════════════════════════════════════════════════════════\n');

  } catch (error) {
    console.error('Error checking data:', error);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
  }
}

checkIndexingData().catch(console.error);
