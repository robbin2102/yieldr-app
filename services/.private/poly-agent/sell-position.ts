/**
 * sell-position.ts — place a single GTD SELL order for a specific token.
 *
 * Usage:
 *   npx tsx sell-position.ts --token <tokenId> --size <shares> --price <0.xxx>
 *
 * Example (sell all 24.64 No-shares @ $0.992):
 *   npx tsx sell-position.ts \
 *     --token 7790778861325910... \
 *     --size 24.64 \
 *     --price 0.992
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

if (!tokenId || !sizeArg || !priceArg) {
  console.error('Usage: npx tsx sell-position.ts --token <tokenId> --size <shares> --price <0.xxx>');
  process.exit(1);
}

const size  = parseFloat(sizeArg);
const price = parseFloat(priceArg);

if (isNaN(size) || size <= 0)          { console.error('Invalid --size'); process.exit(1); }
if (isNaN(price) || price <= 0 || price >= 1) { console.error('Invalid --price (must be between 0 and 1)'); process.exit(1); }

async function main() {
  console.log('\n══════════════════════════════════════════');
  console.log('  SELL ORDER');
  console.log('══════════════════════════════════════════');
  console.log(`  Token   : ${tokenId}`);
  console.log(`  Side    : SELL`);
  console.log(`  Size    : ${size} shares`);
  console.log(`  Price   : $${price}`);
  console.log(`  Value   : ~$${(size * price).toFixed(2)} USDC`);
  console.log('══════════════════════════════════════════\n');

  const { client } = await createClobClient();

  // GTD expiry: now + 60s (API min) + 30s active window
  const expiration = Math.floor(Date.now() / 1000) + 60 + 30;

  // Try with 0 fee first (maker); auto-correct if market charges a fee
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

    const resp = await client.postOrder(order, OrderType.GTD);
    return resp;
  }

  let resp: any = await tryPlace(feeRateBps);

  // Handle fee correction (clob-client returns error in response body, doesn't throw)
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

  console.log(`✅ Order placed!`);
  console.log(`   Order ID : ${orderId}`);
  console.log(`   Check at : https://polymarket.com/portfolio\n`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
