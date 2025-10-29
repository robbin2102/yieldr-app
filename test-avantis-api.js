// Test script to check Avantis API response
const fetch = require('node-fetch');

async function testAvantisAPI() {
    try {
        console.log('🔍 Testing Avantis API...\n');

        const response = await fetch('http://localhost:3000/api/avantis-positions?address=0x8e1c4e0a7e85b2490f6d811824515d6fad3115a6');
        const data = await response.json();

        console.log('✅ Response received');
        console.log(`Total positions: ${data.data?.totalPositions || 0}\n`);

        if (data.data?.positions?.length > 0) {
            const samplePosition = data.data.positions[0];
            console.log('📊 Sample Position #1:');
            console.log(JSON.stringify(samplePosition, null, 2));

            console.log('\n📊 Price Comparison:');
            console.log(`Entry Price: ${samplePosition.entryPrice}`);
            console.log(`Current Price: ${samplePosition.currentPrice}`);
            console.log(`Are they same? ${samplePosition.entryPrice === samplePosition.currentPrice ? '⚠️  YES (PROBLEM!)' : '✅ NO (GOOD)'}`);
            console.log(`PnL: $${samplePosition.pnl?.toFixed(2)}`);
            console.log(`ROI: ${samplePosition.roi?.toFixed(2)}%`);
        }

        // Check a few more positions
        console.log('\n📊 Checking first 5 positions:');
        data.data.positions.slice(0, 5).forEach((pos, i) => {
            const match = pos.entryPrice === pos.currentPrice;
            console.log(`${i+1}. ${pos.asset}: Entry=$${pos.entryPrice} Current=$${pos.currentPrice} ${match ? '⚠️  SAME' : '✅ DIFF'}`);
        });

    } catch (error) {
        console.error('❌ Error:', error.message);
    }
}

testAvantisAPI();
