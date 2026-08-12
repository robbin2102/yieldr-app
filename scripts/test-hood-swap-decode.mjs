/**
 * Test script: verify that HOOD/Doppler PoolManager Swap events can reconstruct
 * a user's trade when ERC20 Transfer-to-wallet events are absent.
 *
 * Run: node scripts/test-hood-swap-decode.mjs
 * Requires: ALCHEMY_HOOD_RPC_URL in environment (or .env.local)
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Load .env.local manually (no dotenv dependency required)
const __dirname = dirname(fileURLToPath(import.meta.url));
try {
  const env = readFileSync(join(__dirname, '../.env.local'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
  }
} catch { /* no .env.local, rely on shell env */ }

const RPC_URL = process.env.ALCHEMY_HOOD_RPC_URL;
if (!RPC_URL) {
  console.error('ALCHEMY_HOOD_RPC_URL not set');
  process.exit(1);
}

const TX_HASH = '0xe6efe62f5d034bd671663361b47b1cded3359781eb721eff1318deda4d5d3131';
const WALLET  = '0x9d948fdbc6e905c3dd2e382197906afbc07b765e';

// Known HOOD contract addresses
const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const WETH_ADDRESS = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';

// Event topic signatures
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const SWAP_TOPIC     = '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f';

async function rpc(method, params) {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`RPC error: ${JSON.stringify(json.error)}`);
  return json.result;
}

function hex2dec(hex) {
  return BigInt(hex);
}

function toSignedInt(hex) {
  // ABI encodes int128 sign-extended into a 32-byte (256-bit) slot.
  // Must check the 256-bit sign bit, not the 128-bit one.
  const u = BigInt(hex);
  return u >= 2n ** 255n ? u - 2n ** 256n : u;
}

function fmt(bigint, decimals) {
  const abs = bigint < 0n ? -bigint : bigint;
  const divisor = 10n ** BigInt(decimals);
  const whole = abs / divisor;
  const frac = abs % divisor;
  const sign = bigint < 0n ? '-' : '+';
  return `${sign}${whole}.${frac.toString().padStart(decimals, '0').slice(0, 8)}`;
}

