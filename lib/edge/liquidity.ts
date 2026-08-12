import { getPublicClient, type EdgeChainId } from './chains';
import { getReferenceToken } from './referenceTokens';
import { getReferencePriceUsd } from './priceService';

/** Minimal Uniswap-V2-style pool ABI - covers Aerodrome and most Base meme-coin pools. */
const V2_POOL_ABI = [
  { type: 'function', name: 'getReserves', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint112' }, { type: 'uint112' }, { type: 'uint32' }] },
  { type: 'function', name: 'token0', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'token1', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const;

const tokenDecimalsCache = new Map<string, number>();

/**
 * Best-effort pool liquidity in USD at a specific historical block, via a
 * point-in-time eth_call. Only works for Uniswap-V2-style pools (constant
 * product, getReserves()) - Uniswap V3 pools use concentrated liquidity
 * and don't have a single "reserves" number, so this returns null for
 * those rather than computing a misleading figure. Liquidity-at-entry is
 * still reported when derivable; it's just not universal coverage.
 */
export async function getPoolLiquidityUsdAtBlock(
  chain: EdgeChainId,
  poolAddress: string,
  blockNumber: bigint,
  wethAddress: string | undefined,
  at: Date
): Promise<number | null> {
  try {
    const client = getPublicClient(chain);
    const pool = poolAddress as `0x${string}`;

    const [reserves, token0, token1] = await Promise.all([
      client.readContract({ address: pool, abi: V2_POOL_ABI, functionName: 'getReserves', blockNumber }),
      client.readContract({ address: pool, abi: V2_POOL_ABI, functionName: 'token0', blockNumber }),
      client.readContract({ address: pool, abi: V2_POOL_ABI, functionName: 'token1', blockNumber }),
    ]);

    const [reserve0, reserve1] = reserves as [bigint, bigint, number];
    const refToken = getReferenceToken(chain, token0 as string) ?? getReferenceToken(chain, token1 as string);
    if (!refToken) return null;

    const isToken0Ref = getReferenceToken(chain, token0 as string) !== null;
    const refReserve = isToken0Ref ? reserve0 : reserve1;
    const refDecimals = await getDecimalsCached(client, (isToken0Ref ? token0 : token1) as string);

    const refQty = Number(refReserve) / 10 ** refDecimals;
    const refPriceUsd = await getReferencePriceUsd(chain, refToken.symbol, at, wethAddress);
    if (refPriceUsd <= 0) return null;

    // Constant-product pool: both sides hold roughly equal USD value.
    return refQty * refPriceUsd * 2;
  } catch {
    return null;
  }
}

async function getDecimalsCached(client: ReturnType<typeof getPublicClient>, address: string): Promise<number> {
  const key = address.toLowerCase();
  const cached = tokenDecimalsCache.get(key);
  if (cached !== undefined) return cached;
  try {
    const decimals = await client.readContract({
      address: address as `0x${string}`,
      abi: [{ type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] }] as const,
      functionName: 'decimals',
    });
    tokenDecimalsCache.set(key, decimals as number);
    return decimals as number;
  } catch {
    tokenDecimalsCache.set(key, 18);
    return 18;
  }
}
