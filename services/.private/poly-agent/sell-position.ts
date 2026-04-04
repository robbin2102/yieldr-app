/**
 * sell-position.ts — place a GTD SELL order and confirm fill via WebSocket.
 *
 * Usage:
 *   npx tsx sell-position.ts --token <tokenId> --size <shares> [--price <0.xxx>]
 *
 * Flow:
 *   1. Fetch fee rate from CLOB API (no error-retry round trip)
 *   2. Fetch live orderbook
 *   3. Connect to Polymarket WebSocket User Channel
 *   4. Place GTD SELL order
 *   5. Wait for fill event (trade) or expiry event (order CANCELLATION)
 *   6. If expired: retry with increasing aggression (up to 3 attempts)
 *
 * Pricing strategy per attempt:
 *   Attempt 1: bestBid        — crosses the spread, near-instant taker fill
 *   Attempt 2: bestBid - 1¢   — more aggressive
 *   Attempt 3: bestBid - 2¢   — very aggressive, near-certain fill
 *
 * Example:
 *   npx tsx sell-position.ts --token 163266... --size 67.52
 */

import WebSocket from 'ws';
import { Side, OrderType } from '@polymarket/clob-client';
import { createClobClient } from './src/clob/client';
import { config } from './src/config';

const MAX_ATTEMPTS = 3;
const GTD_SECONDS  = 30;   // expiry window per attempt

// ── CLI args ──────────────────────────────────────────────────────────────────
function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

const tokenId  = arg('token');
const sizeArg  = arg('size');
const priceArg = arg('price');

if (!tokenId || !sizeArg) {
  console.error('Usage: npx tsx sell-position.ts --token <tokenId> --size <shares> [--price <0.xxx>]');
  process.exit(1);
}

const totalSize = parseFloat(sizeArg!);
if (isNaN(totalSize) || totalSize <= 0) { console.error('Invalid --size'); process.exit(1); }

// ── Fetch fee rate upfront — no error-retry round trip ────────────────────────
async function fetchFeeRate(token: string): Promise<number> {
  try {
    const res  = await fetch(`${config.clobApiBase}/fee-rate?token_id=${token}`);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = await res.json() as any;
    const bps  = data.base_fee ?? data.fee_rate_bps ?? data.maker_fee_rate ?? data.makerFeeRate;
    if (bps !== undefined && bps !== null) {
      const rate = parseInt(String(bps), 10);
      console.log(`Fee rate: ${rate} bps (from API)`);
      return rate;
    }
  } catch (e: any) {
    console.warn(`Fee rate API failed (${e.message}) — using config default ${config.feeRateBps} bps`);
  }
  return config.feeRateBps;
}

// ── Fetch orderbook ───────────────────────────────────────────────────────────
async function fetchBook(): Promise<{ bestBid: number; bestAsk: number }> {
  const res  = await fetch(`${config.clobApiBase}/book?token_id=${tokenId}`);
  if (!res.ok) throw new Error(`Orderbook fetch failed: ${res.status}`);
  const book: any = await res.json();
  const bids: { price: string }[] = book.bids ?? [];
  const asks: { price: string }[] = book.asks ?? [];
  if (bids.length === 0) throw new Error('No bids in orderbook — market may be closed');
  const bestBid = Math.max(...bids.map(b => parseFloat(b.price)));
  const bestAsk = asks.length > 0 ? Math.min(...asks.map(a => parseFloat(a.price))) : bestBid + 0.01;
  return { bestBid, bestAsk };
}

// ── Sell price per attempt — increasing aggression ────────────────────────────
// Attempt 1: sell @ bestBid       → crosses the spread, taker fill
// Attempt 2: sell @ bestBid - 1¢  → more aggressive
// Attempt 3: sell @ bestBid - 2¢  → very aggressive
function sellPrice(bestBid: number, attempt: number): number {
  if (priceArg) return parseFloat(priceArg);
  const offsets = [0, 0.01, 0.02];
  const offset  = offsets[attempt - 1] ?? 0.02;
  return parseFloat(Math.max(0.001, bestBid - offset).toFixed(4));
}

