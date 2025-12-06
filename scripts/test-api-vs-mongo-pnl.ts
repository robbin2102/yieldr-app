/**
 * Test Script: Compare API vs MongoDB PnL
 *
 * This script fetches ALL closed positions directly from the API
 * and calculates PnL for 1d, 7d, 30d to compare with MongoDB data.
 *
 * Purpose: Determine if we're missing closed positions in MongoDB
 */

import '../services/polymarket-tracker/config/database';
import { fetchClosedPositions } from '../services/polymarket-tracker/api/closedPositions';
import PolymarketClosedPosition from '../models/PolymarketClosedPosition';

const TEST_WALLET = '0xecd55daa7c6900683b804d1d4db935fbfabe43f4';

interface TimeBasedPnL {
  positions: number;
  totalPnL: number;
  totalBet: number;
  totalWon: number;
  roi: number;
}

/**
 * Calculate PnL from a list of positions
 */
function calculatePnL(positions: any[], label: string): TimeBasedPnL {
  const totalPnL = positions.reduce((sum, p) => sum + p.realizedPnl, 0);
  const totalBet = positions.reduce((sum, p) => sum + (p.avgPrice * p.totalBought), 0);
  const totalWon = positions.reduce((sum, p) => {
    const bet = p.avgPrice * p.totalBought;
    return sum + (bet + p.realizedPnl);
  }, 0);
  const roi = totalBet > 0 ? (totalPnL / totalBet) * 100 : 0;

  return {
    positions: positions.length,
    totalPnL,
    totalBet,
    totalWon,
    roi
  };
}

/**
 * Filter positions by time period
 */
function filterByTime(positions: any[], hoursAgo: number): any[] {
  const cutoff = Math.floor(Date.now() / 1000) - (hoursAgo * 60 * 60);
  return positions.filter(p => p.timestamp >= cutoff);
}

