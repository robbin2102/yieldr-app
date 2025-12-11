import { ethers } from 'ethers';
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
export declare function ensureAllowances(wallet: ethers.Wallet, chainId: number): Promise<void>;
/**
 * Checks current allowances without modifying them
 * Useful for debugging and monitoring
 */
export declare function checkAllowances(wallet: ethers.Wallet): Promise<void>;
