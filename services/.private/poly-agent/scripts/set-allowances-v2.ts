/**
 * set-allowances-v2.ts
 *
 * Sets the ERC20 and ERC1155 approvals required for CLOBv2 trading:
 *
 * ERC20 (pUSD):
 *   pUSD.approve(CTF_V2_EXCHANGE,      MaxUint256)
 *   pUSD.approve(NEG_RISK_V2_EXCHANGE, MaxUint256)
 *
 * ERC1155 (CTF conditional tokens — needed for SELL orders):
 *   CTF_TOKEN.setApprovalForAll(CTF_V2_EXCHANGE,      true)
 *   CTF_TOKEN.setApprovalForAll(NEG_RISK_V2_EXCHANGE, true)
 *   NEG_RISK_TOKEN.setApprovalForAll(NEG_RISK_V2_EXCHANGE, true)
 *
 * Usage:
 *   npx tsx scripts/set-allowances-v2.ts             # dry-run (check current)
 *   npx tsx scripts/set-allowances-v2.ts --execute   # submit txs for missing approvals
 */

import { config as dotenvConfig } from 'dotenv';
import { resolve } from 'path';
import { existsSync } from 'fs';
import {
  createPublicClient, createWalletClient, http, formatUnits, maxUint256,
  type Address,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';

// ── Env loading ───────────────────────────────────────────────────────────────
const envCandidates = [
  resolve(__dirname, '../.env.polyagent'),
  resolve(__dirname, '../.env.poly-agent'),
  resolve(__dirname, '../.env.local'),
  resolve(__dirname, '../.env'),
  resolve(__dirname, '../../../.env.local'),
];
for (const p of envCandidates) {
  if (existsSync(p)) { dotenvConfig({ path: p }); break; }
}

const PRIVATE_KEY = process.env.PRIVATE_KEY || process.env.BOT_PRIVATE_KEY;
const POLYGON_RPC = (process.env.POLYGON_WS_URL || process.env.POLYGON_RPC_URL || '')
  .replace(/^wss?:\/\//, 'https://').replace(/^ws:\/\//, 'http://');

if (!PRIVATE_KEY) { console.error('[allowances] Missing PRIVATE_KEY'); process.exit(1); }
if (!POLYGON_RPC) { console.error('[allowances] Missing POLYGON_RPC_URL'); process.exit(1); }

// ── Addresses ─────────────────────────────────────────────────────────────────
const PUSD_ADDRESS           = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB' as Address;
const CTF_TOKEN_ADDRESS      = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045' as Address; // Polymarket CTF ERC1155
const NEG_RISK_TOKEN_ADDRESS = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296' as Address; // NEG_RISK wrapped token
const CTF_V2_EXCHANGE        = '0xE111180000d2663C0091e4f400237545B87B996B' as Address;
const NEG_RISK_V2_EXCHANGE   = '0xe2222d279d744050d28e00520010520000310F59' as Address;

const ERC20_ABI = [
  { name: 'allowance', type: 'function', stateMutability: 'view',      inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'approve',   type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { name: 'decimals',  type: 'function', stateMutability: 'view',      inputs: [],                                                                          outputs: [{ type: 'uint8'  }] },
] as const;

const ERC1155_ABI = [
  { name: 'isApprovedForAll', type: 'function', stateMutability: 'view',      inputs: [{ name: 'account', type: 'address' }, { name: 'operator', type: 'address' }], outputs: [{ type: 'bool' }] },
  { name: 'setApprovalForAll', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'operator', type: 'address' }, { name: 'approved', type: 'bool'  }], outputs: [] },
] as const;

const execute = process.argv.includes('--execute');

interface Erc20Check  { label: string; token: Address; spender: Address; }
interface Erc1155Check { label: string; token: Address; operator: Address; }

const ERC20_CHECKS: Erc20Check[] = [
  { label: 'pUSD → CTF_V2_EXCHANGE',       token: PUSD_ADDRESS, spender: CTF_V2_EXCHANGE      },
  { label: 'pUSD → NEG_RISK_V2_EXCHANGE',  token: PUSD_ADDRESS, spender: NEG_RISK_V2_EXCHANGE },
];

const ERC1155_CHECKS: Erc1155Check[] = [
  { label: 'CTF_TOKEN → CTF_V2_EXCHANGE',            token: CTF_TOKEN_ADDRESS,      operator: CTF_V2_EXCHANGE      },
  { label: 'CTF_TOKEN → NEG_RISK_V2_EXCHANGE',       token: CTF_TOKEN_ADDRESS,      operator: NEG_RISK_V2_EXCHANGE },
  { label: 'NEG_RISK_TOKEN → NEG_RISK_V2_EXCHANGE',  token: NEG_RISK_TOKEN_ADDRESS, operator: NEG_RISK_V2_EXCHANGE },
];

async function main() {
  const account      = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);
  const wallet       = account.address as Address;
  const publicClient = createPublicClient({ chain: polygon, transport: http(POLYGON_RPC) });
  const walletClient = createWalletClient({ account, chain: polygon, transport: http(POLYGON_RPC) });

  console.log(`\n[set-allowances-v2] Wallet: ${wallet}`);
  console.log(`[set-allowances-v2] Mode: ${execute ? 'EXECUTE' : 'dry-run'}\n`);

  const pusdDec = await publicClient.readContract({
    address: PUSD_ADDRESS, abi: ERC20_ABI, functionName: 'decimals',
  });

  // ── ERC20 checks ─────────────────────────────────────────────────────────
  console.log('ERC20 allowances (pUSD):');
  for (const c of ERC20_CHECKS) {
    const allowance = await publicClient.readContract({
      address: c.token, abi: ERC20_ABI, functionName: 'allowance', args: [wallet, c.spender],
    });
    const isMax = allowance >= maxUint256 / 2n;
    const display = isMax ? 'MAX ✓' : `$${parseFloat(formatUnits(allowance, pusdDec)).toFixed(2)}`;
    console.log(`  ${c.label}: ${display}`);

    if (!isMax && execute) {
      console.log(`  → Approving MaxUint256...`);
      const hash = await walletClient.writeContract({
        address: c.token, abi: ERC20_ABI,
        functionName: 'approve', args: [c.spender, maxUint256],
      });
      console.log(`  → tx: ${hash}`);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') { console.error(`  → FAILED`); process.exit(1); }
      console.log(`  → confirmed ✓`);
    }
  }

  // ── ERC1155 checks ────────────────────────────────────────────────────────
  console.log('\nERC1155 approvals (conditional tokens):');
  for (const c of ERC1155_CHECKS) {
    let approved = false;
    try {
      approved = await publicClient.readContract({
        address: c.token, abi: ERC1155_ABI,
        functionName: 'isApprovedForAll', args: [wallet, c.operator],
      });
    } catch {
      // Contract may not exist for this token — skip
      console.log(`  ${c.label}: (contract not deployed yet — skip)`);
      continue;
    }

    console.log(`  ${c.label}: ${approved ? 'approved ✓' : 'NOT approved'}`);

    if (!approved && execute) {
      console.log(`  → setApprovalForAll(${c.operator}, true)...`);
      const hash = await walletClient.writeContract({
        address: c.token, abi: ERC1155_ABI,
        functionName: 'setApprovalForAll', args: [c.operator, true],
      });
      console.log(`  → tx: ${hash}`);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') { console.error(`  → FAILED`); process.exit(1); }
      console.log(`  → confirmed ✓`);
    }
  }

  if (!execute) {
    console.log('\n  Add --execute to approve missing allowances.\n');
  } else {
    console.log('\n  All approvals set ✓\n');
  }
}

main().catch(err => {
  console.error('[allowances] Fatal:', err.message ?? err);
  process.exit(1);
});
