import { getPublicClient, CHAINS, ChainNotSupportedError, effectiveLookbackDays, type EdgeChainId } from './chains';
import { resolveBlockRangeForWindow } from './blockRange';
import { getReferenceToken, hasReferenceTokens, REFERENCE_TOKENS } from './referenceTokens';
import { getReferencePriceUsd, recordObservedTradePrice } from './priceService';
import { scanTransfersViaLogs, getDecimals, getBlockTimestamp } from './logScanFallback';
import type { TradeLeg } from './types';

interface NormalizedTransfer {
  hash: string;
  from: string;
  to: string;
  tokenAddress: string;
  qty: number;
  ts: Date;
  blockNumber: bigint;
}

/**
 * Alchemy's enhanced `alchemy_getAssetTransfers` - indexed, paginated,
 * decimal-adjusted, one call per direction. Only available on chains
 * Alchemy has fully onboarded; not assumed to work on HOOD.
 */
async function fetchViaAlchemyEnhancedApi(
  chain: EdgeChainId,
  wallet: string,
  fromBlockHex: string,
  toBlockHex: string
): Promise<NormalizedTransfer[]> {
  const client = getPublicClient(chain);
  const results: NormalizedTransfer[] = [];

  for (const direction of ['from', 'to'] as const) {
    let pageKey: string | undefined;
    do {
      const params: Record<string, unknown> = {
        fromBlock: fromBlockHex,
        toBlock: toBlockHex,
        category: ['erc20'],
        withMetadata: true,
        excludeZeroValue: true,
        maxCount: '0x3e8',
        order: 'asc',
        [direction === 'from' ? 'fromAddress' : 'toAddress']: wallet,
      };
      if (pageKey) params.pageKey = pageKey;

      // alchemy_getAssetTransfers is an Alchemy-specific extension, not part
      // of viem's typed RPC surface - cast is required to call it.
      const res: any = await (client as any).request({
        method: 'alchemy_getAssetTransfers',
        params: [params],
      });

      for (const t of res?.transfers ?? []) {
        const tokenAddress = t.rawContract?.address?.toLowerCase();
        if (!tokenAddress) continue;
        results.push({
          hash: t.hash,
          from: t.from?.toLowerCase(),
          to: t.to?.toLowerCase(),
          tokenAddress,
          qty: Number(t.value ?? 0),
          ts: t.metadata?.blockTimestamp ? new Date(t.metadata.blockTimestamp) : new Date(),
          blockNumber: BigInt(t.blockNum ?? '0x0'),
        });
      }
      pageKey = res?.pageKey;
    } while (pageKey);
  }

  return results;
}

/** Baseline fallback: raw log scan + on-chain decimals/timestamp resolution. */
async function fetchViaLogScan(
  chain: EdgeChainId,
  wallet: string,
  fromBlock: bigint,
  toBlock: bigint
): Promise<NormalizedTransfer[]> {
  const client = getPublicClient(chain);
  const { outgoing, incoming } = await scanTransfersViaLogs(client, wallet, fromBlock, toBlock);
  const all = [...outgoing, ...incoming];

  return Promise.all(
    all.map(async (t) => {
      const decimals = await getDecimals(client, t.tokenAddress as `0x${string}`);
      const ts = await getBlockTimestamp(client, t.blockNumber);
      return {
        hash: t.hash,
        from: t.from,
        to: t.to,
        tokenAddress: t.tokenAddress,
        qty: Number(t.rawValue) / 10 ** decimals,
        ts,
        blockNumber: t.blockNumber,
      };
    })
  );
}

export interface ExcludedTradeReason {
  count: number;
  reason: string;
}

export interface FetchTradesResult {
  legsByToken: Map<string, TradeLeg[]>;
  excluded: ExcludedTradeReason[];
  windowDays: number;
}

/**
 * Fetches the wallet's ERC20 transfer history for the effective lookback
 * window, then classifies each transaction into a priced buy/sell leg
 * against a reference token (ETH/WETH/USDC). Anything that can't be
 * classified this way (multi-hop routes, chains with no reference tokens
 * configured yet) is counted in `excluded`, never silently dropped.
 */
