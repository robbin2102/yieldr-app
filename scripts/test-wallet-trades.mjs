/**
 * Comprehensive wallet trade detection test.
 *
 * Fetches all transfers for a wallet on HOOD and Base, classifies each tx as:
 *   - balanced (1-out / 1-in)  → standard swap, already priced
 *   - sell     (1-out / 0-in)  → needs V4 Swap event enrichment (HOOD Doppler, Base V4 sells)
 *   - relay-buy (0-out / 1-in) → needs V4 Swap event enrichment (Base cross-chain buys from Solana)
 *   - other unbalanced         → multi-hop or unsupported, excluded in MVP
 *
 * For sell and relay-buy candidates it attempts PoolManager Swap event matching
 * and reports matched vs unmatched with amounts.
 *
 * Run:   node scripts/test-wallet-trades.mjs [wallet_address]
 * Needs: ALCHEMY_HOOD_RPC_URL and/or ALCHEMY_BASE_RPC_URL in .env.local
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
try {
  const env = readFileSync(join(__dirname, '../.env.local'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
  }
} catch { /* no .env.local — rely on shell env */ }

const WALLET = (process.argv[2] || '0xCcC88a9d1B4ED6b0EABA998850414b24f1c315bE').toLowerCase();
const SWAP_TOPIC = '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f';
const BIT255 = 2n ** 255n;
const TWO256 = 2n ** 256n;

const CHAINS = [
  {
    name:           'HOOD',
    rpcUrl:         process.env.ALCHEMY_HOOD_RPC_URL,
    poolManager:    '0x8366a39cc670b4001a1121b8f6a443a643e40951',
    wethAddress:    '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
    wethSymbol:     'WETH',
    // HOOD blocks are ~0.1s each (not 2s). 2M blocks = only ~6 days.
    // Since the chain launched ~2026-07-01 (under 90 days old), scan from genesis.
    lookbackBlocks: null,
    // HOOD does not support 'internal' category in alchemy_getAssetTransfers
    categories:     ['erc20', 'external'],
  },
  {
    name:           'Base',
    rpcUrl:         process.env.ALCHEMY_BASE_RPC_URL,
    poolManager:    '0x498581ff718922c3f8e6a244956af099b2652b2b',
    wethAddress:    '0x4200000000000000000000000000000000000006',
    wethSymbol:     'WETH',
    // 90 days at ~2s/block
    lookbackBlocks: 3_888_000,
    categories:     ['erc20', 'external', 'internal'],
  },
];

// ─── helpers ──────────────────────────────────────────────────────────────────

async function rpc(url, method, params) {
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`RPC ${method}: ${JSON.stringify(json.error)}`);
  return json.result;
}

function abiSigned(hex) {
  const u = BigInt(hex);
  return u >= BIT255 ? u - TWO256 : u;
}

function fmtEth(wei) {
  return (Number(wei < 0n ? -wei : wei) / 1e18).toFixed(8);
}

// ─── transfer fetch ───────────────────────────────────────────────────────────

async function fetchTransfers(chainName, rpcUrl, wallet, fromHex, toHex, categories) {
  const all = [];
  for (const direction of ['from', 'to']) {
    let pageKey, pages = 0, count = 0;
    do {
      pages++;
      const params = {
        fromBlock: fromHex, toBlock: toHex,
        category:  categories, withMetadata: true,
        excludeZeroValue: true, maxCount: '0x3e8', order: 'asc',
        [direction === 'from' ? 'fromAddress' : 'toAddress']: wallet,
      };
      if (pageKey) params.pageKey = pageKey;
      const res = await rpc(rpcUrl, 'alchemy_getAssetTransfers', [params]);
      for (const t of res?.transfers ?? []) {
        const rawHex = t.rawContract?.value;
        const rawQty = rawHex ? BigInt(rawHex) : BigInt(Math.round(Number(t.value ?? 0) * 1e18));
        all.push({
          hash:      t.hash,
          from:      t.from?.toLowerCase(),
          to:        t.to?.toLowerCase(),
          token:     t.rawContract?.address?.toLowerCase() ?? 'native',
          qty:       Number(t.value ?? 0),
          rawQty,
          symbol:    t.asset || '?',
          direction,
        });
        count++;
      }
      process.stdout.write(`  [${chainName}/${direction}] page ${pages}, ${count} transfers...\r`);
      pageKey = res?.pageKey;
    } while (pageKey);
    console.log(`  [${chainName}/${direction}] done — ${count} transfers in ${pages} page(s)    `);
  }
  return all;
}

// ─── Swap event matching ──────────────────────────────────────────────────────

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/**
 * Find the ERC20 Transfer event in the receipt whose amount is closest to
 * expectedRawQty (within 2%), excluding the known trade token. Returns the
 * token address and amount, or null if no match.
 */
