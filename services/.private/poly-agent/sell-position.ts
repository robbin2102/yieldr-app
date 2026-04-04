/**
 * sell-position.ts — place a GTD SELL order for a specific token.
 *
 * Usage:
 *   npx tsx sell-position.ts --token <tokenId> --size <shares> [--price <0.xxx>] [--passive]
 *
 * Pricing (default: aggressive — crosses spread for immediate fill):
 *   default   → sell @ bestBid - 0.001  (crosses spread, near-certain fill)
 *   --passive → sell @ bestBid + 0.5¢   (maker, waits in book)
 *
 * Fee rate: fetched from CLOB API before signing (no error-retry round trip).
 *
 * Example:
 *   npx tsx sell-position.ts --token 163266... --size 67.52
 */

import { Side, OrderType } from '@polymarket/clob-client';
import { createClobClient } from './src/clob/client';
import { config } from './src/config';

// ── Parse CLI args ────────────────────────────────────────────────────────────
function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}
const hasFlag = (name: string) => process.argv.includes(`--${name}`);

const tokenId  = arg('token');
const sizeArg  = arg('size');
const priceArg = arg('price');
const passive  = hasFlag('passive');

if (!tokenId || !sizeArg) {
  console.error('Usage: npx tsx sell-position.ts --token <tokenId> --size <shares> [--price <0.xxx>] [--passive]');
  process.exit(1);
}

const size = parseFloat(sizeArg!);
if (isNaN(size) || size <= 0) { console.error('Invalid --size'); process.exit(1); }

// ── Fetch fee rate from CLOB API (before signing — no error-retry round trip) ──
async function fetchFeeRate(token: string): Promise<number> {
  try {
    const res = await fetch(`${config.clobApiBase}/fee-rate?token_id=${token}`);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = await res.json() as any;
    const bps = data.base_fee ?? data.fee_rate_bps ?? data.maker_fee_rate ?? data.makerFeeRate;
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
async function fetchBook(token: string): Promise<{ bestBid: number; bestAsk: number }> {
  const res  = await fetch(`${config.clobApiBase}/book?token_id=${token}`);
  if (!res.ok) throw new Error(`Orderbook fetch failed: ${res.status}`);
  const book: any = await res.json();
  const bids: { price: string }[] = book.bids ?? [];
  const asks: { price: string }[] = book.asks ?? [];
  if (bids.length === 0) throw new Error('No bids in orderbook — market may be closed');
  const bestBid = Math.max(...bids.map(b => parseFloat(b.price)));
  const bestAsk = asks.length > 0 ? Math.min(...asks.map(a => parseFloat(a.price))) : bestBid + 0.01;
  return { bestBid, bestAsk };
}

async function main() {
  console.log('\nFetching live orderbook and fee rate...');
  const [{ bestBid, bestAsk }, feeRateBps] = await Promise.all([
    fetchBook(tokenId!),
    fetchFeeRate(tokenId!),
  ]);

  // Price resolution
  let price: number;
  if (priceArg) {
    price = parseFloat(priceArg);
    if (isNaN(price) || price <= 0 || price >= 1) {
      console.error('Invalid --price (must be between 0 and 1)');
      process.exit(1);
    }
    console.log(`Using manual price: $${price}`);
  } else if (passive) {
    // Maker: post just inside ask — sits in book, waits for buyer
    price = parseFloat(Math.min(0.999, bestBid + 0.005).toFixed(4));
    console.log(`Best bid: $${bestBid}  |  Best ask: $${bestAsk}  →  Passive sell @ $${price} (bestBid + 0.5¢)`);
  } else {
    // Aggressive: sell just above bid so a taker crosses immediately
    price = parseFloat(Math.max(0.001, bestBid - 0.001).toFixed(4));
    console.log(`Best bid: $${bestBid}  |  Best ask: $${bestAsk}  →  Aggressive sell @ $${price} (bestBid - 0.1¢, near-certain fill)`);
  }

  console.log('\n══════════════════════════════════════════');
  console.log('  SELL ORDER');
  console.log('══════════════════════════════════════════');
  console.log(`  Token   : ${tokenId}`);
  console.log(`  Size    : ${size} shares`);
  console.log(`  Price   : $${price}`);
  console.log(`  Value   : ~$${(size * price).toFixed(2)} USDC`);
  console.log(`  Fee     : ${feeRateBps} bps`);
  console.log('══════════════════════════════════════════\n');

  const { client } = await createClobClient();

  const expiration = Math.floor(Date.now() / 1000) + 120; // 2 min window

  const order = await client.createOrder({
    tokenID:    tokenId!,
    price,
    size,
    side:       Side.SELL,
    feeRateBps,
    nonce:      0,
    expiration,
  });

  const resp: any = await client.postOrder(order, OrderType.GTD);

  const orderId = resp?.orderID ?? resp?.id ?? '';
  if (!orderId) {
    console.error('Order failed. Response:', JSON.stringify(resp, null, 2));
    process.exit(1);
  }

  console.log(`✅ Order placed: ${orderId}`);
  console.log(`   Check at: https://polymarket.com/portfolio\n`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
