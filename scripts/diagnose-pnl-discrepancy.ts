/**
 * Diagnose PnL discrepancy between our calculation and Polymarket UI
 */

import dotenv from 'dotenv';
import path from 'path';

// Load environment variables
const envPath = path.resolve(process.cwd(), '.env.local');
dotenv.config({ path: envPath });

import connectDB from '../lib/mongoose';
import PolymarketClosedPosition from '../models/PolymarketClosedPosition';
import PolymarketOpenPosition from '../models/PolymarketOpenPosition';

const WALLET = '0xecd55daa7c6900683b804d1d4db935fbfabe43f4';

async function diagnosePnL() {
  await connectDB();

  console.log('\n🔍 PnL DISCREPANCY DIAGNOSIS\n');
  console.log('=' .repeat(80));

  // Get all closed positions
  const closedPositions = await PolymarketClosedPosition
    .find({ walletAddress: WALLET.toLowerCase() })
    .sort({ closedAt: 1 })
    .lean();

  // Get all open positions
  const openPositions = await PolymarketOpenPosition
    .find({ walletAddress: WALLET.toLowerCase() })
    .lean();

  console.log(`\n📊 DATA SUMMARY:`);
  console.log(`Total closed positions: ${closedPositions.length}`);
  console.log(`Total open positions: ${openPositions.length}`);

  if (closedPositions.length > 0) {
    console.log(`\nClosed positions date range:`);
    console.log(`  Earliest: ${closedPositions[0].closedAt.toISOString()}`);
    console.log(`  Latest:   ${closedPositions[closedPositions.length - 1].closedAt.toISOString()}`);
  }

  // Check for duplicate conditionIds (partial closes)
  const conditionIds = closedPositions.map(p => p.conditionId);
  const uniqueConditionIds = new Set(conditionIds);
  const duplicates = closedPositions.length - uniqueConditionIds.size;

  console.log(`\n🔄 PARTIAL CLOSES:`);
  console.log(`  Unique positions: ${uniqueConditionIds.size}`);
  console.log(`  Total closes: ${closedPositions.length}`);
  console.log(`  Partial closes: ${duplicates}`);

  // Calculate PnL using different methods
  console.log(`\n💰 PnL CALCULATIONS:\n`);

  // Method 1: Sum all realizedPnl (current method)
  const method1_pnl = closedPositions.reduce((sum, p) => sum + p.realizedPnl, 0);
  const method1_invested = closedPositions.reduce((sum, p) => sum + p.totalBet, 0);
  console.log(`Method 1: Sum all realizedPnl`);
  console.log(`  Total Investment: $${method1_invested.toFixed(2)}`);
  console.log(`  Realized PnL: $${method1_pnl.toFixed(2)}`);
  console.log(`  ROI: ${((method1_pnl / method1_invested) * 100).toFixed(2)}%`);

  // Method 2: Sum by unique conditionId (avoid double counting)
  const byConditionId = new Map<string, { totalBet: number; realizedPnl: number; count: number }>();
  closedPositions.forEach(p => {
    const existing = byConditionId.get(p.conditionId) || { totalBet: 0, realizedPnl: 0, count: 0 };
    byConditionId.set(p.conditionId, {
      totalBet: existing.totalBet + p.totalBet,
      realizedPnl: existing.realizedPnl + p.realizedPnl,
      count: existing.count + 1
    });
  });

  const method2_pnl = Array.from(byConditionId.values()).reduce((sum, v) => sum + v.realizedPnl, 0);
  const method2_invested = Array.from(byConditionId.values()).reduce((sum, v) => sum + v.totalBet, 0);
  console.log(`\nMethod 2: Group by conditionId (sum all closes per position)`);
  console.log(`  Total Investment: $${method2_invested.toFixed(2)}`);
  console.log(`  Realized PnL: $${method2_pnl.toFixed(2)}`);
  console.log(`  ROI: ${((method2_pnl / method2_invested) * 100).toFixed(2)}%`);

  // Method 3: Calculate amountWon - amountInvested
  const method3_invested = closedPositions.reduce((sum, p) => sum + p.totalBet, 0);
  const method3_won = closedPositions.reduce((sum, p) => sum + p.amountWon, 0);
  const method3_pnl = method3_won - method3_invested;
  console.log(`\nMethod 3: Sum(amountWon) - Sum(totalBet)`);
  console.log(`  Total Bet: $${method3_invested.toFixed(2)}`);
  console.log(`  Total Won: $${method3_won.toFixed(2)}`);
  console.log(`  PnL: $${method3_pnl.toFixed(2)}`);
  console.log(`  ROI: ${((method3_pnl / method3_invested) * 100).toFixed(2)}%`);

  // Check open positions
  const activeOpen = openPositions.filter(p => !p.redeemable);
  const redeemable = openPositions.filter(p => p.redeemable);

  console.log(`\n📈 OPEN POSITIONS:`);
  console.log(`  Active: ${activeOpen.length}`);
  console.log(`  Redeemable: ${redeemable.length}`);

  const activeInvestment = activeOpen.reduce((sum, p) => sum + p.initialValue, 0);
  const activePnl = activeOpen.reduce((sum, p) => sum + p.cashPnl, 0);
  console.log(`  Active Investment: $${activeInvestment.toFixed(2)}`);
  console.log(`  Active Unrealized PnL: $${activePnl.toFixed(2)}`);

  const redeemableInvestment = redeemable.reduce((sum, p) => sum + p.initialValue, 0);
  const redeemablePnl = redeemable.reduce((sum, p) => sum + p.cashPnl, 0);
  console.log(`  Redeemable Investment: $${redeemableInvestment.toFixed(2)}`);
  console.log(`  Redeemable PnL: $${redeemablePnl.toFixed(2)}`);

  // Total PnL (closed + open)
  const totalPnl = method1_pnl + activePnl + redeemablePnl;
  const totalInvestment = method1_invested + activeInvestment + redeemableInvestment;

  console.log(`\n🎯 TOTAL PnL (Method 1 + Open):`);
  console.log(`  Total Investment: $${totalInvestment.toFixed(2)}`);
  console.log(`  Total PnL: $${totalPnl.toFixed(2)}`);
  console.log(`  Overall ROI: ${((totalPnl / totalInvestment) * 100).toFixed(2)}%`);

  // Show some examples of positions with multiple closes
  console.log(`\n🔍 SAMPLE POSITIONS WITH MULTIPLE CLOSES:\n`);
  let samplesShown = 0;
  for (const [conditionId, data] of byConditionId) {
    if (data.count > 1 && samplesShown < 5) {
      const positions = closedPositions.filter(p => p.conditionId === conditionId);
      console.log(`  ${positions[0].title.substring(0, 60)}...`);
      console.log(`    Condition ID: ${conditionId}`);
      console.log(`    Number of closes: ${data.count}`);
      console.log(`    Total PnL: $${data.realizedPnl.toFixed(2)}`);
      console.log(`    Close dates:`);
      positions.forEach(p => {
        console.log(`      - ${p.closedAt.toISOString()}: $${p.realizedPnl.toFixed(2)}`);
      });
      console.log();
      samplesShown++;
    }
  }

  console.log('='.repeat(80));
  console.log('\n💡 EXPECTED FROM POLYMARKET UI:');
  console.log('  30d PnL: $144,000');
  console.log('  7d PnL:  $110,000');
  console.log('  1d PnL:  $688');
  console.log('\n Compare these with the calculations above to identify the issue.\n');

  process.exit(0);
}

diagnosePnL().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
