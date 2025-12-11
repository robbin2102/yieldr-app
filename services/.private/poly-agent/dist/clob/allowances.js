"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureAllowances = ensureAllowances;
exports.checkAllowances = checkAllowances;
const ethers_1 = require("ethers");
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
async function rawRpcCall(rpcUrl, method, params) {
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
    const json = await res.json();
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
 * Required approvals:
 * 1. USDC.approve(CTF_EXCHANGE, MaxUint256) - For BUY orders
 * 2. CTF.setApprovalForAll(CTF_EXCHANGE, true) - For SELL orders
 *
 * @param privateKey - Private key of the wallet (0x prefixed)
 * @param rpcUrl - Polygon RPC URL
 * @param chainId - Chain ID (137 for Polygon)
 */
async function ensureAllowances(privateKey, rpcUrl, chainId) {
    console.log('\n[Allowances] Checking trading allowances...');
    // Only support Polygon mainnet
    if (chainId !== 137) {
        throw new Error(`Unsupported chain ID: ${chainId}. Only Polygon (137) is supported.`);
    }
    // Get wallet address (no provider needed)
    const walletAddress = new ethers_1.ethers.Wallet(privateKey).address;
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
        const ONE_MILLION_USDC = BigInt(1000000) * BigInt(1e6);
        if (usdcAllowance < ONE_MILLION_USDC) {
            console.log('[Allowances] ⚙️  Setting unlimited USDC approval...');
            console.log(`[Allowances] Approving ${POLYGON_CONTRACTS.CTF_EXCHANGE} to spend USDC`);
            // For WRITE operations, use regular JsonRpcProvider (not Static)
            const provider = new ethers_1.ethers.providers.JsonRpcProvider(rpcUrl);
            const wallet = new ethers_1.ethers.Wallet(privateKey, provider);
            // Use Interface to encode function data (no Contract object)
            const usdcInterface = new ethers_1.ethers.utils.Interface([
                'function approve(address spender, uint256 amount) returns (bool)'
            ]);
            const tx = await wallet.sendTransaction({
                to: POLYGON_CONTRACTS.USDC,
                data: usdcInterface.encodeFunctionData('approve', [
                    POLYGON_CONTRACTS.CTF_EXCHANGE,
                    ethers_1.ethers.constants.MaxUint256
                ])
            });
            console.log(`[Allowances] Transaction sent: ${tx.hash}`);
            console.log('[Allowances] Waiting for confirmation (max 2 minutes)...');
            const receipt = await Promise.race([
                tx.wait(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Transaction confirmation timeout after 2 minutes')), 120000)),
            ]);
            console.log(`[Allowances] ✅ USDC approval confirmed (block ${receipt.blockNumber})`);
        }
        else {
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
            const provider = new ethers_1.ethers.providers.JsonRpcProvider(rpcUrl);
            const wallet = new ethers_1.ethers.Wallet(privateKey, provider);
            // Use Interface to encode function data (no Contract object)
            const ctfInterface = new ethers_1.ethers.utils.Interface([
                'function setApprovalForAll(address operator, bool approved)'
            ]);
            const tx = await wallet.sendTransaction({
                to: POLYGON_CONTRACTS.CTF,
                data: ctfInterface.encodeFunctionData('setApprovalForAll', [
                    POLYGON_CONTRACTS.CTF_EXCHANGE,
                    true
                ])
            });
            console.log(`[Allowances] Transaction sent: ${tx.hash}`);
            console.log('[Allowances] Waiting for confirmation (max 2 minutes)...');
            const receipt = await Promise.race([
                tx.wait(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Transaction confirmation timeout after 2 minutes')), 120000)),
            ]);
            console.log(`[Allowances] ✅ CTF approval confirmed (block ${receipt.blockNumber})`);
        }
        else {
            console.log('[Allowances] ✅ CTF approval already set');
        }
        console.log('[Allowances] ✅ All allowances ready for trading\n');
    }
    catch (error) {
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
async function checkAllowances(walletAddress, rpcUrl) {
    console.log('\n[Allowances] Current allowance status:');
    // Check USDC allowance
    const allowanceSelector = '0xdd62ed3e';
    const allowanceData = allowanceSelector +
        walletAddress.slice(2).padStart(64, '0') +
        POLYGON_CONTRACTS.CTF_EXCHANGE.slice(2).padStart(64, '0');
    const usdcAllowanceHex = await rawRpcCall(rpcUrl, 'eth_call', [
        { to: POLYGON_CONTRACTS.USDC, data: allowanceData },
        'latest'
    ]);
    const usdcAllowance = BigInt(usdcAllowanceHex);
    // Check CTF approval
    const isApprovedSelector = '0xe985e9c5';
    const isApprovedData = isApprovedSelector +
        walletAddress.slice(2).padStart(64, '0') +
        POLYGON_CONTRACTS.CTF_EXCHANGE.slice(2).padStart(64, '0');
    const ctfApprovedHex = await rawRpcCall(rpcUrl, 'eth_call', [
        { to: POLYGON_CONTRACTS.CTF, data: isApprovedData },
        'latest'
    ]);
    const ctfApproved = BigInt(ctfApprovedHex) !== BigInt(0);
    console.log(`  USDC: ${Number(usdcAllowance) / 1e6} USDC`);
    console.log(`  CTF:  ${ctfApproved ? 'Approved ✅' : 'Not approved ❌'}`);
    console.log('');
}
//# sourceMappingURL=allowances.js.map