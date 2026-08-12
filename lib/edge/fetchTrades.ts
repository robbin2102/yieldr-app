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
  /** Raw on-chain token units (before decimal division). Used for exact Swap-event matching on HOOD. */
  rawQty: bigint;
  ts: Date;
  blockNumber: bigint;
}

// HOOD/Doppler DEX constants for Swap event decoding
const HOOD_POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const SWAP_TOPIC = '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f';

const _BIT255 = BigInt(2) ** BigInt(255);
const _TWO256 = BigInt(2) ** BigInt(256);

/**
 * Decode a 32-byte ABI-encoded int128/int256 slot. ABI sign-extends int128
 * into a full 256-bit slot, so the sign bit is bit 255, not bit 127.
 */
function abiSignedInt(hex: string): bigint {
  const u = BigInt(hex);
  return u >= _BIT255 ? u - _TWO256 : u;
}

/**
 * On HOOD, Doppler DEX routes swaps through RobinHoodSettler which never
 * sends tokens back to the wallet address directly. The only on-chain record
 * of the WETH received is in the PoolManager's Swap event. This function:
 *  1. Identifies txs with an outgoing transfer but no incoming transfer (the
 *     Doppler trade pattern).
 *  2. Fetches the tx receipt for each such tx.
 *  3. Finds the PoolManager Swap event where one signed amount matches the
 *     outgoing raw token amount (within 0.2%).
 *  4. Returns synthetic NormalizedTransfer records for the WETH "in" leg so
 *     the existing 1-out + 1-in matching logic can price the trade normally.
 */
async function enrichHoodDopplerLegs(
  client: any,
  wallet: string,
  transfers: NormalizedTransfer[]
): Promise<NormalizedTransfer[]> {
  const wethAddress = REFERENCE_TOKENS['hood'].find((t) => t.symbol === 'WETH')?.address;
  if (!wethAddress) return [];

  // Index by hash to find 1-out-0-in pattern
  const byHash = new Map<string, { out: NormalizedTransfer[]; in: NormalizedTransfer[] }>();
  for (const t of transfers) {
    const g = byHash.get(t.hash) ?? { out: [], in: [] };
    if (t.from === wallet) g.out.push(t);
    if (t.to === wallet) g.in.push(t);
    byHash.set(t.hash, g);
  }

  const candidates = Array.from(byHash.entries())
    .filter(([, g]) => g.out.length === 1 && g.in.length === 0)
    .map(([hash, g]) => ({ hash, out: g.out[0] }));

  if (candidates.length === 0) return [];

  console.log(`[edge:fetchTrades] hood enriching ${candidates.length} Doppler trade(s) via PoolManager Swap events`);

  // Fetch receipts in parallel (capped to avoid overwhelming RPC)
  const BATCH = 10;
  const synthetic: NormalizedTransfer[] = [];

  for (let i = 0; i < candidates.length; i += BATCH) {
    const batch = candidates.slice(i, i + BATCH);
    const receipts = await Promise.all(
      batch.map(({ hash }) =>
        client.request({ method: 'eth_getTransactionReceipt', params: [hash] }).catch(() => null)
      )
    );

    for (let j = 0; j < batch.length; j++) {
      const { hash, out } = batch[j];
      const receipt: any = receipts[j];
      if (!receipt) continue;

      const swapLogs = (receipt.logs ?? []).filter(
        (log: any) =>
          log.address?.toLowerCase() === HOOD_POOL_MANAGER && log.topics?.[0] === SWAP_TOPIC
      );

      let enriched = false;
      for (const swapLog of swapLogs) {
        if (enriched) break;
        const data = (swapLog.data as string).slice(2);
        const amount0 = abiSignedInt('0x' + data.slice(0, 64));
        const amount1 = abiSignedInt('0x' + data.slice(64, 128));

        // The settler "pays" the sold token to the pool (negative) and
        // "receives" WETH from the pool (positive). Try both orderings.
        for (const [paidAmt, receivedAmt] of [
          [amount0, amount1],
          [amount1, amount0],
        ] as [bigint, bigint][]) {
          if (paidAmt >= BigInt(0) || receivedAmt <= BigInt(0)) continue;
          const absPaid = -paidAmt;
          if (out.rawQty === BigInt(0)) continue;

          // Match within 0.2%
          const diff = absPaid > out.rawQty ? absPaid - out.rawQty : out.rawQty - absPaid;
          if (diff > out.rawQty / BigInt(500)) continue;

          const wethQty = Number(receivedAmt) / 1e18;
          synthetic.push({
            hash,
            from: HOOD_POOL_MANAGER,
            to: wallet,
            tokenAddress: wethAddress,
            qty: wethQty,
            rawQty: receivedAmt,
            ts: out.ts,
            blockNumber: out.blockNumber,
          });
          console.log(
            `[edge:fetchTrades] hood Doppler trade decoded hash=${hash.slice(0, 10)} sold=${out.qty.toFixed(4)} ${
              out.tokenAddress.slice(0, 10)
            } received=${wethQty.toFixed(8)} WETH`
          );
          enriched = true;
          break;
        }
      }

      if (!enriched) {
        console.log(
          `[edge:fetchTrades] hood Doppler trade hash=${hash.slice(0, 10)} has no matching Swap event (hook-only or unsupported pattern)`
        );
      }
    }
  }

  return synthetic;
}

