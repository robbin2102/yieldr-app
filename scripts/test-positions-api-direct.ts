/**
 * Test Polymarket Positions API directly to see what's being returned
 */

import axios from 'axios';

const API_BASE = 'https://data-api.polymarket.com';
const TEST_WALLET = '0xecd55daa7c6900683b804d1d4db935fbfabe43f4';

async function testPositionsAPI() {
  console.log('\n' + '='.repeat(80));
  console.log('TESTING POLYMARKET POSITIONS API');
  console.log('='.repeat(80));
  console.log(`Wallet: ${TEST_WALLET}\n`);

  try {
    // Test 1: Basic positions query (what we're currently using)
    console.log('📡 Test 1: Basic positions query...');
    const url1 = `${API_BASE}/positions?user=${TEST_WALLET}&limit=500&offset=0`;
    console.log(`URL: ${url1}\n`);

    const response1 = await axios.get(url1);
    const positions1 = response1.data;

    console.log(`✅ Returned ${positions1.length} positions\n`);

    if (positions1.length > 0) {
      console.log('Sample position:');
      const sample = positions1[0];
      console.log(`  Title: ${sample.title}`);
      console.log(`  Size: ${sample.size}`);
      console.log(`  Avg Price: $${sample.avgPrice}`);
      console.log(`  Current Price: $${sample.curPrice}`);
      console.log(`  Initial Value: $${sample.initialValue}`);
      console.log(`  Current Value: $${sample.currentValue}`);
      console.log(`  Cash PnL: $${sample.cashPnl}`);
      console.log(`  Redeemable: ${sample.redeemable || false}\n`);
    }

    // Test 2: Try without limit/offset
    console.log('📡 Test 2: Query without limit/offset...');
    const url2 = `${API_BASE}/positions?user=${TEST_WALLET}`;
    console.log(`URL: ${url2}\n`);

    const response2 = await axios.get(url2);
    const positions2 = response2.data;

    console.log(`✅ Returned ${positions2.length} positions\n`);

    // Test 3: Check if there are query params we're missing
    console.log('📡 Test 3: Try with different parameters...');
    const url3 = `${API_BASE}/positions?user=${TEST_WALLET}&limit=1000`;
    console.log(`URL: ${url3}\n`);

    const response3 = await axios.get(url3);
    const positions3 = response3.data;

    console.log(`✅ Returned ${positions3.length} positions\n`);

    // Show all positions
    console.log('📋 ALL POSITIONS RETURNED:\n');
    positions1.forEach((pos, idx) => {
      console.log(`${idx + 1}. ${pos.title}`);
      console.log(`   Size: ${pos.size} shares @ avg $${pos.avgPrice}`);
      console.log(`   Value: $${pos.initialValue} → $${pos.currentValue} (PnL: $${pos.cashPnl})`);
      console.log(`   Redeemable: ${pos.redeemable || false}\n`);
    });

    console.log('='.repeat(80));
    console.log('\n💡 EXPECTED FROM POLYMARKET UI:');
    console.log('  6 open positions total:');
    console.log('  1. Bitcoin Up/Down Dec 6 2:00PM-2:15PM ET (Down) - 2,093.8 shares');
    console.log('  2. Bitcoin Up/Down Dec 6 2:15PM-2:30PM ET (Up) - 1,366.2 shares');
    console.log('  3. Bitcoin Up/Down Dec 6 2:15PM-2:30PM ET (Down) - 440.6 shares');
    console.log('  4. Bitcoin Up/Down Nov 26 1:15PM-1:30PM ET (Up) - 0.9 shares (redeemable)');
    console.log('  5. Bitcoin Up/Down Nov 24 12:45PM-1:00PM ET (Up) - 0.4 shares (redeemable)');
    console.log('  6. Bitcoin Up/Down Nov 23 11:45PM-12:00AM ET (Up) - 0.3 shares (redeemable)');
    console.log('\n  Compare with API results above to identify the issue.\n');

  } catch (error: any) {
    console.error(`❌ ERROR: ${error.message}`);
    if (error.response) {
      console.error(`Status: ${error.response.status}`);
      console.error(`Data:`, error.response.data);
    }
  }
}

testPositionsAPI();
