import { config } from '../config';

/**
 * PositionFetcher — fetches the BOT's own open positions.
 *
 * Used only by the SELL guard in gttExecutor to verify we actually hold
 * a position before copying a SELL order.
 *
 * Trader open position fetching (for ratio computation) is handled by
 * RatioScheduler which runs at startup and midnight — not per-trade.
 */
export class PositionFetcher {
  async getOurShares(tokenId: string): Promise<number> {
    try {
      const url = `${config.dataApiBase}/positions?user=${config.botWalletAddress}&sizeThreshold=0.01&limit=500`;
      const res = await fetch(url);
      if (!res.ok) return 0;
      const raw = await res.json() as any;
      const items: any[] = Array.isArray(raw) ? raw : (raw.data ?? []);
      const pos = items.find((p: any) =>
        p.asset === tokenId || p.tokenId === tokenId || p.assetId === tokenId
      );
      return pos ? parseFloat(pos.size ?? '0') : 0;
    } catch {
      return 0;
    }
  }
}

export const positionFetcher = new PositionFetcher();
