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
 * ERC20 ABI - Only the functions we need
 */
const ERC20_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
];

/**
 * ERC1155 ABI - Only the functions we need
 */
const ERC1155_ABI = [
  'function setApprovalForAll(address operator, bool approved) external',
  'function isApprovedForAll(address account, address operator) external view returns (bool)',
];

/**
 * Ensures all required allowances are set for Polymarket trading
 *
 * This is a ONE-TIME setup that needs to happen before placing any orders.
 * We use MaxUint256 (unlimited approval) as recommended by Polymarket's official docs.
 *
 * Required approvals:
 * 1. USDC.approve(CTF_EXCHANGE, MaxUint256) - For BUY orders
 * 2. CTF.setApprovalForAll(CTF_EXCHANGE, true) - For SELL orders
 *
 * @param wallet - Ethers wallet instance
 * @param chainId - Chain ID (137 for Polygon)
 */
export async function ensureAllowances(
  wallet: ethers.Wallet,
  chainId: number
): Promise<void> {
  console.log('\n[Allowances] Checking trading allowances...');

  // Only support Polygon mainnet
  if (chainId !== 137) {
    throw new Error(`Unsupported chain ID: ${chainId}. Only Polygon (137) is supported.`);
  }

  // Get provider from wallet (already connected)
  const provider = wallet.provider;
  if (!provider) {
    throw new Error('Wallet must be connected to a provider');
  }

  try {
    // ═══════════════════════════════════════════════════════════════
    // 1. Check and Set USDC Allowance (for BUY orders)
    // ═══════════════════════════════════════════════════════════════

    const usdcContract = new ethers.Contract(
      POLYGON_CONTRACTS.USDC,
      ERC20_ABI,
      provider // Use provider for read-only, then connect wallet for writes
    );

    const usdcAllowance = await usdcContract.allowance(
      wallet.address,
      POLYGON_CONTRACTS.CTF_EXCHANGE
    );

    console.log(`[Allowances] Current USDC allowance: ${ethers.utils.formatUnits(usdcAllowance, 6)} USDC`);

    // Check if allowance is already sufficient (> 1M USDC means unlimited was set)
    const ONE_MILLION_USDC = ethers.utils.parseUnits('1000000', 6);

    if (usdcAllowance.lt(ONE_MILLION_USDC)) {
      console.log('[Allowances] ⚙️  Setting unlimited USDC approval...');
      console.log(`[Allowances] Approving ${POLYGON_CONTRACTS.CTF_EXCHANGE} to spend USDC`);

      // Create a NEW contract instance with wallet for writing (no circular reference)
      const usdcContractWithSigner = new ethers.Contract(
        POLYGON_CONTRACTS.USDC,
        ERC20_ABI,
        wallet
      );

      const approveTx = await usdcContractWithSigner.approve(
        POLYGON_CONTRACTS.CTF_EXCHANGE,
        ethers.constants.MaxUint256
      );

      console.log(`[Allowances] Transaction sent: ${approveTx.hash}`);
      console.log('[Allowances] Waiting for confirmation (max 2 minutes)...');

      // Wait for confirmation with timeout (2 minutes)
      const receipt = await Promise.race([
        approveTx.wait(),
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

    const ctfContract = new ethers.Contract(
      POLYGON_CONTRACTS.CTF,
      ERC1155_ABI,
      provider // Use provider for read-only
    );

    const isApproved = await ctfContract.isApprovedForAll(
      wallet.address,
      POLYGON_CONTRACTS.CTF_EXCHANGE
    );

    if (!isApproved) {
      console.log('[Allowances] ⚙️  Setting CTF approval for all tokens...');
      console.log(`[Allowances] Approving ${POLYGON_CONTRACTS.CTF_EXCHANGE} to manage CTF tokens`);

      // Create a NEW contract instance with wallet for writing (no circular reference)
      const ctfContractWithSigner = new ethers.Contract(
        POLYGON_CONTRACTS.CTF,
        ERC1155_ABI,
        wallet
      );

      const setApprovalTx = await ctfContractWithSigner.setApprovalForAll(
        POLYGON_CONTRACTS.CTF_EXCHANGE,
        true
      );

      console.log(`[Allowances] Transaction sent: ${setApprovalTx.hash}`);
      console.log('[Allowances] Waiting for confirmation (max 2 minutes)...');

      // Wait for confirmation with timeout (2 minutes)
      const receipt = await Promise.race([
        setApprovalTx.wait(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Transaction confirmation timeout after 2 minutes')), 120000)
        ),
      ]) as any;

      console.log(`[Allowances] ✅ CTF approval confirmed (block ${receipt.blockNumber})`);
    } else {
      console.log('[Allowances] ✅ CTF approval already set');
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
export async function checkAllowances(wallet: ethers.Wallet): Promise<void> {
  console.log('\n[Allowances] Current allowance status:');

  const usdcContract = new ethers.Contract(
    POLYGON_CONTRACTS.USDC,
    ERC20_ABI,
    wallet
  );

  const ctfContract = new ethers.Contract(
    POLYGON_CONTRACTS.CTF,
    ERC1155_ABI,
    wallet
  );

  const usdcAllowance = await usdcContract.allowance(
    wallet.address,
    POLYGON_CONTRACTS.CTF_EXCHANGE
  );

  const ctfApproved = await ctfContract.isApprovedForAll(
    wallet.address,
    POLYGON_CONTRACTS.CTF_EXCHANGE
  );

  console.log(`  USDC: ${ethers.utils.formatUnits(usdcAllowance, 6)} USDC`);
  console.log(`  CTF:  ${ctfApproved ? 'Approved ✅' : 'Not approved ❌'}`);
  console.log('');
}
