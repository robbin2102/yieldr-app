/**
 * Order Placement Test — standalone test for GTC order logic
 *
 * Places a GTC BUY order on the current live BTC 5m market,
 * polls for fill for 5 seconds, then CANCELS to avoid any risk.
 * Tests order creation, signing, posting, fill detection, and cancellation.
 *
 * Also tests small order sizes (1, 2, 3, 5 shares) to find the real minimum.
 *
 * Usage:
 *   npx tsx services/.private/poly-agent/src/test-order.ts              ← auto mode (bestAsk-1c, 5 shares)
 *   npx tsx services/.private/poly-agent/src/test-order.ts auto 1       ← auto mode, 1 share
 *   npx tsx services/.private/poly-agent/src/test-order.ts Up 0.90 5    ← manual: side, price, shares
 *   npx tsx services/.private/poly-agent/src/test-order.ts mintest      ← test 1,2,3,5 shares to find minimum
 */

import { ethers } from 'ethers';
import { ClobClient, Side, OrderType } from '@polymarket/clob-client';
import dotenv from 'dotenv';
import path from 'path';

const envPaths = [
  path.resolve(process.cwd(), 'services/.private/poly-agent/.env.polyagent'),
  path.resolve(process.cwd(), 'services/.private/poly-agent/.env.local'),
  path.resolve(process.cwd(), '.env.local'),
  path.resolve(process.cwd(), '.env'),
];
for (const p of envPaths) {
  const r = dotenv.config({ path: p });
  if (r.parsed?.BOT_PRIVATE_KEY) break;
}

const CONFIG = {
  botPrivateKey: process.env.BOT_PRIVATE_KEY!,
  apiKey: process.env.POLYMARKET_API_KEY!,
  apiSecret: process.env.POLYMARKET_API_SECRET!,
  passphrase: process.env.POLYMARKET_PASSPHRASE!,
  clobApiBase: process.env.CLOB_API_BASE || 'https://clob.polymarket.com',
  gammaApiBase: 'https://gamma-api.polymarket.com',
  chainId: parseInt(process.env.CHAIN_ID || '137'),
  polygonRpcUrl: process.env.POLYGON_RPC_URL!,
};

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const CANCEL_AFTER_MS = 5000; // Cancel order after 5 seconds — safety net

async function initClient() {
  const provider = new ethers.providers.StaticJsonRpcProvider(CONFIG.polygonRpcUrl, { name: 'polygon', chainId: CONFIG.chainId });
  const wallet = new ethers.Wallet(CONFIG.botPrivateKey, provider);
  console.log(`[Init] Wallet: ${wallet.address}`);
  return new ClobClient(CONFIG.clobApiBase, CONFIG.chainId, wallet,
    { key: CONFIG.apiKey, secret: CONFIG.apiSecret, passphrase: CONFIG.passphrase });
}

async function getCurrentMarket() {
  const now = Math.floor(Date.now() / 1000);
  const slug = `btc-updown-5m-${Math.floor(now / 300) * 300}`;
  const cycleClose = Math.floor(now / 300) * 300 + 300;

  const res = await fetch(`${CONFIG.gammaApiBase}/events?slug=${slug}`);
  if (!res.ok) throw new Error('Failed to fetch market');
  const events = await res.json() as any[];
  if (!events?.[0]?.markets?.[0]) throw new Error('No market found');

  const market = events[0].markets[0];
  let tokenIds: string[] = [];
  try { tokenIds = JSON.parse(market.clobTokenIds); }
  catch { tokenIds = (market.clobTokenIds || '').split(',').map((s: string) => s.trim()); }

  return { slug, question: market.question, upToken: tokenIds[0], downToken: tokenIds[1], cycleClose, secsLeft: cycleClose - now };
}

async function getOrderbook(clobClient: ClobClient, tokenId: string, label: string) {
  const res = await fetch(`${CONFIG.clobApiBase}/book?token_id=${tokenId}`);
  if (!res.ok) return { label, bestAsk: null as number | null, bestBid: null as number | null, askDepth: 0, bidDepth: 0 };
  const data = await res.json() as any;
  const asks = (data.asks || []).map((a: any) => ({ price: parseFloat(a.price), size: parseFloat(a.size) })).sort((a: any, b: any) => a.price - b.price);
  const bids = (data.bids || []).map((b: any) => ({ price: parseFloat(b.price), size: parseFloat(b.size) })).sort((a: any, b: any) => b.price - a.price);
  return {
    label,
    bestAsk: asks.length > 0 ? asks[0].price : null,
    bestBid: bids.length > 0 ? bids[0].price : null,
    askDepth: asks.length > 0 ? asks[0].size : 0,
    bidDepth: bids.length > 0 ? bids[0].size : 0,
  };
}

