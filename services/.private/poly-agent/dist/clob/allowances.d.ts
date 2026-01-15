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
export declare function ensureAllowances(privateKey: string, rpcUrl: string, chainId: number): Promise<void>;
/**
 * Checks current allowances without modifying them
 * Useful for debugging and monitoring
 */
export declare function checkAllowances(walletAddress: string, rpcUrl: string): Promise<void>;
