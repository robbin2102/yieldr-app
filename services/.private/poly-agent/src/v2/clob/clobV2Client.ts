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

  private constructor(client: ClobClient) {
    this.client = client;
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

    // Warm up tick sizes — SDK needs them to round order params correctly.
    // This call fetches from API once; SDK caches internally.
    await client.getOk().catch(() => {});

    return new ClobV2Client(client);
  }

  // ── Market orders (FAK / FOK) ─────────────────────────────────────────────

  async postMarketOrder(params: MarketOrderParams): Promise<OrderResponse> {
    const { tokenId, side, amount, price, negRisk, orderType } = params;

    const tickSize = await this.resolveTickSize(tokenId);

    const response = await this.client.createAndPostMarketOrder(
      {
        tokenID:   tokenId,
        side:      side === 'BUY' ? Side.BUY : Side.SELL,
        amount,
        price,          // optional slippage guard
        orderType:  orderType === 'FAK' ? OrderType.FAK : OrderType.FOK,
      },
      { tickSize, negRisk },
    );

    return response as OrderResponse;
  }

  // ── GTD limit orders ──────────────────────────────────────────────────────

  async postGTDOrder(params: LimitOrderParams): Promise<OrderResponse> {
    const { tokenId, side, price, size, negRisk, expiresAt } = params;

    const tickSize = await this.resolveTickSize(tokenId);

    const response = await this.client.createAndPostOrder(
      {
        tokenID:    tokenId,
        side:       side === 'BUY' ? Side.BUY : Side.SELL,
        price,
        size,
        expiration: expiresAt,
      },
      { tickSize, negRisk },
      OrderType.GTD,
    );

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

  private async resolveTickSize(tokenId: string): Promise<TickSize> {
    try {
      const sizes = await this.client.tickSizes;
      const ts = (sizes as Record<string, TickSize>)[tokenId];
      return ts ?? '0.001';
    } catch {
      return '0.001';
    }
  }
}
