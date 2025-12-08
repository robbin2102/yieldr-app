/**
 * LP Metrics Computation
 */

import LPPosition from '@/models/LPPosition';
import LPPositionHistory from '@/models/LPPositionHistory';
import LPMetrics from '@/models/LPMetrics';

/**
 * Compute comprehensive LP metrics
 */
export async function computeMetrics(walletAddress: string) {
  const openPositions = await LPPosition.find({ walletAddress });
  const closedPositions = await LPPositionHistory.find({ walletAddress });

  // From DefiKrystal API (sum of all open positions)
  const totalLiquidity = openPositions.reduce((sum, p) => sum + p.liquidityValue, 0);
  const totalPnl = openPositions.reduce((sum, p) => sum + p.currentPnl, 0);
  const totalFeesEarned = openPositions.reduce((sum, p) => sum + p.feesEarned, 0);
  const totalIL = openPositions.reduce((sum, p) => sum + p.impermanentLoss, 0);
  const totalNetPnl = openPositions.reduce((sum, p) => sum + p.netPnl, 0);

  // Computed from closed positions
  const totalPositions = closedPositions.length + openPositions.length;

  const wins = closedPositions.filter(p => p.netPnl > 0);
  const losses = closedPositions.filter(p => p.netPnl < 0);

  const winRate = closedPositions.length > 0 ? wins.length / closedPositions.length : 0;

  const avgWin = wins.length > 0
    ? wins.reduce((sum, p) => sum + p.netPnl, 0) / wins.length
    : 0;

  const avgLoss = losses.length > 0
    ? losses.reduce((sum, p) => sum + p.netPnl, 0) / losses.length
    : 0;

  const bestPosition = wins.length > 0
    ? Math.max(...wins.map(p => p.netPnl))
    : 0;

  const worstPosition = losses.length > 0
    ? Math.min(...losses.map(p => p.netPnl))
    : 0;

  // Sharpe ratio (based on closed position ROIs)
  const returns = closedPositions.map(p => p.roi);
  const avgReturn = returns.length > 0
    ? returns.reduce((a, b) => a + b, 0) / returns.length
    : 0;
  const variance = returns.length > 0
    ? returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length
    : 0;
  const stdDev = Math.sqrt(variance);
  const sharpeRatio = stdDev > 0 ? avgReturn / stdDev : 0;

  const avgROI = closedPositions.length > 0
    ? closedPositions.reduce((sum, p) => sum + p.roi, 0) / closedPositions.length
    : 0;

  // Per-protocol breakdown (open positions)
  const protocolMap: Record<string, any> = {};
  openPositions.forEach(pos => {
    if (!protocolMap[pos.protocol]) {
      protocolMap[pos.protocol] = {
        liquidity: 0,
        pnl: 0,
        positions: 0
      };
    }
    protocolMap[pos.protocol].liquidity += pos.liquidityValue;
    protocolMap[pos.protocol].pnl += pos.currentPnl;
    protocolMap[pos.protocol].positions += 1;
  });

  const byProtocol = Object.entries(protocolMap).map(([protocol, data]: [string, any]) => ({
    protocol,
    liquidity: data.liquidity,
    pnl: data.pnl,
    positions: data.positions
  }));

  // Per-pair breakdown (closed positions)
  const pairMap: Record<string, any> = {};
  closedPositions.forEach(pos => {
    if (!pairMap[pos.pair]) {
      pairMap[pos.pair] = {
        positions: [],
        wins: [],
        losses: []
      };
    }
    pairMap[pos.pair].positions.push(pos);
    if (pos.netPnl > 0) {
      pairMap[pos.pair].wins.push(pos);
    } else if (pos.netPnl < 0) {
      pairMap[pos.pair].losses.push(pos);
    }
  });

  const byPair = Object.entries(pairMap).map(([pair, data]: [string, any]) => ({
    pair,
    positions: data.positions.length,
    winRate: data.positions.length > 0
      ? data.wins.length / data.positions.length
      : 0,
    bestWin: data.wins.length > 0
      ? Math.max(...data.wins.map((p: any) => p.netPnl))
      : 0,
    worstLoss: data.losses.length > 0
      ? Math.min(...data.losses.map((p: any) => p.netPnl))
      : 0,
    totalPnl: data.positions.reduce((sum: number, p: any) => sum + p.netPnl, 0)
  }));

  // Save metrics
  await LPMetrics.findOneAndUpdate(
    { walletAddress },
    {
      walletAddress,
      totalLiquidity,
      totalPnl,
      totalFeesEarned,
      totalIL,
      totalNetPnl,
      totalPositions,
      closedPositions: closedPositions.length,
      wins: wins.length,
      losses: losses.length,
      winRate,
      avgWin,
      avgLoss,
      bestPosition,
      worstPosition,
      sharpeRatio,
      avgROI,
      byProtocol,
      byPair,
      updatedAt: new Date()
    },
    { upsert: true, new: true }
  );

  console.log(`✓ LP Metrics computed for ${walletAddress}`);
}
