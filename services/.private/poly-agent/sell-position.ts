/**
 * sell-position.ts — place a single GTD SELL order for a specific token.
 *
 * Usage:
 *   npx tsx sell-position.ts --token <tokenId> --size <shares> [--price <0.xxx>]
 *
 * If --price is omitted, fetches live orderbook and uses bestBid + 0.5¢.
 *
 * Example:
 *   npx tsx sell-position.ts \
 *     --token 6532065038074852... \
 *     --size 24.42
 */

import { Side, OrderType } from '@polymarket/clob-client';
import { createClobClient } from './src/clob/client';
import { config } from './src/config';

// ── Parse CLI args ────────────────────────────────────────────────────────────
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

const size = parseFloat(sizeArg!);
if (isNaN(size) || size <= 0) { console.error('Invalid --size'); process.exit(1); }

// ── Fetch best bid from CLOB orderbook ───────────────────────────────────────
async function fetchBestBid(token: string): Promise<number> {
  const url = `${config.clobApiBase}/book?token_id=${token}`;
  const res  = await fetch(url);
  if (!res.ok) throw new Error(`Orderbook fetch failed: ${res.status}`);
  const book: any = await res.json();
  const bids: { price: string }[] = book.bids ?? [];
  if (bids.length === 0) throw new Error('No bids in orderbook — market may be closed');
  return parseFloat(bids[0].price);
}

async function main() {
  // Resolve price: use --price if given, else bestBid + 0.5¢
  let price: number;
  if (priceArg) {
    price = parseFloat(priceArg);
    if (isNaN(price) || price <= 0 || price >= 1) {
      console.error('Invalid --price (must be between 0 and 1)');
      process.exit(1);
    }
    console.log(`\nUsing manual price: $${price}`);
  } else {
    console.log('\nFetching live orderbook...');
    const bestBid = await fetchBestBid(tokenId!);
    price = parseFloat(Math.min(0.999, bestBid + 0.005).toFixed(4));
    console.log(`Best bid: $${bestBid}  →  Sell price: $${price} (bestBid + 0.5¢)`);
  }

  console.log('\n══════════════════════════════════════════');
  console.log('  SELL ORDER');
  console.log('══════════════════════════════════════════');
  console.log(`  Token   : ${tokenId}`);
  console.log(`  Size    : ${size} shares`);
  console.log(`  Price   : $${price}`);
  console.log(`  Value   : ~$${(size * price).toFixed(2)} USDC`);
  console.log('══════════════════════════════════════════\n');

  const { client } = await createClobClient();

  const expiration = Math.floor(Date.now() / 1000) + 60 + 30;
  let feeRateBps = 0;

  async function tryPlace(fee: number) {
    const order = await client.createOrder({
      tokenID:    tokenId!,
      price,
      size,
      side:       Side.SELL,
      feeRateBps: fee,
      nonce:      0,
      expiration,
    });
    return client.postOrder(order, OrderType.GTD);
  }

  let resp: any = await tryPlace(feeRateBps);

  // Fee correction if needed
  const respError = String(resp?.error ?? resp?.errorMsg ?? '');
  const feeMatch  = respError.match(/current market's (?:taker|maker) fee:\s*(\d+)/i);
  if (feeMatch) {
    feeRateBps = parseInt(feeMatch[1]);
    console.log(`Fee correction: retrying at ${feeRateBps} bps`);
    resp = await tryPlace(feeRateBps);
  }

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
