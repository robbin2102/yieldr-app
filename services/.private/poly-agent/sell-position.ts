/**
 * sell-position.ts — manual SELL or BUY limit order with GTD fill tracking.
 *
 * Usage:
 *   SELL (GTT passive → midpoint → cross, mirrors bot executor):
 *     npx tsx sell-position.ts --token <tokenId> --size <shares>
 *
 *   BUY limit (at a specified price, retries if expired):
 *     npx tsx sell-position.ts --buy --token <tokenId> --size <shares> --price <0.xxx>
 *
 * SELL aggression per attempt (same as bot GTTExecutor):
 *   Attempt 1: bestAsk              — passive maker, waits for buyer
 *   Attempt 2: midpoint             — (bestBid + bestAsk) / 2
 *   Attempt 3: bestBid + $0.001     — just above bid, near-certain fill
 *   Attempt 4: bestBid (market)     — only if spread < 3%; skipped if spread ≥ 3%
 *
 * BUY:
 *   Places GTD order at --price. Retries up to 3 attempts at same price
 *   (price refreshed each attempt so midpoint/bid/ask stay current).
 *   Omit --price to default to bestAsk (immediate taker fill).
 */

import WebSocket from 'ws';
import { Side, OrderType } from '@polymarket/clob-client';
import { createClobClient } from './src/clob/client';
import { config } from './src/config';

const MAX_ATTEMPTS = 3;
const GTD_SECONDS  = 30;

// ── CLI args ──────────────────────────────────────────────────────────────────
function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const isBuy   = flag('buy');
const tokenId = arg('token');
const sizeArg = arg('size');
const priceArg = arg('price');

if (!tokenId || !sizeArg) {
  console.error('Usage:');
  console.error('  SELL: npx tsx sell-position.ts --token <tokenId> --size <shares>');
  console.error('  BUY:  npx tsx sell-position.ts --buy --token <tokenId> --size <shares> --price <0.xxx>');
  process.exit(1);
}
if (isBuy && !priceArg) {
  console.error('BUY mode requires --price <0.xxx>');
  process.exit(1);
}

const totalSize  = parseFloat(sizeArg!);
const fixedPrice = priceArg ? parseFloat(priceArg) : undefined;
if (isNaN(totalSize) || totalSize <= 0) { console.error('Invalid --size'); process.exit(1); }
if (fixedPrice !== undefined && (isNaN(fixedPrice) || fixedPrice <= 0 || fixedPrice >= 1)) {
  console.error('--price must be between 0 and 1 exclusive'); process.exit(1);
}

// ── Fetch fee rate ────────────────────────────────────────────────────────────
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

// ── SELL price per attempt (mirrors bot GTTExecutor SELL aggression) ──────────
// Attempt 1: passive — post at bestAsk, wait for buyer to come to us
// Attempt 2: midpoint — split the spread
// Attempt 3: cross   — bestBid + $0.005, crosses spread for immediate fill
function sellPrice(bestBid: number, bestAsk: number, attempt: number): number {
  if (fixedPrice !== undefined) return fixedPrice;
  const spread = bestAsk - bestBid;
  const fractions = [0, 0.5, 1.0];
  const fraction  = fractions[attempt - 1] ?? 1.0;
  const raw = Math.max(bestAsk - spread * fraction, bestBid + 0.005);
  return parseFloat(Math.min(0.999, Math.max(0.001, raw)).toFixed(4));
}

// ── BUY price (fixed --price, refreshed book each retry) ─────────────────────
function buyPrice(bestBid: number, bestAsk: number): number {
  if (fixedPrice !== undefined) return fixedPrice;
  return parseFloat(Math.min(0.999, bestAsk).toFixed(4)); // default: bestAsk (immediate fill)
}