async function main() {
  console.log(`\n=== HOOD Swap Decode Test ===`);
  console.log(`TX: ${TX_HASH}`);
  console.log(`Wallet: ${WALLET}\n`);

  // 1. Fetch full tx receipt (all logs)
  console.log('Fetching transaction receipt...');
  const receipt = await rpc('eth_getTransactionReceipt', [TX_HASH]);
  console.log(`  Block: ${hex2dec(receipt.blockNumber)}  Logs: ${receipt.logs.length} total\n`);

  // 2. Find Transfer events where from = wallet (outgoing)
  const outgoing = receipt.logs.filter(log =>
    log.topics[0] === TRANSFER_TOPIC &&
    log.topics[1]?.toLowerCase() === `0x000000000000000000000000${WALLET.slice(2)}`
  );

  console.log(`=== Outgoing transfers (from wallet) ===`);
  for (const log of outgoing) {
    const token = log.address.toLowerCase();
    const to = '0x' + log.topics[2].slice(26);
    const amount = hex2dec(log.data);
    const label = token === WETH_ADDRESS ? 'WETH' : `token@${token.slice(0, 10)}`;
    console.log(`  OUT  ${label}  amount=${amount}  to=${to}`);
  }

  // 3. Find Transfer events where to = wallet (incoming)
  const incoming = receipt.logs.filter(log =>
    log.topics[0] === TRANSFER_TOPIC &&
    log.topics[2]?.toLowerCase() === `0x000000000000000000000000${WALLET.slice(2)}`
  );

  console.log(`\n=== Incoming transfers (to wallet) ===`);
  if (incoming.length === 0) {
    console.log('  (none — confirms Transfer-event scan cannot see the WETH return)');
  }
  for (const log of incoming) {
    const token = log.address.toLowerCase();
    const from = '0x' + log.topics[1].slice(26);
    const amount = hex2dec(log.data);
    const label = token === WETH_ADDRESS ? 'WETH' : `token@${token.slice(0, 10)}`;
    console.log(`  IN   ${label}  amount=${amount}  from=${from}`);
  }

  // 4. Find PoolManager Swap events
  const swaps = receipt.logs.filter(log =>
    log.address.toLowerCase() === POOL_MANAGER &&
    log.topics[0] === SWAP_TOPIC
  );

  console.log(`\n=== PoolManager Swap events (${swaps.length} found) ===`);
  let matched = false;
  for (const log of swaps) {
    const poolId = log.topics[1];
    const sender = '0x' + log.topics[2].slice(26);

    // data = amount0 (int128, 32 bytes) | amount1 (int128, 32 bytes) | sqrtPrice | liquidity | tick | fee
    // ABI sign-extends int128 into a 256-bit slot — use toSignedInt (not 128-bit threshold).
    const data = log.data.slice(2); // remove 0x
    const amount0 = toSignedInt('0x' + data.slice(0, 64));
    const amount1 = toSignedInt('0x' + data.slice(64, 128));

    // In V4 Swap events (from caller/sender perspective):
    //   positive amount = caller RECEIVES this token from pool
    //   negative amount = caller PAYS this token to pool
    // For a SELL of tokenX for WETH: amount_tokenX < 0, amount_WETH > 0

    console.log(`\n  Pool: ${poolId.slice(0, 10)}...`);
    console.log(`  Sender: ${sender}`);
    console.log(`  amount0: ${fmt(amount0, 18)} (raw, 18-decimal display)`);
    console.log(`  amount1: ${fmt(amount1, 18)} (raw, 18-decimal display)`);

    // Try to match either amount against outgoing wallet transfers.
    // Negative amounts = tokens the caller paid to pool = candidate for "wallet sold X"
    for (const [amtLabel, amt, wethAmt] of [
      ['amount1', amount1, amount0],
      ['amount0', amount0, amount1],
    ]) {
      if (amt >= 0n) continue; // we want the negative (paid) side
      const absPaid = -amt;
      const absWeth = wethAmt < 0n ? -wethAmt : wethAmt;

      const matchedOut = outgoing.find(t => {
        const outAmt = hex2dec(t.data);
        if (outAmt === 0n) return false;
        const diff = outAmt > absPaid ? outAmt - absPaid : absPaid - outAmt;
        return diff <= outAmt / 500n; // within 0.2%
      });

      if (matchedOut) {
        matched = true;
        const tokenAddr = matchedOut.address.toLowerCase();
        const isWethToken0 = amtLabel === 'amount1'; // if we matched amount1 as sold, WETH is amount0
        console.log(`\n  *** MATCH (${amtLabel} = sold token) ***`);
        console.log(`  Token sold:   ${tokenAddr}  amount=${absPaid}`);
        console.log(`  WETH side:    ${fmt(wethAmt, 18)} WETH (positive = wallet receives)`);
        console.log(`  WETH in ETH:  ${(Number(absWeth) / 1e18).toFixed(8)} ETH`);
        const ethPrice = 1888;
        console.log(`  USD estimate: ~$${(Number(absWeth) / 1e18 * ethPrice).toFixed(4)} (at $${ethPrice}/ETH)`);
        console.log(`  Implied price per token unit: ${(Number(absWeth) / Number(absPaid)).toExponential(4)} WETH/unit`);
      }
    }
    if (!matched) {
      console.log('  (no match with outgoing wallet transfers for this Swap event)');
    }
  }

  // 5. Summary
  console.log('\n=== SUMMARY ===');
  if (matched) {
    console.log('SUCCESS: PoolManager Swap event decoding CAN reconstruct this HOOD trade.');
    console.log('The outgoing Transfer + Swap event together give us tokenOut, amountOut, WETHreceived, and USD value.');
    console.log('Next: implement this in fetchTrades.ts for HOOD wallets.');
  } else if (outgoing.length > 0 && swaps.length > 0) {
    console.log('Swap events found but no amount match — check token decimals or matching tolerance.');
  } else if (outgoing.length > 0 && swaps.length === 0) {
    console.log('Outgoing visible but no Swap events from PoolManager — check POOL_MANAGER address.');
  } else {
    console.log('Could not extract trade data from this approach.');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
