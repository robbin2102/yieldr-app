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

  // Try to get condition ID from tid parameter
  const tidMatch = marketUrl.match(/[?&]tid=([^&]+)/);
  if (tidMatch) {
    console.log(`💡 Note: tid=${tidMatch[1]} is NOT the token ID`);
    console.log(`   tid is a tracking ID, not the orderbook token ID\n`);
  }

  // Fetch market data from Polymarket Gamma API
  console.log('🔍 Attempting Gamma API...\n');

  const gammaUrl = `https://gamma-api.polymarket.com/events?slug=${slug}`;

  try {
    const response = await fetch(gammaUrl);

    if (!response.ok) {
      console.error(`❌ Gamma API request failed: ${response.status} ${response.statusText}`);
      throw new Error('Gamma API failed, trying CLOB API...');
    }

    const data = await response.json() as any;

    if (!data || data.length === 0) {
      console.error('❌ No market found in Gamma API');
      throw new Error('Trying CLOB API...');
    }

    const event = data[0];

    console.log('✅ Market found in Gamma API!\n');
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

      let hasTokens = false;

      event.markets.forEach((market: any, index: number) => {
        console.log(`${index + 1}. ${market.question}`);
        console.log('   ─────────────────────────────────────────────────');
        console.log(`   Condition ID: ${market.conditionId}`);
        console.log(`   Active: ${market.active ? 'YES ✅' : 'NO ❌'}`);
        console.log(`   Closed: ${market.closed ? 'YES' : 'NO'}`);
        console.log('');

        if (market.tokens && market.tokens.length > 0) {
          hasTokens = true;
          console.log('   📍 Token IDs (use these for orderbook):');
          market.tokens.forEach((token: any) => {
            console.log(`   • ${token.outcome}: ${token.token_id}`);
            console.log(`     Winner: ${token.winner ? 'YES' : 'NO'}`);
          });
        } else {
          console.log(`   ⚠️  No tokens in Gamma API, will try CLOB API with condition ID: ${market.conditionId}`);
        }

        console.log('');
      });

      if (!hasTokens) {
        console.log('⚠️  No tokens found in Gamma API, trying CLOB API...\n');
        // Try CLOB API for each condition
        for (const market of event.markets) {
          await tryGetTokensFromCLOB(market.conditionId);
        }
      } else {
        // Show command to test orderbook
        printTestCommands(event.markets);
      }

    } else {
      console.log('❌ No markets found in this event');
    }

  } catch (error: any) {
    console.error('⚠️  Gamma API failed:', error.message);
    console.log('\n🔄 Trying CLOB API...\n');

    // Try to extract condition ID from page or use slug
    await tryGetMarketFromCLOB(slug);
  }
}

async function tryGetTokensFromCLOB(conditionId: string) {
  console.log(`\n🔍 Fetching tokens from CLOB API for condition ${conditionId.slice(0, 16)}...\n`);

  try {
    const clobUrl = `https://clob.polymarket.com/markets/${conditionId}`;
    const response = await fetch(clobUrl);

    if (!response.ok) {
      console.error(`❌ CLOB API request failed: ${response.status}`);
      return;
    }

    const data = await response.json() as any;

    // CLOB API returns array of markets
    let markets = Array.isArray(data) ? data : (data.markets || []);

    if (!markets || markets.length === 0) {
      console.error('❌ No markets found in CLOB API response');
      console.log('Response structure:', JSON.stringify(data).slice(0, 200));
      return;
    }

    console.log('✅ Tokens found in CLOB API!\n');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('📍 TOKEN IDs FOR ORDERBOOK:');
    console.log('═══════════════════════════════════════════════════════════\n');

    markets.forEach((market: any) => {
      console.log(`• ${market.outcome}: ${market.token_id}`);
      console.log(`  Active: ${market.active ? 'YES ✅' : 'NO ❌'}`);
      console.log(`  Closed: ${market.closed ? 'YES' : 'NO'}`);
      console.log('');
    });

    printTestCommandsFromCLOB(markets);

  } catch (error: any) {
    console.error('❌ CLOB API error:', error.message);
    console.error('Stack:', error.stack);
  }
}

async function tryGetMarketFromCLOB(slug: string) {
  console.log(`🔍 Searching CLOB API for slug: ${slug}\n`);

  try {
    // CLOB API doesn't have slug search, need condition ID
    console.log('❌ CLOB API requires condition ID (not slug)');
    console.log('\n💡 HOW TO FIND TOKEN IDs MANUALLY:');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('1. Open market page in browser');
    console.log('2. Open DevTools (F12) → Network tab');
    console.log('3. Click on "Buy" or "Sell" button');
    console.log('4. Look for WebSocket messages or API calls');
    console.log('5. Find "asset_id" or "token_id" in the messages');
    console.log('6. Copy the long number (token ID)');
    console.log('');
    console.log('OR:');
    console.log('7. Inspect the page source (Ctrl+U)');
    console.log('8. Search for "token_id" or "tokenId"');
    console.log('9. Copy the values');
    console.log('\n');
  } catch (error: any) {
    console.error('❌ Error:', error.message);
  }
}

function printTestCommands(markets: any[]) {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('🧪 TEST ORDERBOOK:');
  console.log('═══════════════════════════════════════════════════════════\n');

  markets.forEach((market: any, index: number) => {
    if (market.tokens && market.tokens.length > 0) {
      console.log(`Market ${index + 1}: ${market.question}`);
      market.tokens.forEach((token: any) => {
        console.log(`\n  # Test ${token.outcome} orderbook:`);
        console.log(`  npx ts-node test-orderbook.ts ${token.token_id}`);
      });
      console.log('');
    }
  });

  console.log('═══════════════════════════════════════════════════════════');
  console.log('💡 HOW TO USE:');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('1. Copy a token_id from above');
  console.log('2. Run: npx ts-node test-orderbook.ts <token_id>');
  console.log('3. Compare orderbook data to Polymarket UI');
  console.log('4. Check if prices and liquidity match\n');
}

function printTestCommandsFromCLOB(markets: any[]) {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('🧪 TEST ORDERBOOK:');
  console.log('═══════════════════════════════════════════════════════════\n');

  markets.forEach((market: any) => {
    console.log(`  # Test ${market.outcome} orderbook:`);
    console.log(`  npx ts-node test-orderbook.ts ${market.token_id}`);
    console.log('');
  });

  console.log('═══════════════════════════════════════════════════════════');
  console.log('💡 IMPORTANT:');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('• Each outcome (Up/Down, Yes/No) has a DIFFERENT token ID');
  console.log('• Subscribe to the token ID for the outcome you want to trade');
  console.log('• Compare orderbook to UI to verify correct token');
  console.log('• The tid parameter in URL is NOT the token ID!\n');
}

getTokenIds();
