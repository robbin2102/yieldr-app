/**
 * Change Detector Service
 *
 * Compares current positions with previous snapshot to detect:
 * - New positions (opened)
 * - Closed positions (no longer present)
 * - Modified positions (size, PnL, price changes)
 */

interface Position {
  positionId: string;
  asset: string;
  platform: string;
  type: string;
  [key: string]: any;
}

interface PositionChange {
  type: 'new' | 'closed' | 'modified';
  positionId: string;
  position?: Position;
  previous?: Position;
  current?: Position;
  changes?: {
    field: string;
    oldValue: any;
    newValue: any;
  }[];
}

interface ChangeDetectionResult {
  hasChanges: boolean;
  newPositions: Position[];
  closedPositions: Position[];
  modifiedPositions: {
    position: Position;
    changes: any[];
  }[];
  summary: {
    new: number;
    closed: number;
    modified: number;
  };
}

/**
 * Compares two snapshots and detects position changes
 */
export function detectPositionChanges(
  previousPositions: Position[],
  currentPositions: Position[]
): ChangeDetectionResult {
  // Create maps for efficient lookup
  const prevMap = new Map<string, Position>();
  const currMap = new Map<string, Position>();

  previousPositions.forEach(pos => prevMap.set(pos.positionId, pos));
  currentPositions.forEach(pos => currMap.set(pos.positionId, pos));

  // Detect new positions
  const newPositions: Position[] = [];
  for (const [id, pos] of currMap) {
    if (!prevMap.has(id)) {
      newPositions.push(pos);
    }
  }

  // Detect closed positions
  const closedPositions: Position[] = [];
  for (const [id, pos] of prevMap) {
    if (!currMap.has(id)) {
      closedPositions.push(pos);
    }
  }

  // Detect modified positions
  const modifiedPositions: { position: Position; changes: any[] }[] = [];
  for (const [id, currPos] of currMap) {
    const prevPos = prevMap.get(id);
    if (prevPos) {
      const changes = detectFieldChanges(prevPos, currPos);
      if (changes.length > 0) {
        modifiedPositions.push({
          position: currPos,
          changes,
        });
      }
    }
  }

  const hasChanges =
    newPositions.length > 0 ||
    closedPositions.length > 0 ||
    modifiedPositions.length > 0;

  return {
    hasChanges,
    newPositions,
    closedPositions,
    modifiedPositions,
    summary: {
      new: newPositions.length,
      closed: closedPositions.length,
      modified: modifiedPositions.length,
    },
  };
}

/**
 * Detects which fields changed between two position objects
 */
function detectFieldChanges(
  previous: Position,
  current: Position
): Array<{ field: string; oldValue: any; newValue: any }> {
  const changes: Array<{ field: string; oldValue: any; newValue: any }> = [];

  // Fields to monitor for changes
  const fieldsToCheck = [
    'positionSize',
    'margin',
    'currentPrice',
    'pnl',
    'roi',
    'leverage',
    'status',
    'liquidationPrice',
    'liquidity', // LP
    'unclaimedFees', // LP
  ];

  for (const field of fieldsToCheck) {
    if (field in previous && field in current) {
      const oldValue = previous[field];
      const newValue = current[field];

      // Check if value changed significantly
      if (isSignificantChange(field, oldValue, newValue)) {
        changes.push({
          field,
          oldValue,
          newValue,
        });
      }
    }
  }

  return changes;
}

/**
 * Determines if a field change is significant enough to log
 */
function isSignificantChange(
  field: string,
  oldValue: any,
  newValue: any
): boolean {
  // Handle null/undefined
  if (oldValue == null || newValue == null) {
    return oldValue !== newValue;
  }

  // String fields (status, etc.)
  if (typeof oldValue === 'string' || typeof newValue === 'string') {
    return oldValue !== newValue;
  }

  // Numeric fields - check if change is > 0.1%
  if (typeof oldValue === 'number' && typeof newValue === 'number') {
    // For PnL and ROI, any change is significant
    if (field === 'pnl' || field === 'roi') {
      return Math.abs(newValue - oldValue) > 0.01;
    }

    // For prices and sizes, need >0.1% change
    if (oldValue === 0) return newValue !== 0;

    const percentChange = Math.abs((newValue - oldValue) / oldValue);
    return percentChange > 0.001; // 0.1% threshold
  }

  return false;
}

