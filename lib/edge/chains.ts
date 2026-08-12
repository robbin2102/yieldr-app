/**
 * Chain registry for the Quant Agent wallet-edge-detection feature.
 *
 * This is deliberately separate from lib/wagmi.ts / lib/contracts.ts, which
 * configure the *connect UI*. This registry configures *server-side reads*
 * of a wallet's trade history, independent of which chain the user's wallet
 * client happens to be connected to.
 *
 * HOOD (Robinhood Chain) genesis is ~2026-07-01, so its lookback window is
 * naturally capped below 90 days without any special-casing beyond
 * `effectiveLookbackDays()`.
 */
import { createPublicClient, http, defineChain, type Chain, type PublicClient } from 'viem';
import { base } from 'viem/chains';

export type EdgeChainId = 'base' | 'hood' | 'solana';

export const HOOD_CHAIN_ID = 4663;
export const HOOD_GENESIS_AT = new Date('2026-07-01T00:00:00Z');
export const EDGE_LOOKBACK_DAYS = 90;

export const hood: Chain = defineChain({
  id: HOOD_CHAIN_ID,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: [process.env.ALCHEMY_HOOD_RPC_URL || ''] },
  },
});

export interface EdgeChainConfig {
  id: EdgeChainId;
  chainId: number | null;
  displayName: string;
  viemChain: Chain | null;
  rpcUrl: string | undefined;
  genesisAt: Date | null;
  /** false = architected-for but not wired; callers get ChainNotSupportedError */
  supported: boolean;
}

export const CHAINS: Record<EdgeChainId, EdgeChainConfig> = {
  base: {
    id: 'base',
    chainId: base.id,
    displayName: 'Base',
    viemChain: base,
    rpcUrl: process.env.ALCHEMY_BASE_RPC_URL,
    genesisAt: null,
    supported: Boolean(process.env.ALCHEMY_BASE_RPC_URL),
  },
  hood: {
    id: 'hood',
    chainId: HOOD_CHAIN_ID,
    displayName: 'Robinhood Chain',
    viemChain: hood,
    rpcUrl: process.env.ALCHEMY_HOOD_RPC_URL,
    genesisAt: HOOD_GENESIS_AT,
    supported: Boolean(process.env.ALCHEMY_HOOD_RPC_URL),
  },
  solana: {
    id: 'solana',
    chainId: null,
    displayName: 'Solana',
    viemChain: null,
    rpcUrl: undefined,
    genesisAt: null,
    supported: false,
  },
};

export class ChainNotSupportedError extends Error {
  constructor(public chain: EdgeChainId) {
    super(`${CHAINS[chain].displayName} is not wired up yet for edge analysis`);
    this.name = 'ChainNotSupportedError';
  }
}

const clientCache = new Map<EdgeChainId, PublicClient>();

export function getPublicClient(chain: EdgeChainId): PublicClient {
  const cfg = CHAINS[chain];
  if (!cfg.supported || !cfg.rpcUrl || !cfg.viemChain) {
    throw new ChainNotSupportedError(chain);
  }
  const cached = clientCache.get(chain);
  if (cached) return cached;
  // retryCount/retryDelay covers transient 429s from a fresh/low-tier Alchemy
  // app - every call site (getBlock, getLogs, readContract, ...) benefits
  // since they all go through this one transport.
  const client = createPublicClient({
    chain: cfg.viemChain,
    transport: http(cfg.rpcUrl, { retryCount: 5, retryDelay: 1000 }),
  });
  clientCache.set(chain, client);
  return client;
}

/** Chains we actually analyze for a wallet right now (Solana excluded until wired). */
export function activeChains(): EdgeChainId[] {
  return (Object.keys(CHAINS) as EdgeChainId[]).filter((c) => CHAINS[c].supported);
}

/**
 * How far back to look on this chain. HOOD can never have more history than
 * its own genesis, so this naturally shrinks instead of erroring.
 */
export function effectiveLookbackDays(chain: EdgeChainId, asOf: Date = new Date()): number {
  const cfg = CHAINS[chain];
  if (!cfg.genesisAt) return EDGE_LOOKBACK_DAYS;
  const daysSinceGenesis = Math.floor((asOf.getTime() - cfg.genesisAt.getTime()) / 86_400_000);
  return Math.max(0, Math.min(EDGE_LOOKBACK_DAYS, daysSinceGenesis));
}
