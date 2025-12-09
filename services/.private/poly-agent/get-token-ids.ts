#!/usr/bin/env ts-node
/**
 * Get token IDs for a Polymarket market
 *
 * Usage: npx ts-node get-token-ids.ts <market_url>
 *
 * Example:
 * npx ts-node get-token-ids.ts "https://polymarket.com/event/btc-updown-15m-1765292400?tid=1765292520818"
 */

const marketUrl = process.argv[2];

if (!marketUrl) {
  console.error('❌ Usage: npx ts-node get-token-ids.ts <market_url>');
  console.error('');
  console.error('Example:');
  console.error('npx ts-node get-token-ids.ts "https://polymarket.com/event/btc-updown-15m-1765292400"');
  process.exit(1);
}

async function getTokenIds() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('         POLYMARKET TOKEN ID FINDER');
  console.log('═══════════════════════════════════════════════════════════\n');

  // Extract slug from URL
  const match = marketUrl.match(/event\/([^?]+)/);
  if (!match) {
    console.error('❌ Could not extract event slug from URL');
    console.error('Expected format: https://polymarket.com/event/<slug>');
    process.exit(1);
  }

  const slug = match[1];
  console.log(`📍 Event slug: ${slug}\n`);

  // Fetch market data from Polymarket API
  console.log('🔍 Fetching market data from Polymarket API...\n');

  const apiUrl = `https://gamma-api.polymarket.com/events?slug=${slug}`;

  try {
    const response = await fetch(apiUrl);

    if (!response.ok) {
      console.error(`❌ API request failed: ${response.status} ${response.statusText}`);
      process.exit(1);
    }

    const data = await response.json() as any;

    if (!data || data.length === 0) {
      console.error('❌ No market found for this slug');
      console.error('The market might be closed, or the URL is incorrect');
      process.exit(1);
    }

    const event = data[0];

    console.log('✅ Market found!\n');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`📊 ${event.title}`);
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`Description: ${event.description || 'N/A'}`);
    console.log(`Active: ${event.active ? 'YES ✅' : 'NO ❌'}`);
    console.log(`Closed: ${event.closed ? 'YES' : 'NO'}`);
    console.log(`End Date: ${event.endDate ? new Date(event.endDate).toISOString() : 'N/A'}`);
    console.log('');

    if (event.markets && event.markets.length > 0) {
      console.log(`📈 Markets (${event.markets.length}):\n`);

      event.markets.forEach((market: any, index: number) => {
        console.log(`${index + 1}. ${market.question}`);
        console.log('   ─────────────────────────────────────────────────');
        console.log(`   Condition ID: ${market.conditionId}`);
        console.log(`   Active: ${market.active ? 'YES ✅' : 'NO ❌'}`);
        console.log(`   Closed: ${market.closed ? 'YES' : 'NO'}`);
        console.log('');

        if (market.tokens && market.tokens.length > 0) {
          console.log('   📍 Token IDs (use these for orderbook):');
          market.tokens.forEach((token: any) => {
            console.log(`   • ${token.outcome}: ${token.token_id}`);
            console.log(`     Winner: ${token.winner ? 'YES' : 'NO'}`);
          });
        } else {
          console.log('   ❌ No tokens found');
        }

        console.log('');
      });

      // Show command to test orderbook
      console.log('═══════════════════════════════════════════════════════════');
      console.log('🧪 TEST ORDERBOOK:');
      console.log('═══════════════════════════════════════════════════════════\n');

      event.markets.forEach((market: any, index: number) => {
        if (market.tokens && market.tokens.length > 0) {
          console.log(`Market ${index + 1}: ${market.question}`);
          market.tokens.forEach((token: any) => {
            console.log(`\n  # Test ${token.outcome} orderbook:`);
            console.log(`  npx ts-node test-orderbook.ts ${token.token_id}`);
          });
          console.log('');
        }
      });

    } else {
      console.log('❌ No markets found in this event');
    }

    console.log('═══════════════════════════════════════════════════════════');
    console.log('💡 HOW TO USE:');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('1. Copy a token_id from above');
    console.log('2. Run: npx ts-node test-orderbook.ts <token_id>');
    console.log('3. Compare orderbook data to Polymarket UI');
    console.log('4. Check if prices and liquidity match\n');

  } catch (error: any) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

getTokenIds();