/**
 * Enriches closed positions with additional metadata before logging
 */
export function enrichClosedPosition(position: Position, closedAt: Date): any {
  const holdDuration = position.openedAt
    ? Math.floor((closedAt.getTime() - new Date(position.openedAt).getTime()) / 1000)
    : null;

  return {
    positionId: position.positionId,
    walletAddress: position.walletAddress,
    platform: position.platform,
    asset: position.asset,
    pair: position.pair,
    type: position.type,

    // PERP-specific
    direction: position.direction,
    leverage: position.leverage,
    entryPrice: position.entryPrice,
    exitPrice: position.currentPrice, // Current price at close
    liquidationPrice: position.liquidationPrice,

    // LP-specific
    token0: position.token0,
    token1: position.token1,
    liquidity: position.liquidity,

    // Position sizing
    positionSize: position.positionSize,
    margin: position.margin,

    // Performance
    pnl: position.pnl || 0,
    roi: position.roi || 0,
    pnlPercentage: position.positionSize
      ? ((position.pnl || 0) / position.positionSize) * 100
      : 0,

    // Timing
    openedAt: position.openedAt ? new Date(position.openedAt) : null,
    closedAt,
    holdDuration,

    // Exit reason detection
    exitReason: detectExitReason(position),

    // Metadata
    detectedAt: new Date(),
  };
}

/**
 * Attempts to detect why a position was closed
 */
function detectExitReason(position: Position): string {
  // Check if liquidated (price near liquidation)
  if (
    position.liquidationPrice &&
    position.currentPrice &&
    Math.abs(position.currentPrice - position.liquidationPrice) / position.currentPrice < 0.01
  ) {
    return 'liquidation';
  }

  // Check if stop loss hit (negative PnL with quick close)
  if (position.pnl && position.pnl < 0 && position.stopLossPrice) {
    if (position.direction === 'LONG' && position.currentPrice <= position.stopLossPrice) {
      return 'stop_loss';
    }
    if (position.direction === 'SHORT' && position.currentPrice >= position.stopLossPrice) {
      return 'stop_loss';
    }
  }

  // Check if take profit hit (positive PnL)
  if (position.pnl && position.pnl > 0 && position.takeProfitPrice) {
    if (position.direction === 'LONG' && position.currentPrice >= position.takeProfitPrice) {
      return 'take_profit';
    }
    if (position.direction === 'SHORT' && position.currentPrice <= position.takeProfitPrice) {
      return 'take_profit';
    }
  }

  // LP withdrawal
  if (position.type === 'LP') {
    return 'lp_withdrawal';
  }

  // Default to manual close
  return 'manual';
}

/**
 * Calculates summary statistics for a set of positions
 */
export function calculatePositionSummary(positions: Position[]): {
  totalPositions: number;
  totalAUM: number;
  totalPnL: number;
  totalROI: number;
  perpPositions: number;
  lpPositions: number;
} {
  const summary = {
    totalPositions: positions.length,
    totalAUM: 0,
    totalPnL: 0,
    totalROI: 0,
    perpPositions: 0,
    lpPositions: 0,
  };

  for (const pos of positions) {
    // Calculate AUM
    if (pos.type === 'PERP' && pos.margin) {
      summary.totalAUM += pos.margin;
      summary.perpPositions++;
    } else if (pos.type === 'LP' && pos.liquidity) {
      summary.totalAUM += pos.liquidity;
      summary.lpPositions++;
    }

    // Accumulate PnL
    if (pos.pnl) {
      summary.totalPnL += pos.pnl;
    }
  }

  // Calculate overall ROI
  if (summary.totalAUM > 0) {
    summary.totalROI = (summary.totalPnL / summary.totalAUM) * 100;
  }

  return summary;
}
