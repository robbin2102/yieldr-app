import type { EdgeChainId } from './chains';

/**
 * "Reference" tokens are the tokens we treat as a USD proxy on each chain
 * (native ETH, wrapped ETH, stables) - a swap is priced off whichever side
 * of the trade is a reference token. Almost all meme/degen trades are
 * token<->ETH or token<->stable, so this covers the overwhelming majority
 * of trades without needing a full multi-hop router decoder.
 *
 * HOOD's wrapped-native (WETH) and stable (USDG) addresses are wired in
 * below. Note this only gets HOOD swaps *classified* as trades - actually
 * pricing a WETH-denominated one still depends on GeckoTerminal indexing
 * HOOD's DEX pools, which it does not yet (see geckoterminal.ts). USDG
 * trades price immediately since stables short-circuit to $1 without
 * needing any pool lookup - that's the one HOOD path that's fully live
 * today. WETH-denominated HOOD trades will surface as "could not price
 * the reference-token leg" until GeckoTerminal (or another source) adds
 * HOOD support - an honest, specific exclusion instead of a blanket
 * "not configured" one.
 */
export interface ReferenceToken {
  address: string; // lowercase
  symbol: 'ETH' | 'WETH' | 'USDC' | 'USDG' | 'VIRTUAL';
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
    { address: '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b', symbol: 'VIRTUAL', isStable: false },
  ],
  hood: [
    { address: NATIVE_PSEUDO_ADDRESS, symbol: 'ETH', isStable: false },
    { address: '0x0bd7d308f8e1639fab988df18a8011f41eacad73', symbol: 'WETH', isStable: false },
    { address: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', symbol: 'USDG', isStable: true },
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
