"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.calcCopyBet = calcCopyBet;
function calcCopyBet(traderBetUsdc, trader) {
    const { avgBet, baseBetUsdc, maxBetUsdc, allocationUsdc, spentUsdc } = trader;
    const available = allocationUsdc - spentUsdc;
    // 1. Allocation exhausted
    if (available <= 0) {
        return {
            betUsdc: 0, skip: true,
            skipReason: 'ALLOCATION_FULL',
            skipDetail: `allocation exhausted ($${spentUsdc.toFixed(2)} / $${allocationUsdc})`,
        };
    }
    // 2. Below avg — probe/noise bet, skip
    if (traderBetUsdc < avgBet) {
        return {
            betUsdc: 0, skip: true,
            skipReason: 'BELOW_AVG',
            skipDetail: `$${traderBetUsdc.toFixed(0)} < avg $${avgBet.toFixed(0)}`,
        };
    }
    // 3. Conviction-proportional scaling
    const ratio = traderBetUsdc / avgBet;
    const rawBet = baseBetUsdc * ratio;
    const bet = Math.min(maxBetUsdc, Math.max(baseBetUsdc, rawBet));
    // 4. Clamp to remaining allocation
    return { betUsdc: Math.min(bet, available), skip: false };
}
//# sourceMappingURL=betSizer.js.map