export async function fetchWalletSwapLegs(chain: EdgeChainId, wallet: string): Promise<FetchTradesResult> {
  const cfg = CHAINS[chain];
  if (!cfg.supported) throw new ChainNotSupportedError(chain);

  const windowDays = effectiveLookbackDays(chain);
  const client = getPublicClient(chain);
  const { fromBlock, toBlock } = await resolveBlockRangeForWindow(client, windowDays);
  const walletLower = wallet.toLowerCase();

  let transfers: NormalizedTransfer[];
  try {
    transfers = await fetchViaAlchemyEnhancedApi(
      chain,
      walletLower,
      `0x${fromBlock.toString(16)}`,
      `0x${toBlock.toString(16)}`
    );
  } catch {
    transfers = await fetchViaLogScan(chain, walletLower, fromBlock, toBlock);
  }

  const byHash = new Map<string, { out: NormalizedTransfer[]; in: NormalizedTransfer[] }>();
  for (const t of transfers) {
    const g = byHash.get(t.hash) ?? { out: [], in: [] };
    if (t.from === walletLower) g.out.push(t);
    if (t.to === walletLower) g.in.push(t);
    byHash.set(t.hash, g);
  }

  const legsByToken = new Map<string, TradeLeg[]>();
  const excludedCounts = new Map<string, number>();
  const bump = (reason: string) => excludedCounts.set(reason, (excludedCounts.get(reason) ?? 0) + 1);

  const wethAddr = REFERENCE_TOKENS[chain].find((t) => t.symbol === 'WETH')?.address;

  if (!hasReferenceTokens(chain)) {
    if (byHash.size > 0) bump(`no reference tokens configured for ${cfg.displayName} yet`);
  } else {
    for (const [hash, group] of byHash) {
      if (group.out.length !== 1 || group.in.length !== 1) {
        bump('multi-leg swap not decoded (MVP handles single in/out swaps only)');
        continue;
      }
      const out = group.out[0];
      const inn = group.in[0];
      const outRef = getReferenceToken(chain, out.tokenAddress);
      const inRef = getReferenceToken(chain, inn.tokenAddress);

      if (!outRef && !inRef) {
        bump('token-to-token swap with no ETH/USDC leg - not priced');
        continue;
      }
      if (outRef && inRef) {
        bump('reference-to-reference transfer (not a token trade)');
        continue;
      }

      const refLeg = outRef ? out : inn;
      const refToken = (outRef ?? inRef)!;
      const tokenLeg = outRef ? inn : out;

      if (refLeg.qty <= 0 || tokenLeg.qty <= 0) {
        bump('zero-value leg');
        continue;
      }

      const refPriceUsd = await getReferencePriceUsd(chain, refToken.symbol, refLeg.ts, wethAddr);
      if (refPriceUsd <= 0) {
        bump('could not price the reference-token leg');
        continue;
      }

      const usd = refLeg.qty * refPriceUsd;
      const priceUsd = usd / tokenLeg.qty;
      const side: 'buy' | 'sell' = outRef ? 'buy' : 'sell';

      const leg: TradeLeg = {
        side,
        ts: refLeg.ts,
        blockNumber: tokenLeg.blockNumber,
        qty: tokenLeg.qty,
        priceUsd,
        usd,
        txHash: hash,
      };
      const arr = legsByToken.get(tokenLeg.tokenAddress) ?? [];
      arr.push(leg);
      legsByToken.set(tokenLeg.tokenAddress, arr);

      await recordObservedTradePrice(chain, tokenLeg.tokenAddress, priceUsd, refLeg.ts);
    }
  }

  const excluded: ExcludedTradeReason[] = Array.from(excludedCounts, ([reason, count]) => ({ reason, count }));
  for (const legs of legsByToken.values()) legs.sort((a, b) => a.ts.getTime() - b.ts.getTime());

  return { legsByToken, excluded, windowDays };
}
