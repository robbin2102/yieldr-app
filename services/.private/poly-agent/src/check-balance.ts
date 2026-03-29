/**
 * Wallet Balance & Transaction Checker
 *
 * Checks bot wallet's CLOB balance and recent transactions.
 *
 * Usage:
 *   npx tsx services/.private/poly-agent/src/check-balance.ts
 */

import { ethers } from 'ethers';
import { ClobClient } from '@polymarket/clob-client';
import dotenv from 'dotenv';
import path from 'path';

const envPaths = [
  path.resolve(process.cwd(), 'services/.private/poly-agent/.env.polyagent'),
  path.resolve(process.cwd(), '.env.local'),
  path.resolve(process.cwd(), '.env'),
];
for (const p of envPaths) {
  const r = dotenv.config({ path: p });
  if (r.parsed?.BOT_PRIVATE_KEY) break;
}

const CONFIG = {
  botPrivateKey: process.env.BOT_PRIVATE_KEY!,
  botWallet: process.env.BOT_WALLET_ADDRESS!,
  apiKey: process.env.POLYMARKET_API_KEY!,
  apiSecret: process.env.POLYMARKET_API_SECRET!,
  passphrase: process.env.POLYMARKET_PASSPHRASE!,
  clobApiBase: process.env.CLOB_API_BASE || 'https://clob.polymarket.com',
  dataApiBase: process.env.DATA_API_BASE || 'https://data-api.polymarket.com',
  chainId: parseInt(process.env.CHAIN_ID || '137'),
  polygonRpcUrl: process.env.POLYGON_RPC_URL!,
};

const USDC_E_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const USDC_E_ABI = ['function balanceOf(address) view returns (uint256)'];

