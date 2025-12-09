#!/usr/bin/env ts-node
/**
 * Test script to verify orderbook WebSocket feed
 *
 * Usage: npx ts-node test-orderbook.ts <token_id>
 *
 * Example:
 * npx ts-node test-orderbook.ts 7600586494941538
 *
 * This will:
 * 1. Connect to Polymarket Market Channel WebSocket
 * 2. Subscribe to the specified token's orderbook
 * 3. Log ALL raw WebSocket messages
 * 4. Display orderbook in readable format
 * 5. Compare to what you see on Polymarket UI
 */

import WebSocket from 'ws';

const WSS_MARKET = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

// Get token ID from command line
const tokenId = process.argv[2];

if (!tokenId) {
  console.error('❌ Usage: npx ts-node test-orderbook.ts <token_id>');
  console.error('');
  console.error('How to find token ID:');
  console.error('1. Go to Polymarket market page');
  console.error('2. Click on an outcome (Yes/No/Up/Down)');
  console.error('3. Open browser DevTools → Network tab');
  console.error('4. Look for WebSocket connections or API calls');
  console.error('5. Find the asset_id or token_id in the messages');
  console.error('');
  console.error('Or use the Polymarket API:');
  console.error('curl "https://clob.polymarket.com/markets/<condition_id>"');
  process.exit(1);
}

console.log('═══════════════════════════════════════════════════════════');
console.log('           POLYMARKET ORDERBOOK TEST SCRIPT');
console.log('═══════════════════════════════════════════════════════════');
console.log(`Token ID: ${tokenId}`);
console.log(`WebSocket: ${WSS_MARKET}`);
console.log('═══════════════════════════════════════════════════════════\n');

let ws: WebSocket;
let messageCount = 0;
let orderbookReceived = false;