// ── WebSocket User Channel — listen for fill or expiry of a specific order ────
function waitForFillOrExpiry(orderId: string): Promise<'filled' | 'expired'> {
  return new Promise((resolve) => {
    const ws = new WebSocket(config.wssUser);

    let filledSize = 0;
    let resolved   = false;

    const done = (result: 'filled' | 'expired') => {
      if (resolved) return;
      resolved = true;
      ws.close();
      resolve(result);
    };

    ws.on('open', () => {
      ws.send(JSON.stringify({
        type:    'user',
        markets: [],
        auth: {
          apiKey:     config.apiKey,
          secret:     config.apiSecret,
          passphrase: config.passphrase,
        },
      }));
    });

    ws.on('message', (raw) => {
      const text = raw.toString();
      if (text === 'PONG') return;

      let msg: any;
      try { msg = JSON.parse(text); } catch { return; }

      if (msg.event_type === 'trade') {
        // Maker fill: our orderId appears as maker_order_id
        // Taker fill: our orderId appears as taker_order_id
        if (msg.maker_order_id === orderId || msg.taker_order_id === orderId) {
          const fill = parseFloat(msg.size ?? '0');
          filledSize += fill;
          console.log(`  📥 Fill event: +${fill.toFixed(4)} shares @ $${parseFloat(msg.price ?? '0').toFixed(4)} (total filled: ${filledSize.toFixed(4)})`);
          if (filledSize >= totalSize * 0.9) {
            done('filled');
          }
        }
      } else if (msg.event_type === 'order' && msg.type === 'CANCELLATION') {
        if (msg.id === orderId) {
          if (filledSize > 0) {
            console.log(`  ⚠️  Partially filled (${filledSize.toFixed(4)} / ${totalSize} shares) then expired`);
            done('filled'); // partial is acceptable — don't retry
          } else {
            done('expired');
          }
        }
      }
    });

    ws.on('error', (err) => {
      console.warn(`  WS error: ${err.message}`);
      done('expired'); // treat as expired, will retry
    });

    ws.on('close', () => {
      if (!resolved) done('expired');
    });

    // Safety timeout slightly longer than GTD window
    setTimeout(() => {
      if (!resolved) {
        console.warn(`  WS timeout after ${GTD_SECONDS + 15}s`);
        done('expired');
      }
    }, (GTD_SECONDS + 15) * 1000);
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\nFetching orderbook and fee rate...');
  const [book, feeRateBps] = await Promise.all([fetchBook(), fetchFeeRate(tokenId!)]);
  const { client } = await createClobClient();

  let remainingSize = totalSize;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Refresh orderbook on each retry for fresh price
    const freshBook = attempt === 1 ? book : await fetchBook();
    const price     = sellPrice(freshBook.bestBid, attempt);
    const expiration = Math.floor(Date.now() / 1000) + 60 + GTD_SECONDS;

    console.log(`\n── Attempt ${attempt}/${MAX_ATTEMPTS} ─────────────────────────────────────────`);
    console.log(`  Best bid: $${freshBook.bestBid}  |  Best ask: $${freshBook.bestAsk}`);
    console.log(`  Sell price: $${price}  |  Size: ${remainingSize.toFixed(4)} shares  |  ~$${(remainingSize * price).toFixed(2)} USDC`);

    const order = await client.createOrder({
      tokenID:    tokenId!,
      price,
      size:       remainingSize,
      side:       Side.SELL,
      feeRateBps,
      nonce:      0,
      expiration,
    });

    const resp: any = await client.postOrder(order, OrderType.GTD);
    const orderId = resp?.orderID ?? resp?.id ?? '';

    if (!orderId) {
      console.error('  ❌ Order rejected:', JSON.stringify(resp));
      process.exit(1);
    }

    console.log(`  ✅ Order placed: ${orderId}`);
    console.log(`  Waiting for fill (${GTD_SECONDS}s window)...`);

    const result = await waitForFillOrExpiry(orderId);

    if (result === 'filled') {
      console.log(`\n✅ SELL COMPLETE — ${remainingSize.toFixed(4)} shares sold @ ~$${price}`);
      console.log(`   Estimated proceeds: ~$${(remainingSize * price).toFixed(2)} USDC`);
      console.log(`   Check at: https://polymarket.com/portfolio\n`);
      process.exit(0);
    }

    console.log(`  ⏱  Order expired unfilled`);
    if (attempt < MAX_ATTEMPTS) {
      console.log(`  Retrying with more aggressive price...`);
    }
  }

  console.error(`\n❌ Could not fill after ${MAX_ATTEMPTS} attempts. Market may be illiquid.`);
  console.error(`   Try a lower price manually: npx tsx sell-position.ts --token ${tokenId} --size ${remainingSize} --price <lower>\n`);
  process.exit(1);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