function findRefTransfer(receipt, excludeToken, expectedRawQty) {
  const exclude = excludeToken.toLowerCase();
  let best = null;
  for (const log of receipt.logs) {
    if (log.topics?.[0] !== TRANSFER_TOPIC) continue;
    const tokenAddr = log.address?.toLowerCase();
    if (!tokenAddr || tokenAddr === exclude) continue;
    const amt = BigInt(log.data);
    if (amt <= 0n) continue;
    const diff = amt > expectedRawQty ? amt - expectedRawQty : expectedRawQty - amt;
    if (diff > expectedRawQty * 200n / 10000n) continue; // 2% tolerance
    if (!best || diff < best.diff) best = { tokenAddress: tokenAddr, rawQty: amt, diff };
  }
  return best ? { tokenAddress: best.tokenAddress, rawQty: best.rawQty } : null;
}

/**
 * Fetch the tx receipt and try to find a PoolManager Swap event whose signed
 * amount matches tokenRawQty.
 *
 * direction = 'sell'  → token was paid to pool (negative amount), match within 0.2%
 * direction = 'buy'   → token was received from pool (positive amount), match within 1%
 *                        (relay bridge takes a fee, so tolerance is wider)
 *
 * Returns: { found: true, refAmount: bigint (always positive), refToken: string|null }
 *        | { found: false, reason: string, swapCount: number }
 */
async function trySwapEnrich(rpcUrl, poolManager, hash, tradeToken, tokenRawQty, direction) {
  const receipt = await rpc(rpcUrl, 'eth_getTransactionReceipt', [hash]).catch(() => null);
  if (!receipt) return { found: false, reason: 'receipt fetch failed', swapCount: 0 };

  const swapLogs = receipt.logs.filter(
    log => log.address?.toLowerCase() === poolManager && log.topics?.[0] === SWAP_TOPIC
  );
  if (swapLogs.length === 0) return { found: false, reason: 'no Swap events from PoolManager', swapCount: 0 };

  for (const log of swapLogs) {
    const data = log.data.slice(2);
    const a0 = abiSigned('0x' + data.slice(0,  64));
    const a1 = abiSigned('0x' + data.slice(64, 128));

    for (const [check, other] of [[a0, a1], [a1, a0]]) {
      if (direction === 'sell') {
        if (check >= 0n || other <= 0n) continue;
        const abs  = -check;
        const diff = abs > tokenRawQty ? abs - tokenRawQty : tokenRawQty - abs;
        if (diff <= tokenRawQty / 500n) {
          const found = findRefTransfer(receipt, tradeToken, other);
          return { found: true, refAmount: found?.rawQty ?? other, refToken: found?.tokenAddress ?? null };
        }
      } else {
        // relay-buy: token received = positive amount
        if (check <= 0n || other >= 0n) continue;
        const diff = check > tokenRawQty ? check - tokenRawQty : tokenRawQty - check;
        if (diff <= tokenRawQty / 100n) {
          const refPaid = -other;
          const found = findRefTransfer(receipt, tradeToken, refPaid);
          return { found: true, refAmount: found?.rawQty ?? refPaid, refToken: found?.tokenAddress ?? null };
        }
      }
    }
  }

  return { found: false, reason: `${swapLogs.length} Swap event(s) found, no amount match`, swapCount: swapLogs.length };
}

// ─── per-chain analysis ───────────────────────────────────────────────────────

