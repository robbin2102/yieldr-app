/**
 * Test Polymarket Activity API
 * Verifies that TRADE type fetches activity correctly
 */

import axios from 'axios';

const API_BASE = 'https://data-api.polymarket.com';
const TEST_WALLET = '0xecd55daa7c6900683b804d1d4db935fbfabe43f4';

async function testActivityAPI() {
  console.log('\n' + '='.repeat(80));
  console.log('TESTING POLYMARKET ACTIVITY API');
  console.log('='.repeat(80));
  console.log(`Wallet: ${TEST_WALLET}\n`);

  // Calculate timestamp for last 30 days
  const now = Math.floor(Date.now() / 1000);
  const start = now - 30 * 24 * 60 * 60;

  try {
    // Test with TRADE type only
    console.log('📡 Fetching with type=TRADE...');
    const url = `${API_BASE}/activity?user=${TEST_WALLET}&type=TRADE&start=${start}&limit=10&sortBy=TIMESTAMP&sortDirection=DESC`;

    const response = await axios.get(url);
    const activities = response.data;

    console.log(`✅ SUCCESS: Fetched ${activities.length} activities\n`);

    if (activities.length > 0) {
      console.log('Sample Activities:');
      console.log('─'.repeat(80));

      activities.slice(0, 5).forEach((activity: any, i: number) => {
        console.log(`${i + 1}. [${activity.type}] ${activity.side || 'N/A'}`);
        console.log(`   Market: ${activity.title}`);
        console.log(`   Size: ${activity.size.toFixed(2)} @ $${activity.price.toFixed(3)} = $${activity.usdcSize.toFixed(2)}`);
        console.log(`   Time: ${new Date(activity.timestamp * 1000).toLocaleString()}`);
        console.log(`   Hash: ${activity.transactionHash.substring(0, 20)}...`);
      });

      // Analyze activity types
      const typeBreakdown = activities.reduce((acc: any, a: any) => {
        acc[a.type] = (acc[a.type] || 0) + 1;
        return acc;
      }, {});

      console.log('\n📊 Activity Type Breakdown:');
      Object.entries(typeBreakdown).forEach(([type, count]) => {
        console.log(`   ${type}: ${count}`);
      });

      // Analyze sides (BUY/SELL)
      const sideBreakdown = activities.reduce((acc: any, a: any) => {
        if (a.side) {
          acc[a.side] = (acc[a.side] || 0) + 1;
        }
        return acc;
      }, {});

      console.log('\n📊 Trade Side Breakdown:');
      Object.entries(sideBreakdown).forEach(([side, count]) => {
        console.log(`   ${side}: ${count}`);
      });
    } else {
      console.log('⚠️  No activities found in last 30 days');
    }

    console.log('\n' + '='.repeat(80));
    console.log('✅ API TEST PASSED - TRADE type works correctly');
    console.log('='.repeat(80) + '\n');

  } catch (error: any) {
    console.error('\n❌ API TEST FAILED');
    console.error('Error:', error.message);
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Data:', error.response.data);
    }
    process.exit(1);
  }
}

testActivityAPI();