async function main() {
  console.log('\n' + '='.repeat(80));
  console.log('🔍 API vs MONGODB PnL COMPARISON TEST');
  console.log('='.repeat(80) + '\n');

  try {
    // ========================================================================
    // PART 1: FETCH ALL CLOSED POSITIONS FROM API (30 days)
    // ========================================================================
    console.log('📡 FETCHING FROM API (30 days)...\n');

    const apiPositions30d = await fetchClosedPositions(TEST_WALLET, 30);

    console.log(`✅ Fetched ${apiPositions30d.length} positions from API\n`);

    // Show date range
    if (apiPositions30d.length > 0) {
      const timestamps = apiPositions30d.map(p => p.timestamp);
      const oldest = Math.min(...timestamps);
      const newest = Math.max(...timestamps);

      console.log(`📅 Date Range:`);
      console.log(`   Oldest: ${new Date(oldest * 1000).toISOString()}`);
      console.log(`   Newest: ${new Date(newest * 1000).toISOString()}\n`);
    }

    // ========================================================================
    // PART 2: CALCULATE PNL FROM API DATA
    // ========================================================================
    console.log('💰 CALCULATING PNL FROM API DATA...\n');

    const api1d = filterByTime(apiPositions30d, 24);
    const api7d = filterByTime(apiPositions30d, 7 * 24);
    const api30d = apiPositions30d; // Already filtered to 30 days

    const apiPnL1d = calculatePnL(api1d, '1d');
    const apiPnL7d = calculatePnL(api7d, '7d');
    const apiPnL30d = calculatePnL(api30d, '30d');

    console.log('📊 API DATA RESULTS:');
    console.log('─'.repeat(80));
    console.log(`1d  (last 24h):    ${apiPnL1d.positions} positions | PnL: $${apiPnL1d.totalPnL.toFixed(2)} | ROI: ${apiPnL1d.roi.toFixed(2)}%`);
    console.log(`7d  (last 7 days): ${apiPnL7d.positions} positions | PnL: $${apiPnL7d.totalPnL.toFixed(2)} | ROI: ${apiPnL7d.roi.toFixed(2)}%`);
    console.log(`30d (last 30 days): ${apiPnL30d.positions} positions | PnL: $${apiPnL30d.totalPnL.toFixed(2)} | ROI: ${apiPnL30d.roi.toFixed(2)}%`);
    console.log('─'.repeat(80) + '\n');

    // ========================================================================
    // PART 3: FETCH FROM MONGODB
    // ========================================================================
    console.log('💾 FETCHING FROM MONGODB...\n');

    const mongoPositions = await PolymarketClosedPosition.find({
      walletAddress: TEST_WALLET.toLowerCase()
    }).lean();

    console.log(`✅ Fetched ${mongoPositions.length} positions from MongoDB\n`);

    // Show date range
    if (mongoPositions.length > 0) {
      const timestamps = mongoPositions.map(p => Math.floor(new Date(p.closedAt).getTime() / 1000));
      const oldest = Math.min(...timestamps);
      const newest = Math.max(...timestamps);

      console.log(`📅 Date Range:`);
      console.log(`   Oldest: ${new Date(oldest * 1000).toISOString()}`);
      console.log(`   Newest: ${new Date(newest * 1000).toISOString()}\n`);
    }

    // ========================================================================
    // PART 4: CALCULATE PNL FROM MONGODB DATA
    // ========================================================================
    console.log('💰 CALCULATING PNL FROM MONGODB DATA...\n');

    // Convert MongoDB positions to API format for consistency
    const mongoAsApi = mongoPositions.map(p => ({
      timestamp: Math.floor(new Date(p.closedAt).getTime() / 1000),
      realizedPnl: p.realizedPnl,
      avgPrice: p.avgPrice,
      totalBought: p.totalBought
    }));

    const mongo1d = filterByTime(mongoAsApi, 24);
    const mongo7d = filterByTime(mongoAsApi, 7 * 24);
    const mongo30d = mongoAsApi; // All positions

    const mongoPnL1d = calculatePnL(mongo1d, '1d');
    const mongoPnL7d = calculatePnL(mongo7d, '7d');
    const mongoPnL30d = calculatePnL(mongo30d, '30d');

    console.log('📊 MONGODB RESULTS:');
    console.log('─'.repeat(80));
    console.log(`1d  (last 24h):    ${mongoPnL1d.positions} positions | PnL: $${mongoPnL1d.totalPnL.toFixed(2)} | ROI: ${mongoPnL1d.roi.toFixed(2)}%`);
    console.log(`7d  (last 7 days): ${mongoPnL7d.positions} positions | PnL: $${mongoPnL7d.totalPnL.toFixed(2)} | ROI: ${mongoPnL7d.roi.toFixed(2)}%`);
    console.log(`30d (last 30 days): ${mongoPnL30d.positions} positions | PnL: $${mongoPnL30d.totalPnL.toFixed(2)} | ROI: ${mongoPnL30d.roi.toFixed(2)}%`);
    console.log('─'.repeat(80) + '\n');

    // ========================================================================
    // PART 5: COMPARISON & ANALYSIS
    // ========================================================================
    console.log('🔍 COMPARISON & ANALYSIS');
    console.log('='.repeat(80) + '\n');

    // Position count comparison
    console.log('📊 Position Counts:');
    console.log(`   API (30d):     ${apiPnL30d.positions} positions`);
    console.log(`   MongoDB (30d): ${mongoPnL30d.positions} positions`);
    console.log(`   MISSING:       ${apiPnL30d.positions - mongoPnL30d.positions} positions (${((1 - mongoPnL30d.positions / apiPnL30d.positions) * 100).toFixed(2)}%)\n`);

    // PnL comparison
    console.log('💰 PnL Comparison:');
    console.log('─'.repeat(80));
    console.log(`Period | API PnL       | MongoDB PnL   | Difference    | % Missing`);
    console.log('─'.repeat(80));

    const diff1d = apiPnL1d.totalPnL - mongoPnL1d.totalPnL;
    const diff7d = apiPnL7d.totalPnL - mongoPnL7d.totalPnL;
    const diff30d = apiPnL30d.totalPnL - mongoPnL30d.totalPnL;

    const pct1d = apiPnL1d.totalPnL !== 0 ? ((mongoPnL1d.totalPnL / apiPnL1d.totalPnL) * 100).toFixed(2) : 'N/A';
    const pct7d = apiPnL7d.totalPnL !== 0 ? ((mongoPnL7d.totalPnL / apiPnL7d.totalPnL) * 100).toFixed(2) : 'N/A';
    const pct30d = apiPnL30d.totalPnL !== 0 ? ((mongoPnL30d.totalPnL / apiPnL30d.totalPnL) * 100).toFixed(2) : 'N/A';

    console.log(`1d     | $${apiPnL1d.totalPnL.toFixed(2).padStart(11)} | $${mongoPnL1d.totalPnL.toFixed(2).padStart(11)} | $${diff1d.toFixed(2).padStart(11)} | ${pct1d}%`);
    console.log(`7d     | $${apiPnL7d.totalPnL.toFixed(2).padStart(11)} | $${mongoPnL7d.totalPnL.toFixed(2).padStart(11)} | $${diff7d.toFixed(2).padStart(11)} | ${pct7d}%`);
    console.log(`30d    | $${apiPnL30d.totalPnL.toFixed(2).padStart(11)} | $${mongoPnL30d.totalPnL.toFixed(2).padStart(11)} | $${diff30d.toFixed(2).padStart(11)} | ${pct30d}%`);
    console.log('─'.repeat(80) + '\n');

    // ========================================================================
    // PART 6: FIND MISSING POSITIONS
    // ========================================================================
    console.log('🔎 IDENTIFYING MISSING POSITIONS...\n');

    // Create a Set of MongoDB position identifiers
    const mongoKeys = new Set(
      mongoPositions.map(p =>
        `${p.conditionId}_${Math.floor(new Date(p.closedAt).getTime() / 1000)}`
      )
    );

    // Find positions that exist in API but not in MongoDB
    const missingPositions = apiPositions30d.filter(p =>
      !mongoKeys.has(`${p.conditionId}_${p.timestamp}`)
    );

    console.log(`❌ MISSING ${missingPositions.length} positions in MongoDB:\n`);

    if (missingPositions.length > 0) {
      // Show first 10 missing positions
      const samplesToShow = Math.min(10, missingPositions.length);
      console.log(`Showing first ${samplesToShow} missing positions:\n`);

      for (let i = 0; i < samplesToShow; i++) {
        const pos = missingPositions[i];
        const bet = pos.avgPrice * pos.totalBought;
        console.log(`${i + 1}. ${pos.title}`);
        console.log(`   Outcome: ${pos.outcome}`);
        console.log(`   Closed: ${new Date(pos.timestamp * 1000).toISOString()}`);
        console.log(`   Bet: $${bet.toFixed(2)} | PnL: $${pos.realizedPnl.toFixed(2)}`);
        console.log('');
      }

      if (missingPositions.length > samplesToShow) {
        console.log(`... and ${missingPositions.length - samplesToShow} more missing positions\n`);
      }

      // Calculate total missing PnL
      const missingPnL = missingPositions.reduce((sum, p) => sum + p.realizedPnl, 0);
      console.log(`💸 Total Missing PnL: $${missingPnL.toFixed(2)}\n`);
    }

    // ========================================================================
    // CONCLUSION
    // ========================================================================
    console.log('='.repeat(80));
    console.log('📝 CONCLUSION');
    console.log('='.repeat(80) + '\n');

    if (missingPositions.length > 0) {
      console.log('❌ ISSUE CONFIRMED: MongoDB is missing positions from the API');
      console.log(`   - ${missingPositions.length} positions are missing (${((missingPositions.length / apiPnL30d.positions) * 100).toFixed(2)}%)`);
      console.log(`   - Missing PnL: $${(diff30d).toFixed(2)}`);
      console.log(`   - MongoDB has only ${pct30d}% of the actual PnL\n`);
      console.log('🔧 NEXT STEPS:');
      console.log('   1. Check the fetchClosedPositions pagination logic');
      console.log('   2. Verify the saveClosedPositions upsert logic');
      console.log('   3. Run force-refresh to re-fetch all positions');
    } else {
      console.log('✅ No issues found: MongoDB has all positions from the API');
      console.log('   - Position counts match');
      console.log('   - PnL calculations match');
      console.log('   - Data is in sync\n');
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