async function analyzeChain(chain, wallet) {
  const bar = '─'.repeat(60);
  console.log(`\n${bar}`);
  console.log(`Chain: ${chain.name}   Wallet: ${wallet}`);
  console.log(bar);

  if (!chain.rpcUrl) {
    console.log('  SKIPPED — no RPC URL configured (set ' +
      (chain.name === 'HOOD' ? 'ALCHEMY_HOOD_RPC_URL' : 'ALCHEMY_BASE_RPC_URL') + ')');
    return;
  }

  const latestHex = await rpc(chain.rpcUrl, 'eth_blockNumber', []);
  const latest    = BigInt(latestHex);
  const fromBlock = chain.lookbackBlocks === null ? 0n
    : latest > BigInt(chain.lookbackBlocks) ? latest - BigInt(chain.lookbackBlocks) : 0n;
  const fromHex   = '0x' + fromBlock.toString(16);
  const windowDesc = chain.lookbackBlocks === null
    ? 'full chain history (genesis → latest)'
    : `${chain.lookbackBlocks.toLocaleString()} block lookback`;
  console.log(`Block range: ${fromBlock.toLocaleString()} → ${latest.toLocaleString()} (${windowDesc})\n`);

  const transfers = await fetchTransfers(chain.name, chain.rpcUrl, wallet, fromHex, latestHex, chain.categories);

  // Group by hash, split into out-legs and in-legs relative to the wallet
  const byHash = new Map();
  for (const t of transfers) {
    const g = byHash.get(t.hash) ?? { out: [], in: [] };
    if (t.from === wallet) g.out.push(t);
    if (t.to   === wallet) g.in.push(t);
    byHash.set(t.hash, g);
  }

  const balanced  = [];
  const sellCands = [];
  const buyCands  = [];
  const otherUnb  = [];

  for (const [hash, g] of byHash) {
    if      (g.out.length === 1 && g.in.length === 1) balanced.push({ hash, ...g });
    else if (g.out.length === 1 && g.in.length === 0) sellCands.push({ hash, ...g });
    else if (g.out.length === 0 && g.in.length === 1) buyCands.push({ hash, ...g });
    else                                               otherUnb.push({ hash, ...g });
  }

  // ── overview ──
  console.log(`\nTrade classification (${byHash.size} unique tx hashes):`);
  console.log(`  ✓ Balanced  (1-out / 1-in)  : ${balanced.length.toString().padStart(3)}  — standard swaps, already priced`);
  console.log(`  ? Sell cand (1-out / 0-in)  : ${sellCands.length.toString().padStart(3)}  — need V4 Swap enrichment`);
  console.log(`  ? Buy cand  (0-out / 1-in)  : ${buyCands.length.toString().padStart(3)}  — need relay-buy enrichment`);
  console.log(`  ✗ Other unbalanced          : ${otherUnb.length.toString().padStart(3)}  — multi-hop, excluded`);

  // ── balanced sample ──
  if (balanced.length > 0) {
    console.log(`\nBalanced trades (first ${Math.min(5, balanced.length)} of ${balanced.length}):`);
    for (const { hash, out, in: inn } of balanced.slice(0, 5)) {
      console.log(`  ${hash.slice(0, 12)}  OUT ${out[0].qty.toFixed(4).padStart(14)} ${out[0].symbol.padEnd(8)} → IN ${inn[0].qty.toFixed(4).padStart(14)} ${inn[0].symbol}`);
    }
  }

  // ── sell enrichment ──
  if (sellCands.length > 0) {
    console.log(`\nSell enrichment — V4 Swap event matching (${sellCands.length} candidates):`);
    let matched = 0, unmatched = 0;

    for (const { hash, out } of sellCands) {
      const leg    = out[0];
      const result = await trySwapEnrich(chain.rpcUrl, chain.poolManager, hash, leg.token, leg.rawQty, 'sell');
      if (result.found) {
        matched++;
        const refAmt  = fmtEth(result.refAmount);
        const refLabel = result.refToken ? result.refToken.slice(0, 10) : chain.wethSymbol;
        console.log(`  MATCH  ${hash.slice(0, 12)}  sold ${leg.qty.toFixed(6).padStart(16)} ${leg.symbol.padEnd(10)} → rcvd ${refAmt} ${refLabel}`);
      } else {
        unmatched++;
        console.log(`  MISS   ${hash.slice(0, 12)}  sold ${leg.qty.toFixed(6).padStart(16)} ${leg.symbol.padEnd(10)}   (${result.reason})`);
      }
    }
    console.log(`  → ${matched} matched, ${unmatched} unmatched out of ${sellCands.length}`);
  }

  // ── relay-buy enrichment ──
  if (buyCands.length > 0) {
    console.log(`\nRelay-buy enrichment — V4 Swap event matching (${buyCands.length} candidates):`);
    let matched = 0, unmatched = 0;

    for (const { hash, in: inn } of buyCands) {
      const leg    = inn[0];
      const result = await trySwapEnrich(chain.rpcUrl, chain.poolManager, hash, leg.token, leg.rawQty, 'buy');
      if (result.found) {
        matched++;
        const refAmt  = fmtEth(result.refAmount);
        const refLabel = result.refToken ? result.refToken.slice(0, 10) : chain.wethSymbol;
        console.log(`  MATCH  ${hash.slice(0, 12)}  rcvd ${leg.qty.toFixed(6).padStart(16)} ${leg.symbol.padEnd(10)} ← paid ${refAmt} ${refLabel}`);
      } else {
        unmatched++;
        console.log(`  MISS   ${hash.slice(0, 12)}  rcvd ${leg.qty.toFixed(6).padStart(16)} ${leg.symbol.padEnd(10)}   (${result.reason})`);
      }
    }
    console.log(`  → ${matched} matched, ${unmatched} unmatched out of ${buyCands.length}`);
  }

  if (byHash.size === 0) {
    console.log('\n  No transfers found for this wallet in the lookback window.');
    console.log('  Check that the wallet address is correct and the RPC URL is valid.');
  }
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n=== Wallet Trade Detection Test ===');
  console.log(`Wallet : ${WALLET}`);
  console.log(`Chains : ${CHAINS.filter(c => c.rpcUrl).map(c => c.name).join(', ') || 'none configured'}`);
  console.log('(Pass a different wallet as first arg: node scripts/test-wallet-trades.mjs 0xABC...)');

  for (const chain of CHAINS) {
    await analyzeChain(chain, WALLET);
  }

  console.log('\n=== DONE ===\n');
}

main().catch(err => { console.error('\nFatal:', err); process.exit(1); });
