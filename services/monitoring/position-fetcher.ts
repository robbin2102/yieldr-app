/**
 * Position Fetcher Service
 *
 * Fetches live positions from all platforms for a given manager's wallets.
 * Handles errors gracefully and returns standardized position data.
 *
 * NOTE: Calls external APIs directly (not Next.js API routes) for standalone operation.
 */

interface PositionFetchResult {
  success: boolean;
  platform: 'avantis' | 'hyperliquid' | 'lp';
  positions: any[];
  error?: string;
  duration?: number;
}

interface ManagerWallets {
  primary: string;
  scouted: string[];
}

/**
 * Fetches Avantis positions for all manager wallets
 * Calls Railway Python service directly
 */
export async function fetchAvantisPositions(
  wallets: ManagerWallets
): Promise<PositionFetchResult> {
  const startTime = Date.now();

  try {
    const allWallets = [wallets.primary, ...wallets.scouted];
    const allPositions = [];

    // Fetch positions for each wallet
    for (const wallet of allWallets) {
      try {
        const serviceUrl = process.env.AVANTIS_SERVICE_URL || process.env.PYTHON_SERVICE_URL || 'http://localhost:8000';
        const response = await fetch(
          `${serviceUrl}/positions/${wallet}`,
          {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(45000), // 45s timeout
          }
        );

        if (!response.ok) {
          console.warn(`[Avantis] Failed for wallet ${wallet}: ${response.status}`);
          continue;
        }

        const data = await response.json();

        if (data && Array.isArray(data)) {
          // Add wallet metadata to each position
          const positionsWithWallet = data.map((pos: any) => ({
            ...pos,
            walletAddress: wallet.toLowerCase(),
            platform: 'avantis',
            type: 'PERP',
            positionId: `avantis-${wallet}-${pos.tradeIndex || Date.now()}`,
            openedAt: pos.openedAt || new Date(),
          }));
          allPositions.push(...positionsWithWallet);
        }
      } catch (walletError: any) {
        console.error(`[Avantis] Error fetching wallet ${wallet}:`, walletError.message);
      }
    }

    return {
      success: true,
      platform: 'avantis',
      positions: allPositions,
      duration: Date.now() - startTime,
    };
  } catch (error: any) {
    console.error('[Avantis] Fetch error:', error);
    return {
      success: false,
      platform: 'avantis',
      positions: [],
      error: error.message,
      duration: Date.now() - startTime,
    };
  }
}

/**
 * Fetches Hyperliquid positions for all manager wallets
 * Calls Hyperliquid API directly
 */
export async function fetchHyperliquidPositions(
  wallets: ManagerWallets
): Promise<PositionFetchResult> {
  const startTime = Date.now();

  try {
    const allWallets = [wallets.primary, ...wallets.scouted];
    const allPositions = [];

    // Fetch positions for each wallet in parallel
    const results = await Promise.allSettled(
      allWallets.map(async (wallet) => {
        // Call Hyperliquid API directly
        const response = await fetch('https://api.hyperliquid.xyz/info', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'clearinghouseState',
            user: wallet,
          }),
          signal: AbortSignal.timeout(30000), // 30s timeout
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();

        // Parse Hyperliquid response
        const assetPositions = data.assetPositions || [];

        return assetPositions.map((assetPos: any) => {
          const pos = assetPos.position;
          const szi = parseFloat(pos.szi);
          const entryPrice = parseFloat(pos.entryPx);
          const marginUsed = parseFloat(pos.marginUsed);
          const unrealizedPnl = parseFloat(pos.unrealizedPnl);
          const positionValue = parseFloat(pos.positionValue);
          const liquidationPrice = pos.liquidationPx ? parseFloat(pos.liquidationPx) : null;

          const direction = szi > 0 ? 'LONG' : 'SHORT';
          const size = Math.abs(szi);
          const positionSizeUSD = Math.abs(positionValue);

          let currentPrice = entryPrice;
          if (size > 0) {
            if (direction === 'LONG') {
              currentPrice = entryPrice + (unrealizedPnl / size);
            } else {
              currentPrice = entryPrice - (unrealizedPnl / size);
            }
          }

          const roi = marginUsed > 0 ? (unrealizedPnl / marginUsed) * 100 : 0;

          return {
            walletAddress: wallet.toLowerCase(),
            platform: 'hyperliquid',
            type: 'PERP',
            pair: `${pos.coin}/USD`,
            asset: pos.coin,
            direction,
            leverage: pos.leverage?.value || 1,
            positionSize: positionSizeUSD,
            margin: marginUsed,
            entryPrice,
            currentPrice,
            liquidationPrice,
            pnl: unrealizedPnl,
            roi,
            status: 'active',
            positionId: `hyperliquid-${wallet}-${pos.coin}-${Date.now()}`,
            openedAt: new Date(), // Hyperliquid doesn't provide open time
          };
        });
      })
    );

    // Collect successful results
    for (const result of results) {
      if (result.status === 'fulfilled') {
        allPositions.push(...result.value);
      } else {
        console.warn('[Hyperliquid] Wallet fetch failed:', result.reason?.message || result.reason);
      }
    }

    return {
      success: true,
      platform: 'hyperliquid',
      positions: allPositions,
      duration: Date.now() - startTime,
    };
  } catch (error: any) {
    console.error('[Hyperliquid] Fetch error:', error);
    return {
      success: false,
      platform: 'hyperliquid',
      positions: [],
      error: error.message,
      duration: Date.now() - startTime,
    };
  }
}