// ── WebSocket: wait for fill or expiry of a specific order ───────────────────
function waitForFillOrExpiry(orderId: string, targetSize: number): Promise<{ result: 'filled' | 'expired'; filledSize: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(config.wssUser);
    let filledSize = 0;
    let resolved   = false;

    const done = (result: 'filled' | 'expired') => {
      if (resolved) return;
      resolved = true;
      ws.close();
      resolve({ result, filledSize });
    };

    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'user', markets: [],
        auth: { apiKey: config.apiKey, secret: config.apiSecret, passphrase: config.passphrase },
      }));
    });

    ws.on('message', (raw) => {
      const text = raw.toString();
      if (text === 'PONG') return;
      let msg: any;
      try { msg = JSON.parse(text); } catch { return; }

      if (msg.event_type === 'trade') {
        const makerOrderId: string = (msg.maker_orders as any[])?.[0]?.order_id ?? '';
        const takerOrderId: string = msg.taker_order_id ?? '';
        if (makerOrderId === orderId || takerOrderId === orderId) {
          const fill = parseFloat(msg.size ?? '0');
          filledSize += fill;
          console.log(`  📥 Fill: +${fill.toFixed(4)} sh @ $${parseFloat(msg.price ?? '0').toFixed(4)}  (total: ${filledSize.toFixed(4)}/${targetSize.toFixed(4)})`);
          if (filledSize >= targetSize * 0.9) done('filled');
        }
      } else if (msg.event_type === 'order' && msg.type === 'CANCELLATION' && msg.id === orderId) {
        if (filledSize > 0) {
          console.log(`  ⚠️  Partial fill ${filledSize.toFixed(4)} sh then expired`);
          done('filled');
        } else {
          done('expired');
        }
      }
    });

    ws.on('error', (err) => { console.warn(`  WS error: ${err.message}`); done('expired'); });
    ws.on('close', () => { if (!resolved) done('expired'); });
    setTimeout(() => { if (!resolved) { console.warn(`  WS timeout`); done('expired'); } }, (GTD_SECONDS + 15) * 1000);
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const side      = isBuy ? 'BUY' : 'SELL';
  const sideLabel = isBuy ? Side.BUY : Side.SELL;

  console.log(`\nFetching orderbook and fee rate...`);
  const [book, feeRateBps] = await Promise.all([fetchBook(), fetchFeeRate(tokenId!)]);
  console.log(`Orderbook: bid $${book.bestBid}  ask $${book.bestAsk}  spread ${((book.bestAsk - book.bestBid) * 100).toFixed(1)}%`);
  const { client } = await createClobClient();

  let remainingSize = totalSize;
  let totalFilledSize = 0;
  let totalFilledCost = 0;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const freshBook  = attempt === 1 ? book : await fetchBook();
    const price      = isBuy
      ? buyPrice(freshBook.bestBid, freshBook.bestAsk)
      : sellPrice(freshBook.bestBid, freshBook.bestAsk, attempt);
    const expiration = Math.floor(Date.now() / 1000) + 60 + GTD_SECONDS;

    const aggrLabel  = isBuy
      ? (fixedPrice ? 'limit' : 'taker')
      : (['passive', 'midpoint', 'cross'][attempt - 1] ?? 'cross');

    console.log(`\n── Attempt ${attempt}/${MAX_ATTEMPTS}  [${aggrLabel}] ──────────────────────────────────`);
    console.log(`  Bid $${freshBook.bestBid.toFixed(4)}  Ask $${freshBook.bestAsk.toFixed(4)}`);
    console.log(`  ${side} ${remainingSize.toFixed(4)} sh @ $${price}  ≈ $${(remainingSize * price).toFixed(2)} USDC`);

    const order = await client.createOrder({
      tokenID: tokenId!, price, size: remainingSize,
      side: sideLabel, feeRateBps, nonce: 0, expiration,
    });

    const resp: any = await client.postOrder(order, OrderType.GTD);
    const orderId = resp?.orderID ?? resp?.id ?? '';

    if (!orderId) {
      const errMsg = String(resp?.error ?? resp?.errorMsg ?? JSON.stringify(resp)).slice(0, 200);
      console.error(`  ❌ Order rejected: ${errMsg}`);
      process.exit(1);
    }

    console.log(`  → order ${orderId.slice(0, 14)}...`);
    console.log(`  Waiting for fill (${GTD_SECONDS}s)...`);

    const { result, filledSize } = await waitForFillOrExpiry(orderId, remainingSize);

    if (filledSize > 0) {
      totalFilledSize += filledSize;
      totalFilledCost += filledSize * price;
      remainingSize    = Math.max(0, remainingSize - filledSize);
    }

    if (result === 'filled') {
      const avgPrice = totalFilledCost / totalFilledSize;
      console.log(`\n✅ ${side} COMPLETE`);
      console.log(`   Filled: ${totalFilledSize.toFixed(4)} sh  avg $${avgPrice.toFixed(4)}  ≈ $${totalFilledCost.toFixed(2)} USDC`);
      console.log(`   Check: https://polymarket.com/portfolio\n`);
      process.exit(0);
    }

    console.log(`  ⏱  Expired unfilled`);
    if (attempt < MAX_ATTEMPTS) {
      const nextLabel = isBuy ? 'same price' : ['midpoint', 'cross'][attempt - 1] ?? 'cross';
      console.log(`  Retrying (${nextLabel})...`);
    }
  }

  // ── Attempt 4: market sell at bestBid (only if spread < 3%) ──────────────────
  if (!isBuy && !fixedPrice) {
    const freshBook4  = await fetchBook();
    const spread4     = freshBook4.bestAsk > 0
      ? (freshBook4.bestAsk - freshBook4.bestBid) / freshBook4.bestAsk
      : 1;
    const spreadPct4  = (spread4 * 100).toFixed(2);

    console.log(`\n── Attempt 4/4  [market-bid] ──────────────────────────────────`);
    console.log(`  Bid $${freshBook4.bestBid.toFixed(4)}  Ask $${freshBook4.bestAsk.toFixed(4)}  spread ${spreadPct4}%`);

    if (spread4 >= 0.03) {
      console.error(`  Spread ${spreadPct4}% ≥ 3% — skipping market fill to avoid wide-spread loss.`);
    } else {
      const price4      = parseFloat(Math.max(0.001, freshBook4.bestBid).toFixed(4));
      const expiration4 = Math.floor(Date.now() / 1000) + 60 + GTD_SECONDS;
      console.log(`  SELL ${remainingSize.toFixed(4)} sh @ $${price4}  ≈ $${(remainingSize * price4).toFixed(2)} USDC  (market/taker)`);

      const order4 = await client.createOrder({
        tokenID: tokenId!, price: price4, size: remainingSize,
        side: Side.SELL, feeRateBps, nonce: 0, expiration: expiration4,
      });

      const resp4: any = await client.postOrder(order4, OrderType.GTD);
      const orderId4   = resp4?.orderID ?? resp4?.id ?? '';

      if (!orderId4) {
        const errMsg = String(resp4?.error ?? resp4?.errorMsg ?? JSON.stringify(resp4)).slice(0, 200);
        console.error(`  ❌ Order rejected: ${errMsg}`);
      } else {
        console.log(`  → order ${orderId4.slice(0, 14)}...`);
        console.log(`  Waiting for fill (${GTD_SECONDS}s)...`);

        const { result: result4, filledSize: filled4 } = await waitForFillOrExpiry(orderId4, remainingSize);

        if (filled4 > 0) {
          totalFilledSize += filled4;
          totalFilledCost += filled4 * price4;
        }

        if (result4 === 'filled') {
          const avgPrice = totalFilledCost / totalFilledSize;
          console.log(`\n✅ SELL COMPLETE (market fill)`);
          console.log(`   Filled: ${totalFilledSize.toFixed(4)} sh  avg $${avgPrice.toFixed(4)}  ≈ $${totalFilledCost.toFixed(2)} USDC`);
          console.log(`   Check: https://polymarket.com/portfolio\n`);
          process.exit(0);
        }
        console.log(`  ⏱  Expired unfilled`);
      }
    }
  }

  const summary = totalFilledSize > 0
    ? `Partially filled ${totalFilledSize.toFixed(4)}/${totalSize} sh @ avg $${(totalFilledCost / totalFilledSize).toFixed(4)}`
    : `No fill after 4 attempts`;
  console.error(`\n❌ ${summary}. Market may be illiquid.`);
  process.exit(totalFilledSize > 0 ? 0 : 1);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
