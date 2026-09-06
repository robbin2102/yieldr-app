import { getPublicClient, CHAINS, ChainNotSupportedError, effectiveLookbackDays, type EdgeChainId } from './chains';
import { resolveBlockRangeForWindow } from './blockRange';
import { getReferenceToken, hasReferenceTokens, REFERENCE_TOKENS, NATIVE_PSEUDO_ADDRESS } from './referenceTokens';
import { getReferencePriceUsd, recordObservedTradePrice } from './priceService';
import { scanTransfersViaLogs, getDecimals, getBlockTimestamp } from './logScanFallback';
import { getCachedReceipts, cacheReceipts } from './receiptCache';
import { withRateLimitRetry } from './rpcRetry';
import type { TradeLeg } from './types';

export interface NormalizedTransfer {
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
export const POOL_MANAGER_BY_CHAIN: Partial<Record<EdgeChainId, string>> = {
  hood: '0x8366a39cc670b4001a1121b8f6a443a643e40951', // Doppler DEX on Robinhood Chain
  base: '0x498581ff718922c3f8e6a244956af099b2652b2b', // Uniswap V4 on Base
};
const SWAP_TOPIC    = '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f'; // Uniswap V4
const V2_SWAP_TOPIC = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822'; // Uniswap V2 / Virtuals FPair
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// Virtuals Protocol bonding curve entry point on Base.
// FFactory and FRouter are public vars on Bonding — fetch via:
//   cast call 0x1A540088125d00dD3990f9dA45CA0859af4d3B01 "factory()(address)" --rpc-url https://mainnet.base.org
//   cast call 0x1A540088125d00dD3990f9dA45CA0859af4d3B01 "router()(address)"  --rpc-url https://mainnet.base.org
// (BaseScan readContract tab also works — no wallet required)
const VIRTUALS_BONDING_BASE = '0x1a540088125d00dd3990f9da45ca0859af4d3b01';

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
 * Scan the receipt's ERC20 Transfer events to find the actual reference token
 * that was received/paid in a V4 swap. Preferred over hardcoding WETH because
 * V4 pools can be TOKEN/VIRTUAL, TOKEN/CBBTC, etc.
 *
 * Looks for a Transfer log where:
 *   - The token address is NOT the known trade token (excludeToken)
 *   - The transferred amount is within maxToleranceBps of expectedRawQty
 * Returns the best (closest) match, or null if nothing qualifies.
 */
function findReferenceTokenTransfer(
  receipt: any,
  excludeToken: string,
  expectedRawQty: bigint,
  maxToleranceBps = 200
): { tokenAddress: string; rawQty: bigint } | null {
  if (!receipt?.logs) return null;
  const exclude = excludeToken.toLowerCase();
  let best: { tokenAddress: string; rawQty: bigint; diff: bigint } | null = null;

  for (const log of receipt.logs) {
    if (log.topics?.[0] !== TRANSFER_TOPIC) continue;

    // ERC721 Transfer(address indexed from, address indexed to, uint256 indexed tokenId)
    // hashes to the SAME topic0 as ERC20 Transfer(address,address,uint256) - the event
    // signature string is identical, indexing doesn't change the hash. ERC721's tokenId
    // is indexed (3 indexed args -> 4 topics total incl. topic0), so its data is empty
    // ('0x') instead of holding a value - that's what was crashing BigInt(log.data)
    // below. A standard ERC20 Transfer always has exactly 3 topics (topic0, from, to).
    if (log.topics.length !== 3) {
      console.log(
        `[edge:fetchTrades] skipping non-ERC20 Transfer-topic log (topics=${log.topics?.length}, likely an NFT transfer) at ${log.address}`
      );
      continue;
    }

    const tokenAddr = log.address?.toLowerCase();
    if (!tokenAddr || tokenAddr === exclude) continue;

    if (!log.data || log.data === '0x') {
      console.log(`[edge:fetchTrades] skipping Transfer log with empty data at ${log.address} (tx has non-standard logs)`);
      continue;
    }

    let amt: bigint;
    try {
      amt = BigInt(log.data);
    } catch (err) {
      console.log(`[edge:fetchTrades] failed to parse Transfer log data "${log.data}" at ${log.address}:`, err);
      continue;
    }
    if (amt <= BigInt(0)) continue;
    const diff = amt > expectedRawQty ? amt - expectedRawQty : expectedRawQty - amt;
    if (diff > (expectedRawQty * BigInt(maxToleranceBps)) / BigInt(10000)) continue;
    if (!best || diff < best.diff) {
      best = { tokenAddress: tokenAddr, rawQty: amt, diff };
    }
  }

  return best ? { tokenAddress: best.tokenAddress, rawQty: best.rawQty } : null;
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
export type CandidateDirection = 'sell' | 'buy';
export interface SwapCandidate {
  hash: string;
  direction: CandidateDirection;
  leg: NormalizedTransfer;
}

/**
 * STAGE: classify. Groups transfers by tx hash and picks out the
 * unbalanced ones (1-out-0-in or 0-out-1-in) - these are the sell/relay-buy
 * candidates that need Swap-log enrichment because one side of the trade
 * never touched the wallet as a plain transfer. Pure/sync - no IO, so it's
 * cheap to test in isolation.
 */
export function classifySwapCandidates(walletLower: string, transfers: NormalizedTransfer[]): SwapCandidate[] {
  const byHash = new Map<string, { out: NormalizedTransfer[]; in: NormalizedTransfer[] }>();
  for (const t of transfers) {
    const g = byHash.get(t.hash) ?? { out: [], in: [] };
    if (t.from === walletLower) g.out.push(t);
    if (t.to === walletLower) g.in.push(t);
    byHash.set(t.hash, g);
  }

  const candidates: SwapCandidate[] = [];
  for (const [hash, g] of byHash) {
    if (g.out.length === 1 && g.in.length === 0) {
      candidates.push({ hash, direction: 'sell', leg: g.out[0] });
    } else if (g.out.length === 0 && g.in.length === 1) {
      candidates.push({ hash, direction: 'buy', leg: g.in[0] });
    }
  }
  return candidates;
}

export interface ReceiptFetchResult {
  receiptsByHash: Map<string, { logs: any[] }>;
  cacheHits: number;
  newlyFetchedCount: number;
  failedCount: number;
  elapsedMs: number;
}

/**
 * STAGE: receipt fetch. Bulk-checks the persistent cache first (receipts
 * are immutable once mined), then fetches whatever's missing in
 * concurrency-capped batches with rate-limit backoff+jitter, then caches
 * the new ones. This is normally the slowest/most expensive stage on a
 * wallet with thousands of unbalanced trades - isolated here so it can be
 * timed and diagnosed on its own.
 */
export async function fetchReceiptsForHashes(
  chain: EdgeChainId,
  client: any,
  hashes: string[]
): Promise<ReceiptFetchResult> {
  const startedAt = Date.now();
  const receiptsByHash = await getCachedReceipts(chain, hashes);
  const cacheHits = receiptsByHash.size;
  const toFetch = hashes.filter((h) => !receiptsByHash.has(h.toLowerCase()));

  // Sustained 429s throughout an entire run (not just an initial burst) is
  // evidence the app's actual sustained throughput is below a high batch
  // size - every retry wastes 2s+ doing nothing, so a lower, steadier
  // concurrency finishes faster in practice than a higher one that mostly
  // gets rejected.
  const BATCH = Number(process.env.EDGE_RECEIPT_FETCH_BATCH) || 8;
  const PROGRESS_EVERY = 500;
  const newlyFetched: { hash: string; logs: any[] }[] = [];
  let failedCount = 0;

  for (let i = 0; i < toFetch.length; i += BATCH) {
    const batch = toFetch.slice(i, i + BATCH);
    const receipts = await Promise.all(
      batch.map((hash) =>
        withRateLimitRetry(() => client.request({ method: 'eth_getTransactionReceipt', params: [hash] }), {
          label: `${chain} eth_getTransactionReceipt`,
        }).catch(() => null)
      )
    );

    if (i > 0 && i % PROGRESS_EVERY < BATCH) {
      const pct = ((i / toFetch.length) * 100).toFixed(0);
      const elapsedS = ((Date.now() - startedAt) / 1000).toFixed(0);
      const ratePerS = i / Math.max(1, (Date.now() - startedAt) / 1000);
      const etaS = ratePerS > 0 ? Math.round((toFetch.length - i) / ratePerS) : null;
      console.log(
        `[edge:fetchTrades] ${chain} receipt fetch progress: ${i}/${toFetch.length} (${pct}%), elapsed=${elapsedS}s${etaS !== null ? `, eta=${etaS}s` : ''}`
      );
    }

    batch.forEach((hash, j) => {
      const r: any = receipts[j];
      if (!r) {
        failedCount++;
        return;
      }
      const logs = r.logs ?? [];
      receiptsByHash.set(hash.toLowerCase(), { logs });
      newlyFetched.push({ hash, logs });
    });
  }

  await cacheReceipts(chain, newlyFetched);

  return {
    receiptsByHash,
    cacheHits,
    newlyFetchedCount: newlyFetched.length,
    failedCount,
    elapsedMs: Date.now() - startedAt,
  };
}

export interface ParseSwapResult {
  enriched: boolean;
  /** Total Swap-shaped events seen (V4 at PoolManager + V2/Virtuals) - 0 means the receipt had nothing swap-shaped at all. */
  totalSwapsSeen: number;
  /** How close the nearest failed match was, in basis points of the expected amount. Large = likely multi-hop; small = tolerance too tight. */
  closestDiffBps: number | null;
  syntheticLeg: NormalizedTransfer | null;
  matchLabel: string | null;
}

/**
 * STAGE: parse. Given one candidate and its receipt's logs, tries to find
 * the matching V4 Swap event (or, on Base, a Virtuals-style V2 Swap) and
 * the actual reference token moved alongside it. Pure given its inputs
 * (only IO is getDecimals, which is itself cached) - the core "does this
 * receipt actually decode into a trade" logic, isolated so it can be
 * tested against one specific receipt without re-fetching anything.
 */
export async function parseSwapFromReceipt(opts: {
  chain: EdgeChainId;
  client: any;
  poolManager: string;
  wethAddress: string | null;
  wallet: string;
  candidate: SwapCandidate;
  receipt: { logs: any[] };
}): Promise<ParseSwapResult> {
  const { chain, client, poolManager, wethAddress, wallet, candidate, receipt } = opts;

  const swapLogs = (receipt.logs ?? []).filter(
    (log: any) => log.address?.toLowerCase() === poolManager && log.topics?.[0] === SWAP_TOPIC
  );

  let closestDiffBps: number | null = null;
  const trackClosest = (diff: bigint, expected: bigint) => {
    if (expected <= BigInt(0)) return;
    const bps = Number((diff * BigInt(10000)) / expected);
    if (closestDiffBps === null || bps < closestDiffBps) closestDiffBps = bps;
  };

  let enriched = false;
  let syntheticLeg: NormalizedTransfer | null = null;
  let matchLabel: string | null = null;

  for (const swapLog of swapLogs) {
    if (enriched) break;
    const data = (swapLog.data as string).slice(2);
    const amount0 = abiSignedInt('0x' + data.slice(0, 64));
    const amount1 = abiSignedInt('0x' + data.slice(64, 128));

    const { direction, leg } = candidate;
    if (leg.rawQty === BigInt(0)) continue;

    if (direction === 'sell') {
      // Negative amount = token paid to pool (sold). Positive = reference token received.
      // Try both amount0/amount1 orderings.
      for (const [paidAmt, receivedAmt] of [
        [amount0, amount1],
        [amount1, amount0],
      ] as [bigint, bigint][]) {
        if (paidAmt >= BigInt(0) || receivedAmt <= BigInt(0)) continue;
        const absPaid = -paidAmt;
        const diff = absPaid > leg.rawQty ? absPaid - leg.rawQty : leg.rawQty - absPaid;
        trackClosest(diff, leg.rawQty);
        if (diff > leg.rawQty / BigInt(500)) continue; // 0.2%

        // Detect actual reference token from ERC20 Transfer events (handles
        // TOKEN/VIRTUAL, TOKEN/CBBTC etc. — not just TOKEN/WETH pools).
        const found = findReferenceTokenTransfer(receipt, leg.tokenAddress, receivedAmt);
        const refAddr = found?.tokenAddress ?? wethAddress;
        if (!refAddr) break; // no reference token detectable — skip

        const refRawQty = found?.rawQty ?? receivedAmt;
        const refDecimals = await getDecimals(client, refAddr as `0x${string}`);
        const refQty = Number(refRawQty) / 10 ** refDecimals;

        syntheticLeg = {
          hash: candidate.hash,
          from: poolManager,
          to: wallet,
          tokenAddress: refAddr,
          qty: refQty,
          rawQty: refRawQty,
          ts: leg.ts,
          blockNumber: leg.blockNumber,
        };
        matchLabel = `V4 sell sold=${leg.qty.toFixed(4)} ${leg.tokenAddress.slice(0, 10)} rcvd=${refQty.toFixed(8)} ${found ? refAddr.slice(0, 10) : 'WETH(fallback)'}`;
        enriched = true;
        break;
      }
    } else {
      // direction === 'buy' (relay-buy: token arrived at wallet, reference token paid cross-chain)
      // Positive amount = token received by caller (bought). Negative = reference token paid.
      // Relay bridge takes a fee, so matching tolerance is widened to 1%.
      for (const [receivedAmt, paidAmt] of [
        [amount0, amount1],
        [amount1, amount0],
      ] as [bigint, bigint][]) {
        if (receivedAmt <= BigInt(0) || paidAmt >= BigInt(0)) continue;
        const diff = receivedAmt > leg.rawQty ? receivedAmt - leg.rawQty : leg.rawQty - receivedAmt;
        trackClosest(diff, leg.rawQty);
        if (diff > leg.rawQty / BigInt(100)) continue; // 1% (relay fee headroom)

        const refPaidRaw = -paidAmt;
        const found = findReferenceTokenTransfer(receipt, leg.tokenAddress, refPaidRaw);
        const refAddr = found?.tokenAddress ?? wethAddress;
        if (!refAddr) break; // no reference token detectable — skip

        const refRawQty = found?.rawQty ?? refPaidRaw;
        const refDecimals = await getDecimals(client, refAddr as `0x${string}`);
        const refQty = Number(refRawQty) / 10 ** refDecimals;

        syntheticLeg = {
          hash: candidate.hash,
          from: wallet,
          to: poolManager,
          tokenAddress: refAddr,
          qty: refQty,
          rawQty: refRawQty,
          ts: leg.ts,
          blockNumber: leg.blockNumber,
        };
        matchLabel = `V4 relay-buy rcvd=${leg.qty.toFixed(4)} ${leg.tokenAddress.slice(0, 10)} paid=${refQty.toFixed(8)} ${found ? refAddr.slice(0, 10) : 'WETH(fallback)'}`;
        enriched = true;
        break;
      }
    }
  }

  // ── Fallback: Virtuals Protocol FPair (Uniswap V2-style) ────────────
  // Virtuals FPair is a V2 clone where token0 = VIRTUAL, token1 = agent
  // token. The relay bridge may buy/sell the agent token via FPair without
  // touching the Uniswap V4 PoolManager, so the V4 Swap check above finds
  // nothing. Detect via the V2 Swap event on any contract in the receipt.
  if (!enriched && chain === 'base') {
    const v2Logs = (receipt.logs ?? []).filter((log: any) => log.topics?.[0] === V2_SWAP_TOPIC);

    for (const v2Log of v2Logs) {
      if (enriched) break;
      const d = (v2Log.data as string).slice(2);
      const a0In = BigInt('0x' + d.slice(0, 64));
      const a1In = BigInt('0x' + d.slice(64, 128));
      const a0Out = BigInt('0x' + d.slice(128, 192));
      const a1Out = BigInt('0x' + d.slice(192, 256));

      const { direction, leg } = candidate;
      if (leg.rawQty === BigInt(0)) continue;

      if (direction === 'sell') {
        for (const [soldAmt, rcvdAmt] of [
          [a0In, a0Out],
          [a0In, a1Out],
          [a1In, a0Out],
          [a1In, a1Out],
        ] as [bigint, bigint][]) {
          if (soldAmt === BigInt(0) || rcvdAmt === BigInt(0)) continue;
          const diff = soldAmt > leg.rawQty ? soldAmt - leg.rawQty : leg.rawQty - soldAmt;
          if (diff > leg.rawQty / BigInt(500)) continue; // 0.2%

          const found = findReferenceTokenTransfer(receipt, leg.tokenAddress, rcvdAmt);
          const refAddr = found?.tokenAddress ?? wethAddress;
          if (!refAddr) break;
          const refRawQty = found?.rawQty ?? rcvdAmt;
          const refDecimals = await getDecimals(client, refAddr as `0x${string}`);
          const refQty = Number(refRawQty) / 10 ** refDecimals;

          syntheticLeg = { hash: candidate.hash, from: poolManager, to: wallet, tokenAddress: refAddr, qty: refQty, rawQty: refRawQty, ts: leg.ts, blockNumber: leg.blockNumber };
          matchLabel = `V2/Virtuals sell sold=${leg.qty.toFixed(4)} rcvd=${refQty.toFixed(8)} ${refAddr.slice(0, 10)}`;
          enriched = true;
          break;
        }
      } else {
        // relay-buy: agent token received; VIRTUAL was paid cross-chain
        // V2 Swap: amount_X_Out = agent token out (FPair → relay → wallet)
        // Relay takes ~1% fee so wallet receives slightly less than FPair outputs.
        for (const [boughtAmt, paidAmt] of [
          [a0Out, a0In],
          [a0Out, a1In],
          [a1Out, a0In],
          [a1Out, a1In],
        ] as [bigint, bigint][]) {
          if (boughtAmt === BigInt(0) || paidAmt === BigInt(0)) continue;
          const diff = boughtAmt > leg.rawQty ? boughtAmt - leg.rawQty : leg.rawQty - boughtAmt;
          if (diff > (leg.rawQty * BigInt(150)) / BigInt(10000)) continue; // 1.5%

          const found = findReferenceTokenTransfer(receipt, leg.tokenAddress, paidAmt);
          const refAddr = found?.tokenAddress ?? wethAddress;
          if (!refAddr) break;
          const refRawQty = found?.rawQty ?? paidAmt;
          const refDecimals = await getDecimals(client, refAddr as `0x${string}`);
          const refQty = Number(refRawQty) / 10 ** refDecimals;

          syntheticLeg = { hash: candidate.hash, from: wallet, to: poolManager, tokenAddress: refAddr, qty: refQty, rawQty: refRawQty, ts: leg.ts, blockNumber: leg.blockNumber };
          matchLabel = `V2/Virtuals relay-buy rcvd=${leg.qty.toFixed(4)} paid=${refQty.toFixed(8)} ${refAddr.slice(0, 10)}`;
          enriched = true;
          break;
        }
      }
    }
  }

  const totalSwapsSeen = swapLogs.length + (receipt.logs ?? []).filter((l: any) => l.topics?.[0] === V2_SWAP_TOPIC).length;
  return { enriched, totalSwapsSeen, closestDiffBps, syntheticLeg, matchLabel };
}

/** Orchestrates classify -> fetch receipts -> parse for the full wallet-legs pipeline. See fetchTrades.ts stage functions above for the pieces this calls. */
async function enrichUniswapV4Legs(
  chain: EdgeChainId,
  client: any,
  wallet: string,
  transfers: NormalizedTransfer[]
): Promise<NormalizedTransfer[]> {
  const poolManagerOrNull = POOL_MANAGER_BY_CHAIN[chain];
  if (!poolManagerOrNull) return [];
  const poolManager: string = poolManagerOrNull;
  const wethAddress = REFERENCE_TOKENS[chain]?.find((t) => t.symbol === 'WETH')?.address ?? null;

  const allCandidates = classifySwapCandidates(wallet, transfers);
  if (allCandidates.length === 0) return [];

  // A candidate whose OWN leg token is already a reference token (USDC,
  // WETH, ...) moving with nothing coming back the other way is not a
  // meme-token trade at all - findReferenceTokenTransfer explicitly
  // excludes the candidate's own token from matching, so a reference-token
  // outflow/inflow was ALWAYS going to find zero swap data, no matter how
  // the receipt is fetched. Confirmed on a real example: a Base "sell
  // candidate" that was just a USDC Approval+Transfer to a paymaster inside
  // an ERC-4337 UserOperation (BeforeExecution/UserOperationEvent at the
  // EntryPoint, 0x4337084d...) - a gas payment, not a trade. Skipping these
  // before the receipt fetch saves the RPC cost entirely and stops
  // reporting them as failed trade decodes when they were never trades.
  const referenceTokenAddrs = new Set((REFERENCE_TOKENS[chain] ?? []).map((t) => t.address.toLowerCase()));
  const candidates = allCandidates.filter((c) => !referenceTokenAddrs.has(c.leg.tokenAddress.toLowerCase()));
  const skippedRefOnly = allCandidates.length - candidates.length;
  if (skippedRefOnly > 0) {
    console.log(
      `[edge:fetchTrades] ${chain} skipping ${skippedRefOnly} candidate(s) where the wallet's own leg is itself a reference token (USDC/WETH/...) with nothing matching on the other side - almost certainly gas/fee/funding outflows, not trades`
    );
  }
  if (candidates.length === 0) return [];

  console.log(
    `[edge:fetchTrades] ${chain} enriching ${candidates.length} Uniswap V4 trade(s) (${
      candidates.filter((c) => c.direction === 'sell').length
    } sell, ${candidates.filter((c) => c.direction === 'buy').length} relay-buy)`
  );

  const { receiptsByHash, cacheHits, newlyFetchedCount } = await fetchReceiptsForHashes(
    chain,
    client,
    candidates.map((c) => c.hash)
  );
  console.log(
    `[edge:fetchTrades] ${chain} receipt cache: ${cacheHits}/${candidates.length} hit, ${newlyFetchedCount} newly fetched`
  );

  const synthetic: NormalizedTransfer[] = [];
  let matchedCount = 0;
  let amountMismatchCount = 0; // found swap data but amounts never matched tolerance (likely multi-hop)
  let zeroDataCount = 0; // no relevant log found in the receipt at all
  let zeroDataDiagnosticsLogged = 0;
  const MAX_ZERO_DATA_DIAGNOSTICS = 5; // don't spam - a handful of real examples is enough to root-cause

  for (const candidate of candidates) {
    const receipt = receiptsByHash.get(candidate.hash.toLowerCase());
    if (!receipt) {
      zeroDataCount++;
      if (zeroDataDiagnosticsLogged < MAX_ZERO_DATA_DIAGNOSTICS) {
        zeroDataDiagnosticsLogged++;
        console.log(`[edge:fetchTrades] ${chain} hash=${candidate.hash.slice(0, 10)} — receipt fetch FAILED entirely (not even null-logs; likely rate-limited past all retries)`);
      }
      continue;
    }
    const { enriched, totalSwapsSeen, closestDiffBps, syntheticLeg, matchLabel } = await parseSwapFromReceipt({
      chain,
      client,
      poolManager,
      wethAddress,
      wallet,
      candidate,
      receipt,
    });
    if (enriched && syntheticLeg) {
      synthetic.push(syntheticLeg);
      matchedCount++;
      console.log(`[edge:fetchTrades] ${chain} ${matchLabel} hash=${candidate.hash.slice(0, 10)}`);
    } else if (totalSwapsSeen > 0) {
      amountMismatchCount++;
      console.log(
        `[edge:fetchTrades] ${chain} ${candidate.direction} hash=${candidate.hash.slice(0, 10)} — ${totalSwapsSeen} Swap event(s) found but no amount matched (closest was ${closestDiffBps !== null ? (closestDiffBps / 100).toFixed(2) + '%' : 'n/a'} off - large = likely multi-hop, small = tolerance too tight)`
      );
    } else {
      zeroDataCount++;
      if (zeroDataDiagnosticsLogged < MAX_ZERO_DATA_DIAGNOSTICS) {
        zeroDataDiagnosticsLogged++;
        const allLogs: any[] = receipt.logs ?? [];
        const seen = new Set<string>();
        const pairs: string[] = [];
        for (const l of allLogs) {
          const key = `${l.address?.toLowerCase()}|${l.topics?.[0]}`;
          if (seen.has(key)) continue;
          seen.add(key);
          pairs.push(`${l.address?.slice(0, 10)}…:${l.topics?.[0]?.slice(0, 10)}…`);
        }
        console.log(
          `[edge:fetchTrades] ${chain} ${candidate.direction} hash=${candidate.hash} — ZERO DATA: receipt has ${allLogs.length} total log(s), expected poolManager=${poolManager.slice(0, 10)}… swapTopic=${SWAP_TOPIC.slice(0, 10)}…. Distinct (address:topic0) pairs present: ${pairs.length === 0 ? '(none - receipt.logs is empty)' : pairs.slice(0, 10).join(', ')}`
        );
      }
    }
  }

  const capturePct = candidates.length > 0 ? ((matchedCount / candidates.length) * 100).toFixed(1) : '0.0';
  console.log(
    `[edge:fetchTrades] ${chain} CAPTURE RATE: ${matchedCount}/${candidates.length} (${capturePct}%) matched — ${amountMismatchCount} amount-mismatch (likely multi-hop), ${zeroDataCount} zero relevant log data found`
  );

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
export async function fetchViaAlchemyEnhancedApi(
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

      const res: any = await withRateLimitRetry(
        () => (client as any).request({ method: 'alchemy_getAssetTransfers', params: [params] }),
        { label: `${chain} alchemy_getAssetTransfers dir=${direction}` }
      );

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

      const refPriceUsd = await getReferencePriceUsd(chain, refToken.symbol, refLeg.ts, refToken.address);
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