/**
 * Fetches LP positions for all manager wallets
 * Calls Krystal API directly
 * NOTE: Should only be called every 300s (5 minutes)
 */
export async function fetchLPPositions(
  wallets: ManagerWallets
): Promise<PositionFetchResult> {
  const startTime = Date.now();

  try {
    const allWallets = [wallets.primary, ...wallets.scouted];
    const allPositions = [];

    // Fetch LP positions for each wallet
    for (const wallet of allWallets) {
      try {
        // Call Krystal API directly
        const response = await fetch(
          `https://api.krystal.app/v1/liquidity-positions?address=${wallet}&chain=base`,
          {
            method: 'GET',
            headers: {
              'Content-Type': 'application/json',
              'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
            },
            signal: AbortSignal.timeout(60000), // 60s timeout (LP API can be slow)
          }
        );

        if (!response.ok) {
          console.warn(`[LP] Failed for wallet ${wallet}: ${response.status}`);
          continue;
        }

        const data = await response.json();

        if (data && data.data && Array.isArray(data.data)) {
          const positionsWithWallet = data.data.map((pos: any) => ({
            walletAddress: wallet.toLowerCase(),
            platform: pos.platform || 'aerodrome',
            type: 'LP',
            pair: `${pos.token0?.symbol || ''}/${pos.token1?.symbol || ''}`,
            pool: pos.pool,
            chain: 'base',
            liquidity: pos.liquidity || 0,
            token0: pos.token0?.symbol || '',
            token1: pos.token1?.symbol || '',
            pnl: pos.pnl || 0,
            roi: pos.roi || 0,
            apr: pos.apr || 0,
            status: 'active',
            positionId: `lp-${wallet}-${pos.positionId || Date.now()}`,
            unclaimedFees: pos.unclaimedFees || 0,
            openedAt: pos.createdAt ? new Date(pos.createdAt) : new Date(),
          }));
          allPositions.push(...positionsWithWallet);
        }
      } catch (walletError: any) {
        console.error(`[LP] Error fetching wallet ${wallet}:`, walletError.message);
      }
    }

    return {
      success: true,
      platform: 'lp',
      positions: allPositions,
      duration: Date.now() - startTime,
    };
  } catch (error: any) {
    console.error('[LP] Fetch error:', error);
    return {
      success: false,
      platform: 'lp',
      positions: [],
      error: error.message,
      duration: Date.now() - startTime,
    };
  }
}

/**
 * Fetches all positions for a manager
 * Intelligently decides whether to fetch LP based on last fetch time
 */
export async function fetchAllPositions(
  wallets: ManagerWallets,
  lastLPFetch?: Date
): Promise<{
  avantis: any[];
  hyperliquid: any[];
  lp: any[];
  summary: {
    total: number;
    duration: number;
    errors: string[];
  };
}> {
  const startTime = Date.now();
  const errors: string[] = [];

  // Determine if we should fetch LP positions (every 300s)
  const shouldFetchLP =
    !lastLPFetch ||
    Date.now() - lastLPFetch.getTime() > 300000; // 5 minutes

  // Fetch positions in parallel
  const [avantisResult, hyperliquidResult, lpResult] = await Promise.all([
    fetchAvantisPositions(wallets),
    fetchHyperliquidPositions(wallets),
    shouldFetchLP ? fetchLPPositions(wallets) : Promise.resolve({
      success: true,
      platform: 'lp' as const,
      positions: [],
      duration: 0,
    }),
  ]);

  // Collect errors
  if (!avantisResult.success && avantisResult.error) {
    errors.push(`Avantis: ${avantisResult.error}`);
  }
  if (!hyperliquidResult.success && hyperliquidResult.error) {
    errors.push(`Hyperliquid: ${hyperliquidResult.error}`);
  }
  if (!lpResult.success && lpResult.error) {
    errors.push(`LP: ${lpResult.error}`);
  }

  const totalPositions =
    avantisResult.positions.length +
    hyperliquidResult.positions.length +
    lpResult.positions.length;

  console.log(`[PositionFetcher] Fetched ${totalPositions} positions in ${Date.now() - startTime}ms`);
  if (errors.length > 0) {
    console.warn(`[PositionFetcher] Errors:`, errors);
  }

  return {
    avantis: avantisResult.positions,
    hyperliquid: hyperliquidResult.positions,
    lp: lpResult.positions,
    summary: {
      total: totalPositions,
      duration: Date.now() - startTime,
      errors,
    },
  };
}
