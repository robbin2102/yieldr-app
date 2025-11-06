/**
 * Position Fetcher Service
 *
 * Fetches live positions from all platforms for a given manager's wallets.
 * Handles errors gracefully and returns standardized position data.
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
        const response = await fetch(
          `${process.env.AVANTIS_SERVICE_URL || 'http://localhost:8000'}/api/avantis-positions?address=${wallet}`,
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

        if (data.success && data.data?.positions) {
          // Add wallet metadata to each position
          const positionsWithWallet = data.data.positions.map((pos: any) => ({
            ...pos,
            walletAddress: wallet.toLowerCase(),
            platform: 'avantis',
            type: 'PERP',
            positionId: `avantis-${wallet}-${pos.tradeIndex}`,
          }));
          allPositions.push(...positionsWithWallet);
        }
      } catch (walletError) {
        console.error(`[Avantis] Error fetching wallet ${wallet}:`, walletError);
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
        const response = await fetch(
          `/api/hyperliquid-positions?address=${wallet}`,
          {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(30000), // 30s timeout
          }
        );

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();
        if (data.success && data.data?.positions) {
          return data.data.positions.map((pos: any) => ({
            ...pos,
            walletAddress: wallet.toLowerCase(),
            platform: 'hyperliquid',
            positionId: `hyperliquid-${wallet}-${pos.pair}-${Date.now()}`,
          }));
        }
        return [];
      })
    );

    // Collect successful results
    for (const result of results) {
      if (result.status === 'fulfilled') {
        allPositions.push(...result.value);
      } else {
        console.warn('[Hyperliquid] Wallet fetch failed:', result.reason);
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
        const response = await fetch(
          `/api/lp-positions?address=${wallet}`,
          {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(60000), // 60s timeout (LP API can be slow)
          }
        );

        if (!response.ok) {
          console.warn(`[LP] Failed for wallet ${wallet}: ${response.status}`);
          continue;
        }

        const data = await response.json();

        if (data.success && data.data?.positions) {
          const positionsWithWallet = data.data.positions.map((pos: any) => ({
            ...pos,
            walletAddress: wallet.toLowerCase(),
            type: 'LP',
            positionId: `lp-${wallet}-${pos.positionId}`,
          }));
          allPositions.push(...positionsWithWallet);
        }
      } catch (walletError) {
        console.error(`[LP] Error fetching wallet ${wallet}:`, walletError);
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