async function main() {
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║   Wallet Balance & Transaction Checker                ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');

  const provider = new ethers.providers.StaticJsonRpcProvider(CONFIG.polygonRpcUrl, { name: 'polygon', chainId: CONFIG.chainId });
  const wallet = new ethers.Wallet(CONFIG.botPrivateKey, provider);

  console.log(`Wallet (EOA): ${wallet.address}`);
  console.log(`Bot wallet:   ${CONFIG.botWallet}\n`);

  // === 1. On-chain USDC.e balance ===
  console.log('═══ ON-CHAIN BALANCES ═══\n');
  try {
    const maticBalance = await provider.getBalance(wallet.address);
    console.log(`  MATIC/POL:  ${ethers.utils.formatEther(maticBalance)} POL`);

    const usdcContract = new ethers.Contract(USDC_E_ADDRESS, USDC_E_ABI, provider);
    const usdcBalance = await usdcContract.balanceOf(wallet.address);
    console.log(`  USDC.e:     $${(parseInt(usdcBalance.toString()) / 1e6).toFixed(6)} (on-chain, in wallet)`);
  } catch (err: any) {
    console.log(`  Error reading on-chain: ${err.message}`);
  }

  // === 2. CLOB API balance (exchange contract) ===
  console.log('\n═══ POLYMARKET CLOB BALANCE (Exchange Contract) ═══\n');
  const clobClient = new ClobClient(CONFIG.clobApiBase, CONFIG.chainId, wallet,
    { key: CONFIG.apiKey, secret: CONFIG.apiSecret, passphrase: CONFIG.passphrase });

  try {
    // Try the get_balance endpoint
    const balRes = await fetch(`${CONFIG.clobApiBase}/get-balance-allowance?asset_type=USDC`, {
      headers: {
        'POLY_API_KEY': CONFIG.apiKey,
        'POLY_SIGNATURE': CONFIG.apiSecret,
        'POLY_TIMESTAMP': Date.now().toString(),
        'POLY_PASSPHRASE': CONFIG.passphrase,
      },
    });
    if (balRes.ok) {
      const balData = await balRes.json() as any;
      console.log(`  CLOB balance response: ${JSON.stringify(balData, null, 2)}`);
    } else {
      console.log(`  CLOB balance API: ${balRes.status} ${balRes.statusText}`);
    }
  } catch (err: any) {
    console.log(`  Error: ${err.message}`);
  }

  // === 3. Open orders (locked funds) ===
  console.log('\n═══ OPEN ORDERS ═══\n');
  try {
    const ordersRes = await fetch(`${CONFIG.clobApiBase}/orders?market=&status=live`, {
      headers: {
        'POLY_API_KEY': CONFIG.apiKey,
        'POLY_SIGNATURE': CONFIG.apiSecret,
        'POLY_TIMESTAMP': Date.now().toString(),
        'POLY_PASSPHRASE': CONFIG.passphrase,
      },
    });
    if (ordersRes.ok) {
      const orders = await ordersRes.json() as any[];
      if (Array.isArray(orders) && orders.length > 0) {
        console.log(`  ${orders.length} open order(s):`);
        for (const o of orders.slice(0, 10)) {
          console.log(`    ${o.side} ${o.size} shares @ ${o.price} | status=${o.status} | ${o.order_id?.slice(0, 16)}...`);
        }
      } else {
        console.log('  No open orders');
      }
    } else {
      console.log(`  Orders API: ${ordersRes.status}`);
    }
  } catch (err: any) {
    console.log(`  Error: ${err.message}`);
  }

  // === 4. Open positions (filled orders) ===
  console.log('\n═══ OPEN POSITIONS ═══\n');
  try {
    const posRes = await fetch(`${CONFIG.dataApiBase}/positions?user=${wallet.address.toLowerCase()}&sizeThreshold=0.01&limit=10`);
    if (posRes.ok) {
      const positions = await posRes.json() as any[];
      if (Array.isArray(positions) && positions.length > 0) {
        console.log(`  ${positions.length} position(s):`);
        for (const p of positions) {
          const value = (p.size || 0) * (p.curPrice || 0);
          console.log(`    ${p.title?.slice(0, 50) || '?'}`);
          console.log(`      ${p.outcome || '?'}: ${p.size?.toFixed(2)} shares @ avg ${p.avgPrice?.toFixed(3)} | cur=${p.curPrice?.toFixed(3)} | val=$${value.toFixed(2)}`);
        }
      } else {
        console.log('  No open positions');
      }
    } else {
      console.log(`  Positions API: ${posRes.status}`);
    }
  } catch (err: any) {
    console.log(`  Error: ${err.message}`);
  }

  // === 5. Recent activity (last 10 transactions) ===
  console.log('\n═══ RECENT ACTIVITY (last 10) ═══\n');
  try {
    const actRes = await fetch(`${CONFIG.dataApiBase}/activity?user=${wallet.address.toLowerCase()}&limit=10&sortBy=TIMESTAMP&sortDirection=DESC`);
    if (actRes.ok) {
      const activities = await actRes.json() as any[];
      if (Array.isArray(activities) && activities.length > 0) {
        for (const a of activities) {
          const time = new Date(a.timestamp * 1000).toLocaleString();
          const type = `${a.type}${a.side ? ' ' + a.side : ''}`;
          const price = a.price ? `@ ${(a.price * 100).toFixed(0)}c` : '';
          const usdc = a.usdcSize ? `$${a.usdcSize.toFixed(2)}` : '';
          const shares = a.size ? `${a.size.toFixed(2)} shares` : '';
          console.log(`  ${time} | ${type.padEnd(10)} | ${price.padEnd(7)} | ${usdc.padEnd(8)} | ${shares.padEnd(14)} | ${a.title?.slice(0, 45) || '?'}`);
        }
      } else {
        console.log('  No recent activity');
      }
    } else {
      console.log(`  Activity API: ${actRes.status}`);
    }
  } catch (err: any) {
    console.log(`  Error: ${err.message}`);
  }

  // === 6. Closed positions (recent resolved bets) ===
  console.log('\n═══ RECENT CLOSED POSITIONS ═══\n');
  try {
    const closedRes = await fetch(`${CONFIG.dataApiBase}/v1/closed-positions?user=${wallet.address.toLowerCase()}&limit=10&sortBy=TIMESTAMP&sortDirection=DESC`);
    if (closedRes.ok) {
      const closed = await closedRes.json() as any[];
      if (Array.isArray(closed) && closed.length > 0) {
        for (const c of closed) {
          const pnl = c.realizedPnl >= 0 ? `+$${c.realizedPnl.toFixed(2)}` : `-$${Math.abs(c.realizedPnl).toFixed(2)}`;
          const won = c.curPrice > 0.5 ? '✅' : '❌';
          console.log(`  ${won} ${pnl.padEnd(10)} | bought $${c.totalBought?.toFixed(2)} @ avg ${(c.avgPrice * 100).toFixed(0)}c | ${c.outcome} | ${c.title?.slice(0, 40) || '?'}`);
        }
      } else {
        console.log('  No closed positions');
      }
    } else {
      console.log(`  Closed positions API: ${closedRes.status}`);
    }
  } catch (err: any) {
    console.log(`  Error: ${err.message}`);
  }

  console.log('\n═══════════════════════════════════════════════════════\n');
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