/**
 * Alchemy's enhanced `alchemy_getAssetTransfers` - indexed, paginated,
 * decimal-adjusted, one call per direction.
 *
 * Note: HOOD (robinhood-mainnet.g.alchemy.com) does not support the
 * 'internal' category - using it returns a hard error. Only 'erc20' and
 * 'external' are requested for HOOD; 'internal' is used on Base where it
 * catches ETH returned via internal contract calls (e.g. router unwrapping
 * WETH on a sell).
 */
async function fetchViaAlchemyEnhancedApi(
  chain: EdgeChainId,
  wallet: string,
  fromBlockHex: string,
  toBlockHex: string
): Promise<NormalizedTransfer[]> {
  const client = getPublicClient(chain);
  const results: NormalizedTransfer[] = [];

  // HOOD doesn't support 'internal' transfers in alchemy_getAssetTransfers
  const category = chain === 'hood' ? ['erc20', 'external'] : ['erc20', 'external', 'internal'];

  for (const direction of ['from', 'to'] as const) {
    let pageKey: string | undefined;
    let pages = 0;
    do {
      pages++;
      const params: Record<string, unknown> = {
        fromBlock: fromBlockHex,
        toBlock: toBlockHex,
        category,
        withMetadata: true,
        excludeZeroValue: true,
        maxCount: '0x3e8',
        order: 'asc',
        [direction === 'from' ? 'fromAddress' : 'toAddress']: wallet,
      };
      if (pageKey) params.pageKey = pageKey;

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
        // rawContract.value is the raw hex token amount before decimal adjustment.
        // For native transfers Alchemy doesn't populate rawContract, so fall back
        // to converting the decimal value to wei.
        const rawHex: string | undefined = t.rawContract?.value;
        const rawQty = rawHex
          ? BigInt(rawHex)
          : BigInt(Math.round((Number(t.value ?? 0)) * 1e18));

        results.push({
          hash: t.hash,
          from: t.from?.toLowerCase(),
          to: t.to?.toLowerCase(),
          tokenAddress,
          qty: Number(t.value ?? 0),
          rawQty,
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
      const rawQty = BigInt(t.rawValue ?? 0);
      return {
        hash: t.hash,
        from: t.from,
        to: t.to,
        tokenAddress: t.tokenAddress,
        qty: Number(rawQty) / 10 ** decimals,
        rawQty,
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

  // HOOD/Doppler trades settle WETH into RobinHoodSettler, never back to the
  // wallet address directly. The PoolManager's Swap event is the only on-chain
  // record of what WETH was received. Inject synthetic WETH in-legs so the
  // standard 1-out + 1-in matching below can price these trades normally.
  if (chain === 'hood') {
    const enriched = await enrichHoodDopplerLegs(client, walletLower, transfers);
    if (enriched.length > 0) transfers = [...transfers, ...enriched];
  }

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
