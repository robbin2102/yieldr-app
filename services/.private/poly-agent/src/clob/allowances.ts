import { ethers } from 'ethers';
import { ClobClient } from '@polymarket/clob-client';

/**
 * Polymarket Contract Addresses (Polygon Mainnet)
 *
 * Source: https://gist.github.com/poly-rodr/44313920481de58d5a3f6d1f8226bd5e
 */
const POLYGON_CONTRACTS = {
  // Token contracts
  USDC: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
  CTF: '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045',

  // Exchange contracts
  CTF_EXCHANGE: '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E',
  NEG_RISK_CTF_EXCHANGE: '0xC5d563A36AE78145C45a50134d48A1215220f80a',
  NEG_RISK_ADAPTER: '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296',
};

/**
 * Raw RPC call - bypasses ethers provider to avoid circular references
 */
async function rawRpcCall(rpcUrl: string, method: string, params: any[]): Promise<any> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params
    }),
  });

  const json: any = await res.json();

  if (json.error) {
    throw new Error(json.error.message);
  }

  return json.result;
}

/**
 * Ensures all required allowances are set for Polymarket trading
 *
 * This is a ONE-TIME setup that needs to happen before placing any orders.
 * We use MaxUint256 (unlimited approval) as recommended by Polymarket's official docs.
 *
 * Polymarket has TWO exchange contracts:
 * - CTF_EXCHANGE: Regular markets
 * - NEG_RISK_CTF_EXCHANGE: Most popular markets (e.g. "Bitcoin Up or Down")
 *
 * Required approvals (4 total):
 * 1. USDC.approve(CTF_EXCHANGE, MaxUint256)
 * 2. CTF.setApprovalForAll(CTF_EXCHANGE, true)
 * 3. USDC.approve(NEG_RISK_CTF_EXCHANGE, MaxUint256)
 * 4. CTF.setApprovalForAll(NEG_RISK_CTF_EXCHANGE, true)
 *
 * @param privateKey - Private key of the wallet (0x prefixed)
 * @param rpcUrl - Polygon RPC URL
 * @param chainId - Chain ID (137 for Polygon)
 */
