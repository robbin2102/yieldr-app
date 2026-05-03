/**
 * sell-position.ts — manual SELL or BUY limit order using CLOBv2.
 *
 * Usage:
 *   SELL (passive → midpoint → cross → market-bid):
 *     npx tsx sell-position.ts --token <tokenId> --size <shares>
 *
 *   BUY limit (at a specified price, retries if expired):
 *     npx tsx sell-position.ts --buy --token <tokenId> --size <shares> --price <0.xxx>
 *
 *   Flags:
 *     --neg-risk    pass if this is a NEG_RISK/NEG_RISK_V2 market (default: false)
 *
 * SELL aggression per attempt (mirrors bot GTDExecutorV2):
 *   Attempt 1: bestAsk              — passive maker
 *   Attempt 2: midpoint             — (bestBid + bestAsk) / 2
 *   Attempt 3: bestBid + $0.001     — just above bid, near-certain fill
 *   Attempt 4: bestBid (market)     — only if spread < 3%
 */

import { config as dotenvConfig } from 'dotenv';
import { resolve } from 'path';
import { existsSync } from 'fs';
import WebSocket from 'ws';
import { ClobV2Client } from './src/v2/clob/clobV2Client';

// ── Env loading ───────────────────────────────────────────────────────────────
const envCandidates = [
  resolve(__dirname, '.env.polyagent'),
  resolve(__dirname, '.env.poly-agent'),
  resolve(__dirname, '.env.local'),
  resolve(__dirname, '.env'),
  resolve(__dirname, '../../.env.local'),
];
for (const p of envCandidates) {
  if (existsSync(p)) { dotenvConfig({ path: p }); break; }
}

