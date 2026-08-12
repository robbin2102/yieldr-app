import type { EdgeChainId } from './chains';

/**
 * "Reference" tokens are the tokens we treat as a USD proxy on each chain
 * (native ETH, wrapped ETH, stables) - a swap is priced off whichever side
 * of the trade is a reference token. Almost all meme/degen trades are
 * token<->ETH or token<->stable, so this covers the overwhelming majority
 * of trades without needing a full multi-hop router decoder.
 *
 * HOOD's DEX ecosystem (router/pool factory, wrapped-native + stable
 * addresses) is not yet known to this codebase - the empty list below
 * means HOOD swaps land in `excludedTrades` with a clear reason until
 * those addresses are supplied, rather than silently mis-pricing them.
 */
export interface ReferenceToken {
  address: string; // lowercase
  symbol: 'ETH' | 'WETH' | 'USDC';
  isStable: boolean;
}

/**
 * Sentinel address for native ETH movements (sent as tx.value, not an
 * ERC20 Transfer log) - many swap frontends let you trade "ETH" directly
 * rather than WETH, so without this, that side of the swap is invisible
 * to a Transfer-log-only scan and the whole trade looks unbalanced.
 */
export const NATIVE_PSEUDO_ADDRESS = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

export const REFERENCE_TOKENS: Record<EdgeChainId, ReferenceToken[]> = {
  base: [
    { address: NATIVE_PSEUDO_ADDRESS, symbol: 'ETH', isStable: false },
    { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', isStable: false },
    { address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', symbol: 'USDC', isStable: true },
  ],
  hood: [
    // TBD - needs Robinhood Chain's wrapped-native + stable token addresses.
  ],
  solana: [],
};

export function getReferenceToken(chain: EdgeChainId, address: string): ReferenceToken | null {
  const lower = address.toLowerCase();
  return REFERENCE_TOKENS[chain].find((t) => t.address === lower) ?? null;
}

export function hasReferenceTokens(chain: EdgeChainId): boolean {
  return REFERENCE_TOKENS[chain].length > 0;
}
