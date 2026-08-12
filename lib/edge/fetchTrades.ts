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

// Uniswap V4 PoolManager addresses per chain (for Swap event enrichment)
const POOL_MANAGER_BY_CHAIN: Partial<Record<EdgeChainId, string>> = {
  hood: '0x8366a39cc670b4001a1121b8f6a443a643e40951', // Doppler DEX on Robinhood Chain
  base: '0x498581ff718922c3f8e6a244956af099b2652b2b', // Uniswap V4 on Base
};
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
 * Enriches Uniswap V4 swaps where one side of the trade is invisible to
 * Alchemy's asset-transfer API. Two patterns:
 *
 *  SELL (1-out-0-in): wallet sends a token; WETH receipt never hits the wallet
 *    address directly (HOOD Doppler/RobinHoodSettler, Base V4 sells via router).
 *    Injects a synthetic WETH in-leg from the PoolManager Swap event.
 *
 *  RELAY-BUY (0-out-1-in): wallet receives a token; the payment came from
 *    another chain or intermediary (FOMO Base trades funded from Solana via
 *    Relay bridge). Injects a synthetic WETH out-leg from the Swap event.
 *
 * Both HOOD (Doppler) and Base (Uniswap V4) use the same Swap event signature
 * and ABI layout — only the PoolManager address differs.
 */
async function enrichUniswapV4Legs(
  chain: EdgeChainId,
  client: any,
  wallet: string,
  transfers: NormalizedTransfer[]
): Promise<NormalizedTransfer[]> {
  const poolManager = POOL_MANAGER_BY_CHAIN[chain];
  if (!poolManager) return [];

  const wethAddress = REFERENCE_TOKENS[chain]?.find((t) => t.symbol === 'WETH')?.address;
  if (!wethAddress) return [];

  const byHash = new Map<string, { out: NormalizedTransfer[]; in: NormalizedTransfer[] }>();
  for (const t of transfers) {
    const g = byHash.get(t.hash) ?? { out: [], in: [] };
    if (t.from === wallet) g.out.push(t);
    if (t.to === wallet) g.in.push(t);
    byHash.set(t.hash, g);
  }

  type Candidate =
    | { hash: string; direction: 'sell'; leg: NormalizedTransfer }
    | { hash: string; direction: 'buy'; leg: NormalizedTransfer };

  const candidates: Candidate[] = [];
  for (const [hash, g] of byHash) {
    if (g.out.length === 1 && g.in.length === 0) {
      candidates.push({ hash, direction: 'sell', leg: g.out[0] });
    } else if (g.out.length === 0 && g.in.length === 1) {
      candidates.push({ hash, direction: 'buy', leg: g.in[0] });
    }
  }

  if (candidates.length === 0) return [];

  console.log(
    `[edge:fetchTrades] ${chain} enriching ${candidates.length} Uniswap V4 trade(s) (${
      candidates.filter((c) => c.direction === 'sell').length
    } sell, ${candidates.filter((c) => c.direction === 'buy').length} relay-buy)`
  );

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
      const candidate = batch[j];
      const receipt: any = receipts[j];
      if (!receipt) continue;

      const swapLogs = (receipt.logs ?? []).filter(
        (log: any) =>
          log.address?.toLowerCase() === poolManager && log.topics?.[0] === SWAP_TOPIC
      );

      let enriched = false;
      for (const swapLog of swapLogs) {
        if (enriched) break;
        const data = (swapLog.data as string).slice(2);
        const amount0 = abiSignedInt('0x' + data.slice(0, 64));
        const amount1 = abiSignedInt('0x' + data.slice(64, 128));

        const { direction, leg } = candidate;
        if (leg.rawQty === BigInt(0)) continue;

        if (direction === 'sell') {
          // Negative amount = token paid to pool (sold). Positive = WETH received.
          // Try both amount0/amount1 orderings.
          for (const [paidAmt, receivedAmt] of [
            [amount0, amount1],
            [amount1, amount0],
          ] as [bigint, bigint][]) {
            if (paidAmt >= BigInt(0) || receivedAmt <= BigInt(0)) continue;
            const absPaid = -paidAmt;
            const diff = absPaid > leg.rawQty ? absPaid - leg.rawQty : leg.rawQty - absPaid;
            if (diff > leg.rawQty / BigInt(500)) continue; // 0.2%

            const wethQty = Number(receivedAmt) / 1e18;
            synthetic.push({
              hash: candidate.hash,
              from: poolManager,
              to: wallet,
              tokenAddress: wethAddress,
              qty: wethQty,
              rawQty: receivedAmt,
              ts: leg.ts,
              blockNumber: leg.blockNumber,
            });
            console.log(
              `[edge:fetchTrades] ${chain} V4 sell hash=${candidate.hash.slice(0, 10)} sold=${leg.qty.toFixed(4)} ${leg.tokenAddress.slice(0, 10)} rcvd=${wethQty.toFixed(8)} WETH`
            );
            enriched = true;
            break;
          }
        } else {
          // direction === 'buy' (relay-buy: token arrived at wallet, WETH paid cross-chain)
          // Positive amount = token received by caller (bought). Negative = WETH paid.
          // Relay bridge takes a fee, so matching tolerance is widened to 1%.
          for (const [receivedAmt, paidAmt] of [
            [amount0, amount1],
            [amount1, amount0],
          ] as [bigint, bigint][]) {
            if (receivedAmt <= BigInt(0) || paidAmt >= BigInt(0)) continue;
            const diff =
              receivedAmt > leg.rawQty ? receivedAmt - leg.rawQty : leg.rawQty - receivedAmt;
            if (diff > leg.rawQty / BigInt(100)) continue; // 1% (relay fee headroom)

            const wethPaid = -paidAmt;
            const wethQty = Number(wethPaid) / 1e18;
            synthetic.push({
              hash: candidate.hash,
              from: wallet,
              to: poolManager,
              tokenAddress: wethAddress,
              qty: wethQty,
              rawQty: wethPaid,
              ts: leg.ts,
              blockNumber: leg.blockNumber,
            });
            console.log(
              `[edge:fetchTrades] ${chain} V4 relay-buy hash=${candidate.hash.slice(0, 10)} rcvd=${leg.qty.toFixed(4)} ${leg.tokenAddress.slice(0, 10)} paid=${wethQty.toFixed(8)} WETH`
            );
            enriched = true;
            break;
          }
        }
      }

      if (!enriched && swapLogs.length > 0) {
        console.log(
          `[edge:fetchTrades] ${chain} V4 ${candidate.direction} hash=${candidate.hash.slice(0, 10)} — ${swapLogs.length} Swap event(s) found but no amount matched (multi-hop or unsupported pool)`
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

  // For chains with a known Uniswap V4 PoolManager, inject synthetic legs for
  // trades where one side is invisible to Alchemy (HOOD Doppler sells; Base
  // relay-buys funded from Solana via cross-chain bridge).
  if (POOL_MANAGER_BY_CHAIN[chain]) {
    const enriched = await enrichUniswapV4Legs(chain, client, walletLower, transfers);
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