function connect() {
  console.log('[WebSocket] Connecting...\n');

  ws = new WebSocket(WSS_MARKET);

  ws.on('open', () => {
    console.log('[WebSocket] ✅ Connected\n');

    // Subscribe to orderbook for this token
    const subscribeMsg = {
      type: 'market',
      assets_ids: [tokenId],
    };

    console.log('[WebSocket] Sending subscription:');
    console.log(JSON.stringify(subscribeMsg, null, 2));
    console.log('');

    ws.send(JSON.stringify(subscribeMsg));
  });

  ws.on('message', (data) => {
    messageCount++;

    try {
      let msg = JSON.parse(data.toString());

      // First message might be wrapped in array
      if (Array.isArray(msg) && msg.length > 0) {
        msg = msg[0];
      }

      console.log(`\n${'═'.repeat(60)}`);
      console.log(`MESSAGE #${messageCount} (${new Date().toISOString()})`);
      console.log('═'.repeat(60));

      // Show raw message
      console.log('\n📦 RAW MESSAGE:');
      console.log(JSON.stringify(msg, null, 2));

      // Parse and display based on event type
      if (msg.event_type === 'book') {
        orderbookReceived = true;
        console.log('\n📊 ORDERBOOK SNAPSHOT:');
        console.log(`Asset ID: ${msg.asset_id}`);
        console.log(`Market: ${msg.market || 'N/A'}`);
        console.log(`Timestamp: ${msg.timestamp || 'N/A'}`);

        console.log('\n🔴 BIDS (Buy Orders - sorted high to low):');
        if (msg.bids && msg.bids.length > 0) {
          console.log('Price      | Size       | Total Value');
          console.log('-'.repeat(45));
          msg.bids.slice(0, 10).forEach((bid: any) => {
            const price = parseFloat(bid.price);
            const size = parseFloat(bid.size);
            const total = price * size;
            console.log(`$${price.toFixed(4).padEnd(9)} | ${size.toFixed(2).padEnd(10)} | $${total.toFixed(2)}`);
          });

          const totalBids = msg.bids.length;
          if (totalBids > 10) {
            console.log(`... and ${totalBids - 10} more bid levels`);
          }

          const bestBid = parseFloat(msg.bids[0].price);
          console.log(`\n✅ BEST BID (highest buy price): $${bestBid.toFixed(4)}`);
        } else {
          console.log('❌ NO BIDS');
        }

        console.log('\n🟢 ASKS (Sell Orders - sorted low to high):');
        if (msg.asks && msg.asks.length > 0) {
          console.log('Price      | Size       | Total Value');
          console.log('-'.repeat(45));
          msg.asks.slice(0, 10).forEach((ask: any) => {
            const price = parseFloat(ask.price);
            const size = parseFloat(ask.size);
            const total = price * size;
            console.log(`$${price.toFixed(4).padEnd(9)} | ${size.toFixed(2).padEnd(10)} | $${total.toFixed(2)}`);
          });

          const totalAsks = msg.asks.length;
          if (totalAsks > 10) {
            console.log(`... and ${totalAsks - 10} more ask levels`);
          }

          const bestAsk = parseFloat(msg.asks[0].price);
          console.log(`\n✅ BEST ASK (lowest sell price): $${bestAsk.toFixed(4)}`);
        } else {
          console.log('❌ NO ASKS');
        }

        // Calculate spread
        if (msg.bids && msg.bids.length > 0 && msg.asks && msg.asks.length > 0) {
          const bestBid = parseFloat(msg.bids[0].price);
          const bestAsk = parseFloat(msg.asks[0].price);
          const spread = bestAsk - bestBid;
          const spreadPct = (spread / bestBid) * 100;
          console.log(`\n📏 SPREAD: $${spread.toFixed(4)} (${spreadPct.toFixed(2)}%)`);
        }

        console.log('\n💡 WHAT TO CHECK:');
        console.log('1. Compare BEST BID to "Buy" price on Polymarket UI');
        console.log('2. Compare BEST ASK to "Sell" price on Polymarket UI');
        console.log('3. Check if sizes match liquidity shown on UI');
        console.log('4. Verify asset_id matches the outcome token you\'re viewing');

      } else if (msg.event_type === 'price_change') {
        console.log('\n📈 PRICE CHANGE:');
        console.log(`Asset ID: ${msg.asset_id}`);
        if (msg.price_changes) {
          msg.price_changes.forEach((change: any) => {
            console.log(`  ${change.side}: $${change.price} → ${change.size} shares`);
          });
        }
      } else {
        console.log(`\n⚠️ UNKNOWN EVENT TYPE: ${msg.event_type}`);
      }

    } catch (err) {
      console.error('❌ Parse error:', err);
      console.error('Raw data:', data.toString());
    }
  });

  ws.on('close', (code, reason) => {
    console.log(`\n[WebSocket] Disconnected (code: ${code})`);
    if (reason) {
      console.log(`Reason: ${reason}`);
    }

    if (!orderbookReceived) {
      console.log('\n❌ NO ORDERBOOK DATA RECEIVED');
      console.log('Possible issues:');
      console.log('1. Token ID is incorrect');
      console.log('2. Market is closed/expired');
      console.log('3. No liquidity in this market');
      console.log('4. Subscription message format is wrong');
    }
  });

  ws.on('error', (err) => {
    console.error('\n❌ WebSocket error:', err.message);
  });
}

// Connect and run for 30 seconds
connect();

console.log('⏳ Listening for orderbook updates...');
console.log('💡 Press Ctrl+C to stop\n');

// Keep alive for 30 seconds, then exit
setTimeout(() => {
  console.log('\n\n⏱️  30 seconds elapsed, closing connection...');
  ws.close();

  setTimeout(() => {
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log(`Total messages received: ${messageCount}`);
    console.log(`Orderbook data received: ${orderbookReceived ? 'YES ✅' : 'NO ❌'}`);
    console.log('═══════════════════════════════════════════════════════════\n');
    process.exit(0);
  }, 1000);
}, 30000);

// Handle Ctrl+C
process.on('SIGINT', () => {
  console.log('\n\n👋 Interrupted by user, closing...');
  ws.close();

  setTimeout(() => {
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log(`Total messages received: ${messageCount}`);
    console.log(`Orderbook data received: ${orderbookReceived ? 'YES ✅' : 'NO ❌'}`);
    console.log('═══════════════════════════════════════════════════════════\n');
    process.exit(0);
  }, 500);
});
