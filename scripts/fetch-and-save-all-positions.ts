/**
 * Clean Script: Fetch and Save ALL Closed Positions
 *
 * This script:
 * 1. Clears existing closed positions
 * 2. Fetches ALL positions from API
 * 3. Saves them to MongoDB WITHOUT upsert (insert only)
 * 4. Verifies all positions were saved
 */

import dotenv from 'dotenv';
import path from 'path';
import { randomUUID } from 'crypto';

const envPath = path.resolve(process.cwd(), '.env.local');
dotenv.config({ path: envPath });

import connectDB from '../lib/mongoose.js';
import { fetchClosedPositions } from '../services/polymarket-tracker/api/closedPositions.js';
import PolymarketClosedPosition from '../models/PolymarketClosedPosition.js';

const WALLET = '0xecd55daa7c6900683b804d1d4db935fbfabe43f4';

async function main() {
  console.log('\n' + '='.repeat(80));
  console.log('🔄 FETCH AND SAVE ALL CLOSED POSITIONS');
  console.log('='.repeat(80) + '\n');

  await connectDB();

  try {
    // ========================================================================
    // STEP 1: CLEAR EXISTING DATA
    // ========================================================================
    console.log('🗑️  STEP 1: Clearing existing positions...\n');

    const deleteResult = await PolymarketClosedPosition.deleteMany({
      walletAddress: WALLET.toLowerCase()
    });

    console.log(`✅ Deleted ${deleteResult.deletedCount} old positions\n`);

    // ========================================================================
    // STEP 2: FETCH FROM API
    // ========================================================================
    console.log('📡 STEP 2: Fetching from API...\n');

    const apiPositions = await fetchClosedPositions(WALLET, 30);

    console.log(`✅ Fetched ${apiPositions.length} positions from API\n`);

    if (apiPositions.length === 0) {
      console.log('No positions to save\n');
      process.exit(0);
    }

    // Show date range
    const timestamps = apiPositions.map(p => p.timestamp);
    const oldest = Math.min(...timestamps);
    const newest = Math.max(...timestamps);
    console.log(`📅 Date Range:`);
    console.log(`   Oldest: ${new Date(oldest * 1000).toISOString()}`);
    console.log(`   Newest: ${new Date(newest * 1000).toISOString()}\n`);

    // ========================================================================
    // STEP 3: PREPARE DOCUMENTS (NO UPSERT - JUST INSERT)
    // ========================================================================
    console.log('💾 STEP 3: Preparing documents...\n');

    const documents = apiPositions.map((pos) => {
      const totalBet = pos.avgPrice * pos.totalBought;
      const amountWon = totalBet + pos.realizedPnl;
      const roi = totalBet > 0 ? (pos.realizedPnl / totalBet) * 100 : 0;

      // Generate a random UUID for guaranteed uniqueness
      const tradeId = randomUUID();

      return {
        tradeId,
        walletAddress: WALLET.toLowerCase(),
        conditionId: pos.conditionId,
        asset: pos.asset,
        title: pos.title,
        slug: pos.slug,
        outcome: pos.outcome,
        outcomeIndex: pos.outcomeIndex,
        totalBought: pos.totalBought,
        avgPrice: pos.avgPrice,
        realizedPnl: pos.realizedPnl,
        totalBet,
        amountWon,
        roi,
        won: pos.realizedPnl > 0,
        closedAt: new Date(pos.timestamp * 1000),
        endDate: pos.endDate ? new Date(pos.endDate) : undefined,
        fetchedAt: new Date(),
        createdAt: new Date(),
      };
    });

    console.log(`✅ Prepared ${documents.length} documents\n`);

    // ========================================================================
    // STEP 4: INSERT ALL (NOT UPSERT)
    // ========================================================================
    console.log('💾 STEP 4: Saving to MongoDB...\n');

    const insertResult = await PolymarketClosedPosition.insertMany(documents, {
      ordered: false, // Continue on duplicate key errors
    });

    console.log(`✅ Inserted ${insertResult.length} positions\n`);

    // ========================================================================
    // STEP 5: VERIFY
    // ========================================================================
    console.log('🔍 STEP 5: Verifying...\n');

    const savedCount = await PolymarketClosedPosition.countDocuments({
      walletAddress: WALLET.toLowerCase()
    });

    console.log('📊 VERIFICATION:');
    console.log('─'.repeat(80));
    console.log(`API returned:     ${apiPositions.length} positions`);
    console.log(`MongoDB saved:    ${savedCount} positions`);
    console.log(`Match:            ${apiPositions.length === savedCount ? '✅ YES' : '❌ NO'}`);
    console.log('─'.repeat(80) + '\n');

    // Calculate total PnL
    const allSaved = await PolymarketClosedPosition.find({
      walletAddress: WALLET.toLowerCase()
    }).lean();

    const totalPnL = allSaved.reduce((sum, p) => sum + p.realizedPnl, 0);
    const totalBet = allSaved.reduce((sum, p) => sum + p.totalBet, 0);
    const roi = totalBet > 0 ? (totalPnL / totalBet) * 100 : 0;

    console.log('💰 TOTAL PNL:');
    console.log('─'.repeat(80));
    console.log(`Total Bet:        $${totalBet.toFixed(2)}`);
    console.log(`Total PnL:        $${totalPnL.toFixed(2)}`);
    console.log(`ROI:              ${roi.toFixed(2)}%`);
    console.log('─'.repeat(80) + '\n');

    // Time-based PnL
    const now = Math.floor(Date.now() / 1000);
    const cutoff1d = now - (24 * 60 * 60);
    const cutoff7d = now - (7 * 24 * 60 * 60);

    const pnl1d = allSaved
      .filter(p => Math.floor(new Date(p.closedAt).getTime() / 1000) >= cutoff1d)
      .reduce((sum, p) => sum + p.realizedPnl, 0);

    const pnl7d = allSaved
      .filter(p => Math.floor(new Date(p.closedAt).getTime() / 1000) >= cutoff7d)
      .reduce((sum, p) => sum + p.realizedPnl, 0);

    console.log('📊 TIME-BASED PNL:');
    console.log('─'.repeat(80));
    console.log(`1d  (last 24h):   $${pnl1d.toFixed(2)}`);
    console.log(`7d  (last 7d):    $${pnl7d.toFixed(2)}`);
    console.log(`30d (last 30d):   $${totalPnL.toFixed(2)}`);
    console.log('─'.repeat(80) + '\n');

    if (apiPositions.length === savedCount) {
      console.log('✅ SUCCESS! All positions saved correctly.\n');
    } else {
      console.log('❌ MISMATCH! Some positions were not saved.\n');
      console.log(`Missing: ${apiPositions.length - savedCount} positions\n`);
    }

    console.log('='.repeat(80) + '\n');

    process.exit(0);
  } catch (error: any) {
    console.error('\n❌ ERROR:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main();
