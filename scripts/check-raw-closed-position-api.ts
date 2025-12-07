/**
 * Check raw API response for closed positions to understand PnL calculation
 */

import axios from 'axios';

const API_BASE = 'https://data-api.polymarket.com';
const TEST_WALLET = '0xecd55daa7c6900683b804d1d4db935fbfabe43f4';

async function checkRawAPI() {
  console.log('\n🔍 RAW CLOSED POSITIONS API RESPONSE\n');
  console.log('='.repeat(80));

  // Fetch closed positions with 30-day filter
  const now = Math.floor(Date.now() / 1000);
  const thirtyDaysAgo = now - (30 * 24 * 60 * 60);

  const url = `${API_BASE}/closed-positions?user=${TEST_WALLET}&start=${thirtyDaysAgo}&limit=5&sortBy=TIMESTAMP&sortDirection=DESC`;

  console.log(`URL: ${url}\n`);

  try {
    const response = await axios.get(url);
    const positions = response.data;

    console.log(`✅ Fetched ${positions.length} positions\n`);

    positions.forEach((pos: any, idx: number) => {
      console.log(`\n${idx + 1}. ${pos.title}`);
      console.log(`   Outcome: ${pos.outcome}`);
      console.log(`   ConditionId: ${pos.conditionId}`);
      console.log(`\n   RAW API FIELDS:`);
      console.log(`   totalBought: ${pos.totalBought}`);
      console.log(`   avgPrice: $${pos.avgPrice}`);
      console.log(`   realizedPnl: $${pos.realizedPnl}`);

      console.log(`\n   OUR CALCULATION:`);
      const totalBet = pos.avgPrice * pos.totalBought;
      const amountWon = totalBet + pos.realizedPnl;
      console.log(`   totalBet (avgPrice * totalBought): $${totalBet.toFixed(2)}`);
      console.log(`   amountWon (totalBet + realizedPnl): $${amountWon.toFixed(2)}`);
      console.log(`   PnL: $${pos.realizedPnl.toFixed(2)}`);
      console.log(`   ROI: ${((pos.realizedPnl / totalBet) * 100).toFixed(2)}%`);

      // Try alternative calculation: maybe realizedPnl is per share?
      const altPnl = pos.realizedPnl * pos.totalBought;
      console.log(`\n   ALTERNATIVE (realizedPnl * totalBought): $${altPnl.toFixed(2)}`);

      console.log(`\n   ALL FIELDS IN RESPONSE:`);
      Object.keys(pos).forEach(key => {
        if (typeof pos[key] !== 'object') {
          console.log(`   ${key}: ${pos[key]}`);
        }
      });
      console.log('\n   ' + '-'.repeat(76));
    });

    console.log('\n' + '='.repeat(80));
    console.log('\n💡 HYPOTHESIS:');
    console.log('If realizedPnl * 2 ≈ actual PnL, then the API might be:');
    console.log('1. Only showing NET profit (excluding the initial bet)');
    console.log('2. Showing PnL per share instead of total PnL');
    console.log('3. Using a different calculation method than Polymarket UI');
    console.log('\nCheck if any alternative calculation above matches Polymarket UI values.\n');

  } catch (error: any) {
    console.error(`❌ ERROR: ${error.message}`);
    if (error.response) {
      console.error(`Status: ${error.response.status}`);
      console.error(`Data:`, error.response.data);
    }
  }
}

checkRawAPI();