async function placeAndCancelOrder(
  clobClient: ClobClient, tokenId: string, side: string, price: number, shares: number
): Promise<{ success: boolean; orderId: string | null; filled: boolean; filledSize: number; fillPrice: number; error: string }> {
  const result = { success: false, orderId: null as string | null, filled: false, filledSize: 0, fillPrice: 0, error: '' };

  try {
    console.log(`\n  [Order] Creating GTC BUY: ${shares} shares @ ${(price * 100).toFixed(1)}c ($${(shares * price).toFixed(2)})`);

    const order = await clobClient.createOrder({
      tokenID: tokenId,
      price: price,
      size: shares,
      side: Side.BUY,
      feeRateBps: 1000,
      nonce: 0,
    });
    console.log(`  [Order] Signed locally ✅`);

    const response = await clobClient.postOrder(order, OrderType.GTC);
    const ordId = response?.orderID || (response as any)?.orderid || null;

    if (!ordId) {
      result.error = 'Order rejected (no orderID)';
      console.log(`  [Order] ❌ Rejected — check "request error" above`);
      return result;
    }

    result.orderId = ordId;
    result.success = true;
    console.log(`  [Order] ✅ LIVE: ${ordId.slice(0, 24)}...`);

    // Poll for fill for 5 seconds
    console.log(`  [Fill] Polling for ${CANCEL_AFTER_MS / 1000}s...`);
    const pollEnd = Date.now() + CANCEL_AFTER_MS;

    while (Date.now() < pollEnd) {
      await sleep(500);
      try {
        const statusRes = await fetch(`${CONFIG.clobApiBase}/order/${ordId}`, {
          headers: {
            'POLY_API_KEY': CONFIG.apiKey,
            'POLY_SIGNATURE': CONFIG.apiSecret,
            'POLY_TIMESTAMP': Date.now().toString(),
            'POLY_PASSPHRASE': CONFIG.passphrase,
          },
        });
        if (statusRes.ok) {
          const os = await statusRes.json() as any;
          const matched = parseFloat(os.size_matched) || 0;
          const p = parseFloat(os.price) || price;
          console.log(`  [Fill] status=${os.status || '?'} matched=${matched.toFixed(2)} price=${(p * 100).toFixed(1)}c`);

          if (matched > 0) {
            result.filled = true;
            result.filledSize = matched;
            result.fillPrice = p;
            console.log(`  [Fill] ✅ FILLED: ${matched.toFixed(2)} shares @ ${(p * 100).toFixed(1)}c [${p <= price ? 'maker' : 'taker'}]`);
            break;
          }
          if (os.status === 'CANCELED' || os.status === 'EXPIRED') {
            console.log(`  [Fill] Order ${os.status}`);
            break;
          }
        }
      } catch {}
    }

    // ALWAYS cancel after 5 seconds (safety — avoid holding positions)
    console.log(`  [Cancel] Cancelling order to avoid risk...`);
    try {
      await clobClient.cancelOrder({ orderID: ordId });
      console.log(`  [Cancel] ✅ Cancelled: ${ordId.slice(0, 24)}`);
    } catch (err: any) {
      console.log(`  [Cancel] ${err.message || 'Already filled/cancelled'}`);
    }

  } catch (err: any) {
    result.error = err.message || String(err);
    console.error(`  [Order] ❌ Error: ${result.error}`);
  }

  return result;
}

