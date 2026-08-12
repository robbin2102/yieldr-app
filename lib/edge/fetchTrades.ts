import { getPublicClient, CHAINS, ChainNotSupportedError, effectiveLookbackDays, type EdgeChainId } from './chains';
import { resolveBlockRangeForWindow } from './blockRange';
import { getReferenceToken, hasReferenceTokens, REFERENCE_TOKENS, NATIVE_PSEUDO_ADDRESS } from './referenceTokens';
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
    let pages = 0;
    do {
      pages++;
      const params: Record<string, unknown> = {
        fromBlock: fromBlockHex,
        toBlock: toBlockHex,
        // 'external' = native ETH moved as tx.value (wallet paying a router
        // directly). 'internal' = native ETH moved via an internal contract
        // call within the tx trace - e.g. a router unwrapping WETH and
        // sending ETH back to the wallet on a sell. A swap frontend can
        // return ETH either way; requesting only 'external' made every
        // sell-for-ETH (or buy-with-ETH routed through an intermediate
        // contract) look like a lone unbalanced leg, since the ETH side
        // never showed up at all.
        category: ['erc20', 'external', 'internal'],
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

      let skippedNoAddress = 0;
      for (const t of res?.transfers ?? []) {
        const isNative = t.category === 'external' || t.category === 'internal';
        const tokenAddress = isNative ? NATIVE_PSEUDO_ADDRESS : t.rawContract?.address?.toLowerCase();
        if (!tokenAddress) {
          skippedNoAddress++;
          continue;
        }
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
      console.log(
        `[edge:fetchTrades] ${chain} alchemy_getAssetTransfers dir=${direction} page=${pages} got=${
          res?.transfers?.length ?? 0
        } skippedNoAddress=${skippedNoAddress} hasNextPage=${Boolean(res?.pageKey)}`
      );
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
  /** A few example tx hashes for this reason, so it's checkable against a block explorer instead of taken on faith. */
  sampleTxHashes: string[];
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
  console.log(`[edge:fetchTrades] ${chain} ${walletLower} window=${windowDays}d blocks=${fromBlock}-${toBlock}`);

  let transfers: NormalizedTransfer[];
  let fetchPath: 'alchemy-enhanced' | 'log-scan-fallback';
  try {
    transfers = await fetchViaAlchemyEnhancedApi(
      chain,
      walletLower,
      `0x${fromBlock.toString(16)}`,
      `0x${toBlock.toString(16)}`
    );
    fetchPath = 'alchemy-enhanced';
  } catch (err) {
    // This fallback has NO native-ETH support (see fetchViaLogScan) - any
    // swap where ETH moved as tx.value rather than a WETH Transfer will end
    // up as a lone unbalanced leg once we get here. Logging the real error
    // (previously swallowed) so a silent Alchemy failure - wrong method,
    // rate limit, non-Alchemy RPC URL - is visible instead of looking like
    // a data problem with the wallet itself.
    console.error(
      `[edge:fetchTrades] ${chain} alchemy_getAssetTransfers FAILED, falling back to log-scan (NO native-ETH support): ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    transfers = await fetchViaLogScan(chain, walletLower, fromBlock, toBlock);
    fetchPath = 'log-scan-fallback';
  }

  const nativeCount = transfers.filter((t) => t.tokenAddress === NATIVE_PSEUDO_ADDRESS).length;
  console.log(
    `[edge:fetchTrades] ${chain} path=${fetchPath} rawTransfers=${transfers.length} native=${nativeCount} erc20=${
      transfers.length - nativeCount
    }`
  );

  const byHash = new Map<string, { out: NormalizedTransfer[]; in: NormalizedTransfer[] }>();
  for (const t of transfers) {
    const g = byHash.get(t.hash) ?? { out: [], in: [] };
    if (t.from === walletLower) g.out.push(t);
    if (t.to === walletLower) g.in.push(t);
    byHash.set(t.hash, g);
  }
  const balanced = Array.from(byHash.values()).filter((g) => g.out.length === 1 && g.in.length === 1).length;
  console.log(
    `[edge:fetchTrades] ${chain} distinctTxHashes=${byHash.size} balanced(1out/1in)=${balanced} unbalanced=${
      byHash.size - balanced
    }`
  );

  const legsByToken = new Map<string, TradeLeg[]>();
  const excludedCounts = new Map<string, number>();
  const excludedSamples = new Map<string, string[]>();
  const bump = (reason: string, hash?: string) => {
    excludedCounts.set(reason, (excludedCounts.get(reason) ?? 0) + 1);
    if (hash) {
      const samples = excludedSamples.get(reason) ?? [];
      if (samples.length < 5) samples.push(hash);
      excludedSamples.set(reason, samples);
    }
  };

  const wethAddr = REFERENCE_TOKENS[chain].find((t) => t.symbol === 'WETH')?.address;

  if (!hasReferenceTokens(chain)) {
    if (byHash.size > 0) bump(`no reference tokens configured for ${cfg.displayName} yet`);
  } else {
    for (const [hash, group] of byHash) {
      if (group.out.length !== 1 || group.in.length !== 1) {
        bump(
          `unbalanced swap not decoded (${group.out.length} out-leg(s), ${group.in.length} in-leg(s) - MVP handles single in/out swaps only)`,
          hash
        );
        continue;
      }
      const out = group.out[0];
      const inn = group.in[0];
      const outRef = getReferenceToken(chain, out.tokenAddress);
      const inRef = getReferenceToken(chain, inn.tokenAddress);

      if (!outRef && !inRef) {
        bump('token-to-token swap with no ETH/USDC leg - not priced', hash);
        continue;
      }
      if (outRef && inRef) {
        bump('reference-to-reference transfer (not a token trade)', hash);
        continue;
      }

      const refLeg = outRef ? out : inn;
      const refToken = (outRef ?? inRef)!;
      const tokenLeg = outRef ? inn : out;

      if (refLeg.qty <= 0 || tokenLeg.qty <= 0) {
        bump('zero-value leg', hash);
        continue;
      }

      const refPriceUsd = await getReferencePriceUsd(chain, refToken.symbol, refLeg.ts, wethAddr);
      if (refPriceUsd <= 0) {
        bump('could not price the reference-token leg', hash);
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

  const excluded: ExcludedTradeReason[] = Array.from(excludedCounts, ([reason, count]) => ({
    reason,
    count,
    sampleTxHashes: excludedSamples.get(reason) ?? [],
  }));
  for (const legs of legsByToken.values()) legs.sort((a, b) => a.ts.getTime() - b.ts.getTime());

  console.log(
    `[edge:fetchTrades] ${chain} priced ${legsByToken.size} token(s), ${Array.from(legsByToken.values()).reduce(
      (s, l) => s + l.length,
      0
    )} leg(s) total. Excluded: ${excluded.map((e) => `${e.count}x ${e.reason}`).join('; ') || 'none'}`
  );

  return { legsByToken, excluded, windowDays };
}