export async function ensureAllowances(
  privateKey: string,
  rpcUrl: string,
  chainId: number
): Promise<void> {
  console.log('\n[Allowances] Checking trading allowances...');

  // Only support Polygon mainnet
  if (chainId !== 137) {
    throw new Error(`Unsupported chain ID: ${chainId}. Only Polygon (137) is supported.`);
  }

  // Get wallet address (no provider needed)
  const walletAddress = new ethers.Wallet(privateKey).address;
  console.log(`[Allowances] Wallet address: ${walletAddress}`);

  try {
    // ═══════════════════════════════════════════════════════════════
    // 1. Check and Set USDC Allowance (for BUY orders)
    // ═══════════════════════════════════════════════════════════════

    // ERC20 allowance(owner, spender) function selector + encoded params
    const allowanceSelector = '0xdd62ed3e';
    const allowanceData = allowanceSelector +
      walletAddress.slice(2).padStart(64, '0') +
      POLYGON_CONTRACTS.CTF_EXCHANGE.slice(2).padStart(64, '0');

    // Raw eth_call - bypasses ethers completely, no circular references
    const usdcAllowanceHex = await rawRpcCall(rpcUrl, 'eth_call', [
      { to: POLYGON_CONTRACTS.USDC, data: allowanceData },
      'latest'
    ]);

    const usdcAllowance = BigInt(usdcAllowanceHex);
    console.log(`[Allowances] Current USDC allowance: ${Number(usdcAllowance) / 1e6} USDC`);

    const ONE_MILLION_USDC = BigInt(1_000_000) * BigInt(1e6);

    if (usdcAllowance < ONE_MILLION_USDC) {
      console.log('[Allowances] ⚙️  Setting unlimited USDC approval...');
      console.log(`[Allowances] Approving ${POLYGON_CONTRACTS.CTF_EXCHANGE} to spend USDC`);

      // For WRITE operations, use regular JsonRpcProvider (not Static)
      const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
      const wallet = new ethers.Wallet(privateKey, provider);

      // Use Interface to encode function data (no Contract object)
      const usdcInterface = new ethers.utils.Interface([
        'function approve(address spender, uint256 amount) returns (bool)'
      ]);

      // Get current gas prices from network
      const feeData = await provider.getFeeData();

      // Polygon requires minimum 30 Gwei priority fee (use 35 to be safe)
      const priorityFee = ethers.utils.parseUnits('35', 'gwei');
      const maxFeePerGas = feeData.maxFeePerGas || ethers.utils.parseUnits('200', 'gwei');

      const tx = await wallet.sendTransaction({
        to: POLYGON_CONTRACTS.USDC,
        data: usdcInterface.encodeFunctionData('approve', [
          POLYGON_CONTRACTS.CTF_EXCHANGE,
          ethers.constants.MaxUint256
        ]),
        maxPriorityFeePerGas: priorityFee,
        maxFeePerGas: maxFeePerGas.add(priorityFee),
      });

      console.log(`[Allowances] Transaction sent: ${tx.hash}`);
      console.log('[Allowances] Waiting for confirmation (max 2 minutes)...');

      const receipt = await Promise.race([
        tx.wait(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Transaction confirmation timeout after 2 minutes')), 120000)
        ),
      ]) as any;

      console.log(`[Allowances] ✅ USDC approval confirmed (block ${receipt.blockNumber})`);
    } else {
      console.log('[Allowances] ✅ USDC allowance already set');
    }

    // ═══════════════════════════════════════════════════════════════
    // 2. Check and Set CTF Approval (for SELL orders)
    // ═══════════════════════════════════════════════════════════════

    // ERC1155 isApprovedForAll(owner, operator) function selector + encoded params
    const isApprovedSelector = '0xe985e9c5';
    const isApprovedData = isApprovedSelector +
      walletAddress.slice(2).padStart(64, '0') +
      POLYGON_CONTRACTS.CTF_EXCHANGE.slice(2).padStart(64, '0');

    // Raw eth_call - bypasses ethers completely
    const ctfApprovedHex = await rawRpcCall(rpcUrl, 'eth_call', [
      { to: POLYGON_CONTRACTS.CTF, data: isApprovedData },
      'latest'
    ]);

    const isApproved = BigInt(ctfApprovedHex) !== BigInt(0);

    if (!isApproved) {
      console.log('[Allowances] ⚙️  Setting CTF approval for all tokens...');
      console.log(`[Allowances] Approving ${POLYGON_CONTRACTS.CTF_EXCHANGE} to manage CTF tokens`);

      // For WRITE operations, use regular JsonRpcProvider (not Static)
      const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
      const wallet = new ethers.Wallet(privateKey, provider);

      // Use Interface to encode function data (no Contract object)
      const ctfInterface = new ethers.utils.Interface([
        'function setApprovalForAll(address operator, bool approved)'
      ]);

      // Get current gas prices from network
      const feeData = await provider.getFeeData();

      // Polygon requires minimum 30 Gwei priority fee (use 35 to be safe)
      const priorityFee = ethers.utils.parseUnits('35', 'gwei');
      const maxFeePerGas = feeData.maxFeePerGas || ethers.utils.parseUnits('200', 'gwei');

      const tx = await wallet.sendTransaction({
        to: POLYGON_CONTRACTS.CTF,
        data: ctfInterface.encodeFunctionData('setApprovalForAll', [
          POLYGON_CONTRACTS.CTF_EXCHANGE,
          true
        ]),
        maxPriorityFeePerGas: priorityFee,
        maxFeePerGas: maxFeePerGas.add(priorityFee),
      });

      console.log(`[Allowances] Transaction sent: ${tx.hash}`);
      console.log('[Allowances] Waiting for confirmation (max 2 minutes)...');

      const receipt = await Promise.race([
        tx.wait(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Transaction confirmation timeout after 2 minutes')), 120000)
        ),
      ]) as any;

      console.log(`[Allowances] ✅ CTF approval confirmed (block ${receipt.blockNumber})`);
    } else {
      console.log('[Allowances] ✅ CTF approval already set');
    }

    // ═══════════════════════════════════════════════════════════════
    // 3. Check and Set USDC Allowance for NEG_RISK Exchange
    // ═══════════════════════════════════════════════════════════════

    // Check NEG_RISK exchange allowance (most popular markets use this)
    const negRiskAllowanceData = allowanceSelector +
      walletAddress.slice(2).padStart(64, '0') +
      POLYGON_CONTRACTS.NEG_RISK_CTF_EXCHANGE.slice(2).padStart(64, '0');

    const negRiskUsdcAllowanceHex = await rawRpcCall(rpcUrl, 'eth_call', [
      { to: POLYGON_CONTRACTS.USDC, data: negRiskAllowanceData },
      'latest'
    ]);

    const negRiskUsdcAllowance = BigInt(negRiskUsdcAllowanceHex);
    console.log(`[Allowances] Current NEG_RISK USDC allowance: ${Number(negRiskUsdcAllowance) / 1e6} USDC`);

    if (negRiskUsdcAllowance < ONE_MILLION_USDC) {
      console.log('[Allowances] ⚙️  Setting unlimited NEG_RISK USDC approval...');
      console.log(`[Allowances] Approving ${POLYGON_CONTRACTS.NEG_RISK_CTF_EXCHANGE} to spend USDC`);

      const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
      const wallet = new ethers.Wallet(privateKey, provider);

      const usdcInterface = new ethers.utils.Interface([
        'function approve(address spender, uint256 amount) returns (bool)'
      ]);

      const feeData = await provider.getFeeData();
      const priorityFee = ethers.utils.parseUnits('35', 'gwei');
      const maxFeePerGas = feeData.maxFeePerGas || ethers.utils.parseUnits('200', 'gwei');

      const tx = await wallet.sendTransaction({
        to: POLYGON_CONTRACTS.USDC,
        data: usdcInterface.encodeFunctionData('approve', [
          POLYGON_CONTRACTS.NEG_RISK_CTF_EXCHANGE,
          ethers.constants.MaxUint256
        ]),
        maxPriorityFeePerGas: priorityFee,
        maxFeePerGas: maxFeePerGas.add(priorityFee),
      });

      console.log(`[Allowances] Transaction sent: ${tx.hash}`);
      console.log('[Allowances] Waiting for confirmation (max 2 minutes)...');

      const receipt = await Promise.race([
        tx.wait(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Transaction confirmation timeout after 2 minutes')), 120000)
        ),
      ]) as any;

      console.log(`[Allowances] ✅ NEG_RISK USDC approval confirmed (block ${receipt.blockNumber})`);
    } else {
      console.log('[Allowances] ✅ NEG_RISK USDC allowance already set');
    }

    // ═══════════════════════════════════════════════════════════════
    // 4. Check and Set CTF Approval for NEG_RISK Exchange
    // ═══════════════════════════════════════════════════════════════

    const negRiskIsApprovedData = isApprovedSelector +
      walletAddress.slice(2).padStart(64, '0') +
      POLYGON_CONTRACTS.NEG_RISK_CTF_EXCHANGE.slice(2).padStart(64, '0');

    const negRiskCtfApprovedHex = await rawRpcCall(rpcUrl, 'eth_call', [
      { to: POLYGON_CONTRACTS.CTF, data: negRiskIsApprovedData },
      'latest'
    ]);

    const negRiskIsApproved = BigInt(negRiskCtfApprovedHex) !== BigInt(0);

    if (!negRiskIsApproved) {
      console.log('[Allowances] ⚙️  Setting NEG_RISK CTF approval for all tokens...');
      console.log(`[Allowances] Approving ${POLYGON_CONTRACTS.NEG_RISK_CTF_EXCHANGE} to manage CTF tokens`);

      const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
      const wallet = new ethers.Wallet(privateKey, provider);

      const ctfInterface = new ethers.utils.Interface([
        'function setApprovalForAll(address operator, bool approved)'
      ]);

      const feeData = await provider.getFeeData();
      const priorityFee = ethers.utils.parseUnits('35', 'gwei');
      const maxFeePerGas = feeData.maxFeePerGas || ethers.utils.parseUnits('200', 'gwei');

      const tx = await wallet.sendTransaction({
        to: POLYGON_CONTRACTS.CTF,
        data: ctfInterface.encodeFunctionData('setApprovalForAll', [
          POLYGON_CONTRACTS.NEG_RISK_CTF_EXCHANGE,
          true
        ]),
        maxPriorityFeePerGas: priorityFee,
        maxFeePerGas: maxFeePerGas.add(priorityFee),
      });

      console.log(`[Allowances] Transaction sent: ${tx.hash}`);
      console.log('[Allowances] Waiting for confirmation (max 2 minutes)...');

      const receipt = await Promise.race([
        tx.wait(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Transaction confirmation timeout after 2 minutes')), 120000)
        ),
      ]) as any;

      console.log(`[Allowances] ✅ NEG_RISK CTF approval confirmed (block ${receipt.blockNumber})`);
    } else {
      console.log('[Allowances] ✅ NEG_RISK CTF approval already set');
    }

    console.log('[Allowances] ✅ All allowances ready for trading\n');

  } catch (error: any) {
    console.error('[Allowances] ❌ Error setting allowances:', error.message);

    // Provide helpful error messages
    if (error.code === 'INSUFFICIENT_FUNDS') {
      throw new Error('Insufficient MATIC for gas fees. Please add MATIC to your wallet.');
    }

    if (error.message.includes('user rejected')) {
      throw new Error('Transaction rejected by user');
    }

    throw error;
  }
}

