/**
 * Position Fetcher Service
 *
 * Fetches live positions from all platforms for a given manager's wallets.
 * Handles errors gracefully and returns standardized position data.
 *
 * NOTE: Calls external APIs directly (not Next.js API routes) for standalone operation.
 */

/**
 * Rate limiting helper - adds delay between API calls
 */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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
        const serviceUrl = process.env.AVANTIS_SERVICE_URL || process.env.PYTHON_SERVICE_URL || 'https://yieldr-app-production.up.railway.app';
        const rpcUrl = process.env.QUICKNODE_BASE_RPC_URL || 'https://mainnet.base.org';

        const response = await fetch(
          `${serviceUrl}/fetch-positions`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              walletAddress: wallet,
              rpcUrl: rpcUrl
            }),
            signal: AbortSignal.timeout(90000), // 90s timeout
          }
        );

        if (!response.ok) {
          console.warn(`[Avantis] Failed for wallet ${wallet}: ${response.status}`);
          continue;
        }

        const data = await response.json();

        if (data.success && data.data?.positions && Array.isArray(data.data.positions)) {
          // Add wallet metadata to each position
          const positionsWithWallet = data.data.positions.map((pos: any) => ({
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

    // Fetch positions for each wallet with rate limiting (100ms between calls)
    // Hyperliquid API limit: 1200/min = 20 req/sec
    // 100ms = 10 req/sec = 50% headroom for scale
    const results = await Promise.allSettled(
      allWallets.map(async (wallet, index) => {
        // Add 100ms delay between requests for rate limiting
        if (index > 0) {
          await delay(100);
        }

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

    // Fetch LP positions for each wallet with rate limiting (500ms between calls)
    // Krystal API rate limit unknown, so using conservative 500ms = 2 req/sec
    for (let i = 0; i < allWallets.length; i++) {
      const wallet = allWallets[i];

      // Add 500ms delay between requests for rate limiting
      if (i > 0) {
        await delay(500);
      }

      try {
        const normalizedAddress = wallet.toLowerCase();

        // Call Krystal API directly (correct endpoint)
        const response = await fetch(
          `https://api.krystal.app/all/v1/lp/userPositions?addresses=${normalizedAddress}&chainIds=8453`,
          {
            method: 'GET',
            headers: {
              'Accept': 'application/json',
              'User-Agent': 'Mozilla/5.0 (compatible; Yieldr/1.0; +https://app.yieldr.org)',
              'Origin': 'https://app.yieldr.org',
              'Referer': 'https://app.yieldr.org/'
            },
            signal: AbortSignal.timeout(60000), // 60s timeout (LP API can be slow)
          }
        );

        if (!response.ok) {
          console.warn(`[LP] Failed for wallet ${wallet}: ${response.status}`);
          continue;
        }

        const data = await response.json();

        // Krystal API returns positions array directly
        if (data && data.positions && Array.isArray(data.positions)) {
          const positionsWithWallet = data.positions.map((pos: any) => {
            const token0 = pos.currentAmounts?.[0]?.token;
            const token1 = pos.currentAmounts?.[1]?.token;

            const liquidity = pos.currentAmounts?.reduce((sum: number, amount: any) => {
              return sum + (amount.quotes?.usd?.value || 0);
            }, 0) || 0;

            const platform = pos.pool?.project || pos.pool?.projectKey || 'aerodrome';

            return {
              walletAddress: wallet.toLowerCase(),
              platform: platform.toLowerCase(),
              type: 'LP',
              pair: `${token0?.symbol || '?'}/${token1?.symbol || '?'}`,
              pool: pos.pool?.address || '',
              chain: 'base',
              liquidity: liquidity,
              token0: token0?.symbol || '',
              token1: token1?.symbol || '',
              pnl: pos.pnl || 0,
              roi: pos.returnOnInvestment || 0,
              apr: pos.apr || 0,
              status: pos.status || 'active',
              positionId: `lp-${wallet}-${pos.id || Date.now()}`,
              unclaimedFees: pos.feePending?.reduce((sum: number, fee: any) =>
                sum + (fee.quotes?.usd?.value || 0), 0) || 0,
              openedAt: new Date(), // Krystal doesn't provide open time
            };
          });
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
 * Fetches positions for specified platforms
 * Supports selective fetching based on intervals
 */
export async function fetchAllPositions(
  wallets: ManagerWallets,
  options?: {
    fetchAvantis?: boolean;
    fetchHyperliquid?: boolean;
    fetchLP?: boolean;
  }
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

  // Default: fetch all platforms
  const fetchAvantis = options?.fetchAvantis !== false;
  const fetchHyperliquid = options?.fetchHyperliquid !== false;
  const fetchLP = options?.fetchLP !== false;

  // Fetch positions in parallel for enabled platforms
  const [avantisResult, hyperliquidResult, lpResult] = await Promise.all([
    fetchAvantis ? fetchAvantisPositions(wallets) : Promise.resolve({
      success: true,
      platform: 'avantis' as const,
      positions: [],
      duration: 0,
    }),
    fetchHyperliquid ? fetchHyperliquidPositions(wallets) : Promise.resolve({
      success: true,
      platform: 'hyperliquid' as const,
      positions: [],
      duration: 0,
    }),
    fetchLP ? fetchLPPositions(wallets) : Promise.resolve({
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
