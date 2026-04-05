"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.positionFetcher = exports.PositionFetcher = void 0;
const config_1 = require("../config");
/**
 * PositionFetcher — fetches the BOT's own open positions.
 *
 * Used only by the SELL guard in gttExecutor to verify we actually hold
 * a position before copying a SELL order.
 *
 * Trader open position fetching (for ratio computation) is handled by
 * RatioScheduler which runs at startup and midnight — not per-trade.
 */
class PositionFetcher {
    async getOurShares(tokenId) {
        try {
            const url = `${config_1.config.dataApiBase}/positions?user=${config_1.config.botWalletAddress}&sizeThreshold=0.01&limit=500`;
            const res = await fetch(url);
            if (!res.ok)
                return 0;
            const raw = await res.json();
            const items = Array.isArray(raw) ? raw : (raw.data ?? []);
            const pos = items.find((p) => p.asset === tokenId || p.tokenId === tokenId || p.assetId === tokenId);
            return pos ? parseFloat(pos.size ?? '0') : 0;
        }
        catch {
            return 0;
        }
    }
}
exports.PositionFetcher = PositionFetcher;
exports.positionFetcher = new PositionFetcher();
//# sourceMappingURL=positionFetcher.js.map