/**
 * Checks current allowances without modifying them
 * Useful for debugging and monitoring
 */
export async function checkAllowances(
  walletAddress: string,
  rpcUrl: string
): Promise<void> {
  console.log('\n[Allowances] Current allowance status:');

  const allowanceSelector = '0xdd62ed3e';
  const isApprovedSelector = '0xe985e9c5';

  // Check CTF_EXCHANGE allowances
  const allowanceData = allowanceSelector +
    walletAddress.slice(2).padStart(64, '0') +
    POLYGON_CONTRACTS.CTF_EXCHANGE.slice(2).padStart(64, '0');

  const usdcAllowanceHex = await rawRpcCall(rpcUrl, 'eth_call', [
    { to: POLYGON_CONTRACTS.USDC, data: allowanceData },
    'latest'
  ]);

  const usdcAllowance = BigInt(usdcAllowanceHex);

  const isApprovedData = isApprovedSelector +
    walletAddress.slice(2).padStart(64, '0') +
    POLYGON_CONTRACTS.CTF_EXCHANGE.slice(2).padStart(64, '0');

  const ctfApprovedHex = await rawRpcCall(rpcUrl, 'eth_call', [
    { to: POLYGON_CONTRACTS.CTF, data: isApprovedData },
    'latest'
  ]);

  const ctfApproved = BigInt(ctfApprovedHex) !== BigInt(0);

  // Check NEG_RISK_CTF_EXCHANGE allowances
  const negRiskAllowanceData = allowanceSelector +
    walletAddress.slice(2).padStart(64, '0') +
    POLYGON_CONTRACTS.NEG_RISK_CTF_EXCHANGE.slice(2).padStart(64, '0');

  const negRiskUsdcAllowanceHex = await rawRpcCall(rpcUrl, 'eth_call', [
    { to: POLYGON_CONTRACTS.USDC, data: negRiskAllowanceData },
    'latest'
  ]);

  const negRiskUsdcAllowance = BigInt(negRiskUsdcAllowanceHex);

  const negRiskIsApprovedData = isApprovedSelector +
    walletAddress.slice(2).padStart(64, '0') +
    POLYGON_CONTRACTS.NEG_RISK_CTF_EXCHANGE.slice(2).padStart(64, '0');

  const negRiskCtfApprovedHex = await rawRpcCall(rpcUrl, 'eth_call', [
    { to: POLYGON_CONTRACTS.CTF, data: negRiskIsApprovedData },
    'latest'
  ]);

  const negRiskCtfApproved = BigInt(negRiskCtfApprovedHex) !== BigInt(0);

  console.log(`  CTF_EXCHANGE:`);
  console.log(`    USDC: ${Number(usdcAllowance) / 1e6} USDC`);
  console.log(`    CTF:  ${ctfApproved ? 'Approved ✅' : 'Not approved ❌'}`);
  console.log(`  NEG_RISK_CTF_EXCHANGE:`);
  console.log(`    USDC: ${Number(negRiskUsdcAllowance) / 1e6} USDC`);
  console.log(`    CTF:  ${negRiskCtfApproved ? 'Approved ✅' : 'Not approved ❌'}`);
  console.log('');
}
