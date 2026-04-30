/**
 * ClobV2Client — wrapper around @polymarket/clob-client-v2.
 *
 * Handles:
 * - viem wallet creation from private key (SDK uses viem, not ethers)
 * - Market orders (FAK) via createAndPostMarketOrder
 * - GTD limit orders via createAndPostOrder with expiration
 * - Tick size resolution (required by SDK for order creation)
 * - negRisk flag per token (inferred from OnChainDetector exchange field)
 *
 * The SDK's `createAndPost*` helpers sign + submit in one call and return
 * OrderResponse: { success, errorMsg, orderID, transactionsHashes[], status,
 *                  takingAmount, makingAmount }
 *
 * status values: "live" | "matched" | "delayed" | "unmatched"
 *   - "matched" → immediate fill (FAK taker order hit resting liquidity)
 *   - "live"    → resting on book (GTD maker order)
 */

import {
  ClobClient,
  Chain,
  OrderType,
  Side,
  type OrderResponse,
  type TickSize,
} from '@polymarket/clob-client-v2';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ClobV2Config {
  host:        string;   // e.g. 'https://clob.polymarket.com'
  privateKey:  string;   // 0x-prefixed
  apiKey:      string;
  apiSecret:   string;
  passphrase:  string;
  polygonRpc:  string;
}

export interface MarketOrderParams {
  tokenId:   string;
  side:      'BUY' | 'SELL';
  amount:    number;        // BUY: USDC to spend; SELL: shares to sell
  price?:    number;        // slippage protection (worst acceptable price)
  negRisk:   boolean;
  orderType: 'FAK' | 'FOK';
}

export interface LimitOrderParams {
  tokenId:    string;
  side:       'BUY' | 'SELL';
  price:      number;       // limit price (0.0001 precision)
  size:       number;       // shares
  negRisk:    boolean;
  expiresAt:  number;       // unix seconds (for GTD)
}

export { type OrderResponse };

// ── ClobV2Client ──────────────────────────────────────────────────────────────

export class ClobV2Client {
  private client: ClobClient;
  private host:   string;

  private constructor(client: ClobClient, host: string) {
    this.client = client;
    this.host   = host;
  }

  static async create(cfg: ClobV2Config): Promise<ClobV2Client> {
    const account = privateKeyToAccount(cfg.privateKey as `0x${string}`);
    const walletClient = createWalletClient({
      account,
      chain:     polygon,
      transport: http(cfg.polygonRpc),
    });

    const client = new ClobClient({
      host:  cfg.host,
      chain: Chain.POLYGON,
      signer: walletClient as any,
      creds: {
        key:        cfg.apiKey,
        secret:     cfg.apiSecret,
        passphrase: cfg.passphrase,
      },
      throwOnError: false,
    });

    await client.getOk().catch(() => {});

    return new ClobV2Client(client, cfg.host);
  }

  // ── Market orders (FAK / FOK) ─────────────────────────────────────────────

  async postMarketOrder(params: MarketOrderParams): Promise<OrderResponse> {
    const { tokenId, side, amount, price, negRisk, orderType } = params;
    // CLOB SDK calls /markets-by-token/{tokenId} internally — must be decimal, not hex
    const tokenIdDec = tokenId.startsWith('0x') ? BigInt(tokenId).toString() : tokenId;

    console.log(`[ClobV2] postMarketOrder: ${side} tokenId=${tokenId.slice(0, 14)}... amount=${amount} price=${price} negRisk=${negRisk} type=${orderType}`);

    const tickSize = await this.resolveTickSize(tokenIdDec);
    console.log(`[ClobV2] tickSize=${tickSize}`);

    // orderType is the 3rd param to createAndPostMarketOrder, NOT inside the order object
    const orderPromise = this.client.createAndPostMarketOrder(
      {
        tokenID: tokenIdDec,
        side:    side === 'BUY' ? Side.BUY : Side.SELL,
        amount,
        price,
      },
      { tickSize, negRisk },
      orderType === 'FAK' ? OrderType.FAK : OrderType.FOK,
    );

    console.log(`[ClobV2] awaiting createAndPostMarketOrder...`);
    const response = await withTimeout(orderPromise, 20_000, 'createAndPostMarketOrder');

    // SDK with throwOnError:false returns the raw Axios error on 400 — pull the
    // CLOB error message out of response.data.error so callers can read it.
    const errDetail = (response as any).data?.error ?? (response as any).error ?? response.errorMsg;
    if (errDetail) (response as any).errorMsg = errDetail;

    console.log(`[ClobV2] response: success=${(response as any).success} orderId=${(response as any).orderID?.slice(0, 10)}... status=${(response as any).status ?? (response as any).data?.status} errorMsg=${errDetail ?? 'none'}`);

    return response as OrderResponse;
  }