const POLYGON_RPC_HTTP = (process.env.POLYGON_WS_URL || process.env.POLYGON_RPC_URL || '')
  .replace(/^wss?:\/\//, 'https://').replace(/^ws:\/\//, 'http://');

const CLOB_HOST  = process.env.CLOB_API_BASE || 'https://clob.polymarket.com';
const WSS_USER   = process.env.WSS_USER || 'wss://ws-subscriptions-clob.polymarket.com/ws/user';

const MAX_ATTEMPTS = 4;
const GTD_SECONDS  = 90;  // Polymarket enforces min expiry of now+60s; 90s gives 30s execution window

// ── CLI args ──────────────────────────────────────────────────────────────────
function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const isBuy    = flag('buy');
const negRisk  = flag('neg-risk');
const tokenId  = arg('token');
const sizeArg  = arg('size');
const priceArg = arg('price');

if (!tokenId || !sizeArg) {
  console.error('Usage:');
  console.error('  SELL: npx tsx sell-position.ts --token <tokenId> --size <shares> [--neg-risk]');
  console.error('  BUY:  npx tsx sell-position.ts --buy --token <tokenId> --size <shares> --price <0.xxx> [--neg-risk]');
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

// ── Fetch orderbook ───────────────────────────────────────────────────────────
async function fetchBook(): Promise<{ bestBid: number; bestAsk: number }> {
  // Convert hex tokenId to decimal for REST API calls
  const tokenIdDec = tokenId!.startsWith('0x') ? BigInt(tokenId!).toString() : tokenId!;
  const res  = await fetch(`${CLOB_HOST}/book?token_id=${tokenIdDec}`);
  if (!res.ok) throw new Error(`Orderbook fetch failed: ${res.status}`);
  const book: any = await res.json();
  const bids: { price: string }[] = book.bids ?? [];
  const asks: { price: string }[] = book.asks ?? [];
  if (bids.length === 0) throw new Error('No bids in orderbook — market may be closed');
  const bestBid = Math.max(...bids.map(b => parseFloat(b.price)));
  const bestAsk = asks.length > 0 ? Math.min(...asks.map(a => parseFloat(a.price))) : bestBid + 0.01;
  return { bestBid, bestAsk };
}

// ── SELL price per attempt ────────────────────────────────────────────────────
function sellPrice(bestBid: number, bestAsk: number, attempt: number): number {
  if (fixedPrice !== undefined) return fixedPrice;
  const spread     = bestAsk - bestBid;
  const fractions  = [0, 0.5, 1.0];
  const fraction   = fractions[attempt - 1] ?? 1.0;
  const raw        = Math.max(bestAsk - spread * fraction, bestBid + 0.001);
  return parseFloat(Math.min(0.999, Math.max(0.001, raw)).toFixed(4));
}

// ── WebSocket: wait for fill or expiry of a specific order ───────────────────
function waitForFillOrExpiry(orderId: string, targetSize: number): Promise<{ result: 'filled' | 'expired'; filledSize: number }> {
  const apiKey     = process.env.CLOB_V2_API_KEY    || process.env.POLYMARKET_API_KEY    || '';
  const apiSecret  = process.env.CLOB_V2_API_SECRET || process.env.POLYMARKET_API_SECRET || '';
  const passphrase = process.env.CLOB_V2_PASSPHRASE || process.env.POLYMARKET_PASSPHRASE || '';

  return new Promise((resolve) => {
    const ws = new WebSocket(WSS_USER);
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
        auth: { apiKey, secret: apiSecret, passphrase },
      }));
    });

    ws.on('message', (raw) => {
      const text = raw.toString();
      if (text === 'PONG') return;
      let msgs: any[];
      try { msgs = Array.isArray(JSON.parse(text)) ? JSON.parse(text) : [JSON.parse(text)]; } catch { return; }

      for (const msg of msgs) {
        if (msg.event_type === 'trade') {
          const makerOrderId: string = (msg.maker_orders as any[])?.[0]?.order_id ?? '';
          const takerOrderId: string = msg.taker_order_id ?? '';
          if (makerOrderId === orderId || takerOrderId === orderId) {
            const fill = parseFloat(msg.size ?? '0');
            filledSize += fill;
            console.log(`  Fill: +${fill.toFixed(4)} sh @ $${parseFloat(msg.price ?? '0').toFixed(4)}  (total: ${filledSize.toFixed(4)}/${targetSize.toFixed(4)})`);
            if (filledSize >= targetSize * 0.9) done('filled');
          }
        } else if (msg.event_type === 'order' && (msg.type === 'CANCELLATION' || msg.status === 'canceled') && (msg.id === orderId || msg.order_id === orderId)) {
          if (filledSize > 0) {
            console.log(`  Partial fill ${filledSize.toFixed(4)} sh then expired`);
            done('filled');
          } else {
            done('expired');
          }
        }
      }
    });

    ws.on('error', (err) => { console.warn(`  WS error: ${err.message}`); done('expired'); });
    ws.on('close', () => { if (!resolved) done('expired'); });
    setTimeout(() => { if (!resolved) { console.warn('  WS timeout'); done('expired'); } }, (GTD_SECONDS + 15) * 1000);
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const privateKey = process.env.BOT_PRIVATE_KEY || process.env.PRIVATE_KEY || '';
  const apiKey     = process.env.CLOB_V2_API_KEY    || process.env.POLYMARKET_API_KEY    || '';
  const apiSecret  = process.env.CLOB_V2_API_SECRET || process.env.POLYMARKET_API_SECRET || '';
  const passphrase = process.env.CLOB_V2_PASSPHRASE || process.env.POLYMARKET_PASSPHRASE || '';

  if (!privateKey) { console.error('Missing BOT_PRIVATE_KEY / PRIVATE_KEY'); process.exit(1); }
  if (!apiKey)     { console.error('Missing CLOB_V2_API_KEY / POLYMARKET_API_KEY'); process.exit(1); }
  if (!POLYGON_RPC_HTTP) { console.error('Missing POLYGON_WS_URL / POLYGON_RPC_URL'); process.exit(1); }

  const clob = await ClobV2Client.create({
    host:       CLOB_HOST,
    privateKey,
    apiKey,
    apiSecret,
    passphrase,
    polygonRpc: POLYGON_RPC_HTTP,
  });

  const side = isBuy ? 'BUY' : 'SELL';

  console.log(`\nFetching orderbook...`);
  const book = await fetchBook();
  console.log(`Orderbook: bid $${book.bestBid}  ask $${book.bestAsk}  spread ${((book.bestAsk - book.bestBid) / book.bestAsk * 100).toFixed(1)}%`);
  console.log(`Mode: ${side}  size=${totalSize}  negRisk=${negRisk}\n`);

  let remainingSize   = totalSize;
  let totalFilledSize = 0;
  let totalFilledCost = 0;

  const gtdAttempts = isBuy ? Math.min(MAX_ATTEMPTS, 3) : 3;

  for (let attempt = 1; attempt <= gtdAttempts; attempt++) {
    const freshBook = attempt === 1 ? book : await fetchBook();
    const price     = isBuy
      ? (fixedPrice ?? parseFloat(Math.min(0.999, freshBook.bestAsk).toFixed(4)))
      : sellPrice(freshBook.bestBid, freshBook.bestAsk, attempt);
    const expiresAt = Math.floor(Date.now() / 1000) + GTD_SECONDS;

    const aggrLabel = isBuy
      ? (fixedPrice ? 'limit' : 'taker')
      : (['passive', 'midpoint', 'cross'][attempt - 1] ?? 'cross');

    console.log(`── Attempt ${attempt}/${MAX_ATTEMPTS}  [${aggrLabel}] ──────────────────────────────────`);
    console.log(`  Bid $${freshBook.bestBid.toFixed(4)}  Ask $${freshBook.bestAsk.toFixed(4)}`);
    console.log(`  ${side} ${remainingSize.toFixed(4)} sh @ $${price}  ≈ $${(remainingSize * price).toFixed(2)} USDC`);

    let response: any;
    try {
      response = await clob.postGTDOrder({
        tokenId:   tokenId!,
        side,
        price,
        size:      remainingSize,
        negRisk,
        expiresAt,
      });
    } catch (err: any) {
      console.error(`  Order threw: ${err.message}`);
      process.exit(1);
    }

    const orderId = response?.orderID ?? '';
    if (!orderId || !response?.success) {
      const errMsg = String(response?.errorMsg ?? JSON.stringify(response)).slice(0, 200);
      console.error(`  Order rejected: ${errMsg}`);
      process.exit(1);
    }

    console.log(`  order ${orderId.slice(0, 14)}...  status=${response.status}`);

    // If status=matched, it filled immediately (taker) — no need to wait WS
    if (response.status === 'matched') {
      const filledShares = side === 'BUY'
        ? parseFloat(response.takingAmount ?? '0')
        : parseFloat(response.makingAmount ?? '0');
      const filledUsdc = side === 'BUY'
        ? parseFloat(response.makingAmount ?? '0')
        : parseFloat(response.takingAmount ?? '0');
      totalFilledSize += filledShares;
      totalFilledCost += filledUsdc;
      remainingSize    = Math.max(0, remainingSize - filledShares);
      console.log(`  Immediate fill: ${filledShares.toFixed(4)} sh @ $${(filledUsdc / (filledShares || 1)).toFixed(4)}`);
      if (remainingSize < 0.01) break;
      if (attempt < gtdAttempts) continue;
      break;
    }

    console.log(`  Waiting for fill (${GTD_SECONDS}s)...`);
    const { result, filledSize } = await waitForFillOrExpiry(orderId, remainingSize);

    if (filledSize > 0) {
      totalFilledSize += filledSize;
      totalFilledCost += filledSize * price;
      remainingSize    = Math.max(0, remainingSize - filledSize);
    }

    if (result === 'filled' || remainingSize < 0.01) {
      break;
    }

    console.log(`  Expired unfilled`);
    if (attempt < gtdAttempts) {
      const nextLabel = isBuy ? 'same price' : (['midpoint', 'cross'][attempt - 1] ?? 'cross');
      console.log(`  Retrying (${nextLabel})...`);
    }
  }

  // ── Attempt 4: FAK at bestBid (SELL only, spread < 3%) ───────────────────
  if (!isBuy && remainingSize >= 0.01) {
    const freshBook4  = await fetchBook();
    const spread4     = freshBook4.bestAsk > 0
      ? (freshBook4.bestAsk - freshBook4.bestBid) / freshBook4.bestAsk
      : 1;
    const spreadPct4  = (spread4 * 100).toFixed(2);

    console.log(`\n── Attempt 4/4  [market-FAK] ──────────────────────────────────`);
    console.log(`  Bid $${freshBook4.bestBid.toFixed(4)}  Ask $${freshBook4.bestAsk.toFixed(4)}  spread ${spreadPct4}%`);

    if (spread4 >= 0.03) {
      console.error(`  Spread ${spreadPct4}% ≥ 3% — skipping market fill to avoid wide-spread loss.`);
    } else {
      const slippagePrice = freshBook4.bestBid - 0.001;
      console.log(`  SELL ${remainingSize.toFixed(4)} sh @ $${slippagePrice.toFixed(4)} FAK  ≈ $${(remainingSize * slippagePrice).toFixed(2)} USDC`);

      let response4: any;
      try {
        response4 = await clob.postMarketOrder({
          tokenId:   tokenId!,
          side:      'SELL',
          amount:    remainingSize,
          price:     slippagePrice,
          negRisk,
          orderType: 'FAK',
        });
      } catch (err: any) {
        console.error(`  FAK threw: ${err.message}`);
      }

      if (response4?.success) {
        const filled4 = parseFloat(response4.makingAmount ?? '0');
        const usdc4   = parseFloat(response4.takingAmount ?? '0');
        totalFilledSize += filled4;
        totalFilledCost += usdc4;
        remainingSize    = Math.max(0, remainingSize - filled4);
        console.log(`  FAK fill: ${filled4.toFixed(4)} sh @ $${(usdc4 / (filled4 || 1)).toFixed(4)}`);
      } else {
        console.error(`  FAK failed: ${response4?.errorMsg ?? 'unknown'}`);
      }
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  if (totalFilledSize > 0) {
    const avgPrice = totalFilledCost / totalFilledSize;
    console.log(`\n${side} COMPLETE`);
    console.log(`  Filled: ${totalFilledSize.toFixed(4)} sh  avg $${avgPrice.toFixed(4)}  ≈ $${totalFilledCost.toFixed(2)} USDC`);
    if (remainingSize >= 0.01) {
      console.log(`  Remaining unfilled: ${remainingSize.toFixed(4)} sh`);
    }
    process.exit(0);
  } else {
    console.error(`\nNo fill after ${MAX_ATTEMPTS} attempts. Market may be illiquid.`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