async function main() {
  const mode = process.argv[2] || 'auto';

  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║   Order Placement Test (auto-cancel after 5s)         ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');

  const clobClient = await initClient();
  console.log('[Init] ✅ CLOB ready\n');

  const market = await getCurrentMarket();
  console.log(`[Market] ${market.question}`);
  console.log(`[Market] ${market.slug} | -${market.secsLeft}s remaining`);

  const upBook = await getOrderbook(clobClient, market.upToken, 'Up');
  const downBook = await getOrderbook(clobClient, market.downToken, 'Down');
  console.log(`[Book] Up:   ask=${upBook.bestAsk?.toFixed(3) || 'null'} bid=${upBook.bestBid?.toFixed(3) || 'null'} depth=${upBook.askDepth.toFixed(0)}`);
  console.log(`[Book] Down: ask=${downBook.bestAsk?.toFixed(3) || 'null'} bid=${downBook.bestBid?.toFixed(3) || 'null'} depth=${downBook.askDepth.toFixed(0)}`);

  // === MINIMUM SIZE TEST ===
  if (mode === 'mintest') {
    console.log('\n═══════════════════════════════════════════════════════');
    console.log('  MINIMUM ORDER SIZE TEST — testing 1, 2, 3, 5 shares');
    console.log('═══════════════════════════════════════════════════════');

    // Use a very low price to minimize cost (buy the cheap/losing side)
    const cheapSide = (upBook.bestAsk || 1) < (downBook.bestAsk || 1) ? 'Up' : 'Down';
    const cheapToken = cheapSide === 'Up' ? market.upToken : market.downToken;
    const cheapBook = cheapSide === 'Up' ? upBook : downBook;
    const testPrice = cheapBook.bestBid ? cheapBook.bestBid + 0.01 : 0.10;

    console.log(`\n  Testing on ${cheapSide} side @ ${(testPrice * 100).toFixed(0)}c (cheap side to minimize risk)\n`);

    for (const testShares of [1, 2, 3, 5]) {
      console.log(`\n  ─── Testing ${testShares} shares @ ${(testPrice * 100).toFixed(0)}c = $${(testShares * testPrice).toFixed(2)} ───`);
      const result = await placeAndCancelOrder(clobClient, cheapToken, cheapSide, testPrice, testShares);

      if (result.success) {
        console.log(`  → ${testShares} shares: ✅ ACCEPTED (orderId: ${result.orderId?.slice(0, 16)})`);
      } else {
        console.log(`  → ${testShares} shares: ❌ REJECTED (${result.error})`);
      }
      await sleep(1000); // Brief pause between tests
    }

    console.log('\n═══════════════════════════════════════════════════════');
    console.log('  MINIMUM SIZE TEST COMPLETE');
    console.log('═══════════════════════════════════════════════════════\n');
    return;
  }

  // === SINGLE ORDER TEST ===
  let orderSide: string;
  let orderToken: string;
  let orderPrice: number;
  let orderShares: number;

  if (mode === 'auto') {
    orderShares = parseFloat(process.argv[3] || '5');
    const upAsk = upBook.bestAsk || 0;
    const downAsk = downBook.bestAsk || 0;

    if (upAsk >= downAsk && upAsk > 0.5 && upBook.bestAsk) {
      orderSide = 'Up';
      orderToken = market.upToken;
      orderPrice = Math.round((upBook.bestAsk! - 0.01) * 100) / 100;
    } else if (downAsk > 0.5 && downBook.bestAsk) {
      orderSide = 'Down';
      orderToken = market.downToken;
      orderPrice = Math.round((downBook.bestAsk! - 0.01) * 100) / 100;
    } else {
      // Both near 50/50 — use whichever has an ask
      orderSide = upBook.bestAsk ? 'Up' : 'Down';
      orderToken = orderSide === 'Up' ? market.upToken : market.downToken;
      const book = orderSide === 'Up' ? upBook : downBook;
      orderPrice = book.bestAsk ? Math.round((book.bestAsk - 0.01) * 100) / 100 : 0.50;
    }
  } else {
    orderSide = mode;
    orderToken = mode === 'Up' ? market.upToken : market.downToken;
    orderPrice = parseFloat(process.argv[3] || '0.90');
    orderShares = parseFloat(process.argv[4] || '5');
  }

  console.log('\n═══════════════════════════════════════════════════════');
  console.log(`  SINGLE ORDER TEST: ${orderSide} @ ${(orderPrice * 100).toFixed(0)}c × ${orderShares} shares`);
  console.log('═══════════════════════════════════════════════════════');

  const result = await placeAndCancelOrder(clobClient, orderToken, orderSide, orderPrice, orderShares);

  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  RESULT');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  Order posted:  ${result.success ? '✅' : '❌'}`);
  console.log(`  Order ID:      ${result.orderId || 'none'}`);
  console.log(`  Filled:        ${result.filled ? `✅ ${result.filledSize.toFixed(2)} shares @ ${(result.fillPrice * 100).toFixed(1)}c` : 'No (cancelled after 5s)'}`);
  if (result.error) console.log(`  Error:         ${result.error}`);
  console.log('═══════════════════════════════════════════════════════\n');
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