  // ── GTD limit orders ──────────────────────────────────────────────────────

  async postGTDOrder(params: LimitOrderParams): Promise<OrderResponse> {
    const { tokenId, side, price, size, negRisk, expiresAt } = params;
    // CLOB SDK calls /markets-by-token/{tokenId} internally — must be decimal, not hex
    const tokenIdDec = tokenId.startsWith('0x') ? BigInt(tokenId).toString() : tokenId;

    console.log(`[ClobV2] postGTDOrder: ${side} tokenId=${tokenId.slice(0, 14)}... price=${price} size=${size} negRisk=${negRisk}`);

    const tickSize = await this.resolveTickSize(tokenIdDec);
    console.log(`[ClobV2] tickSize=${tickSize}`);

    const orderPromise = this.client.createAndPostOrder(
      {
        tokenID:    tokenIdDec,
        side:       side === 'BUY' ? Side.BUY : Side.SELL,
        price,
        size,
        expiration: expiresAt,
      },
      { tickSize, negRisk },
      OrderType.GTD,
    );

    console.log(`[ClobV2] awaiting createAndPostOrder...`);
    const response = await withTimeout(orderPromise, 20_000, 'createAndPostOrder');

    const errDetail = (response as any).data?.error ?? (response as any).error ?? response.errorMsg;
    if (errDetail) (response as any).errorMsg = errDetail;

    console.log(`[ClobV2] response: success=${(response as any).success} orderId=${(response as any).orderID?.slice(0, 10)}... status=${(response as any).status ?? (response as any).data?.status} errorMsg=${errDetail ?? 'none'}`);

    return response as OrderResponse;
  }

  // ── Diagnostics ────────────────────────────────────────────────────────────

  async ping(): Promise<boolean> {
    try {
      await this.client.getOk();
      return true;
    } catch { return false; }
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private async resolveTickSize(tokenIdDec: string): Promise<TickSize> {
    // 1. Try SDK's cached tick size map (keyed by decimal tokenId)
    try {
      const sizes = await withTimeout(
        Promise.resolve(this.client.tickSizes),
        3_000,
        'tickSizes-cache',
      ) as Record<string, TickSize>;
      if (sizes[tokenIdDec]) return sizes[tokenIdDec];
    } catch {}

    // 2. Direct lookup via /markets-by-token (same endpoint SDK uses internally)
    try {
      const res = await fetch(`${this.host}/markets-by-token/${tokenIdDec}`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (res.ok) {
        const data = await res.json() as any;
        const minTick = data?.minimum_tick_size ?? data?.min_tick_size;
        if (minTick) return String(minTick) as TickSize;
      }
    } catch {}

    // 3. Safe fallback — 0.01 is the more common minimum; 0.001 is only for high-volume markets
    return '0.01';
  }
}

// Wraps a Promise with a hard timeout that rejects if the call doesn't complete in time.
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`[ClobV2] ${label} timed out after ${ms}ms`)), ms);
    p.then(v  => { clearTimeout(timer); resolve(v); },
           e  => { clearTimeout(timer); reject(e);  });
  });
}
