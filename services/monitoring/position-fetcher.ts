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
 * Calls Railway Python batch service - ONE call with all wallets
 */
export async function fetchAvantisPositions(
  wallets: ManagerWallets
): Promise<PositionFetchResult> {
  const startTime = Date.now();

  try {
    const allWallets = [wallets.primary, ...wallets.scouted];
    const serviceUrl = process.env.AVANTIS_SERVICE_URL || process.env.PYTHON_SERVICE_URL || 'https://yieldr-app-production.up.railway.app';
    const rpcUrl = process.env.QUICKNODE_BASE_RPC_URL || 'https://mainnet.base.org';

    console.log(`[Avantis] Fetching ${allWallets.length} wallets in batch...`);

    // Call batch endpoint with ALL wallets
    const response = await fetch(
      `${serviceUrl}/fetch-positions-batch`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          walletAddresses: allWallets,
          rpcUrl: rpcUrl
        }),
        signal: AbortSignal.timeout(30000), // 30s timeout (much faster with batch)
      }
    );

    if (!response.ok) {
      const duration = Date.now() - startTime;
      console.warn(`[Avantis] Batch request failed: ${response.status} (${duration}ms)`);
      return {
        success: false,
        platform: 'avantis',
        positions: [],
        error: `HTTP ${response.status}`,
        duration,
      };
    }

    const data = await response.json();
    const duration = Date.now() - startTime;

    if (!data.success || !data.data?.positionsByWallet) {
      console.warn(`[Avantis] Invalid response (${duration}ms)`);
      return {
        success: false,
        platform: 'avantis',
        positions: [],
        error: 'Invalid response format',
        duration,
      };
    }

    // Extract all positions from batch response
    const allPositions = [];
    for (const [walletAddress, walletData] of Object.entries(data.data.positionsByWallet)) {
      const positions = (walletData as any).positions || [];
      const positionsWithWallet = positions.map((pos: any) => ({
        ...pos,
        walletAddress: walletAddress.toLowerCase(),
        platform: 'avantis',
        type: 'PERP',
        positionId: `avantis-${walletAddress}-${pos.tradeIndex || Date.now()}`,
        openedAt: pos.openedAt || new Date(),
      }));
      allPositions.push(...positionsWithWallet);
    }

    console.log(`[Avantis] ✓ ${allPositions.length} positions (${duration}ms)`);

    return {
      success: true,
      platform: 'avantis',
      positions: allPositions,
      duration,
    };
  } catch (error: any) {
    const duration = Date.now() - startTime;
    console.error(`[Avantis] Error: ${error.message} (${duration}ms)`);
    return {
      success: false,
      platform: 'avantis',
      positions: [],
      error: error.message,
      duration,
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

    console.log(`[Hyperliquid] Fetching ${allWallets.length} wallets in parallel...`);

    // Fetch positions for all wallets in parallel
    // Hyperliquid API limit: 1200/min = 20 req/sec (plenty of headroom)
    // Manager staggering (100ms) provides natural rate limiting
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

    const duration = Date.now() - startTime;
    console.log(`[Hyperliquid] ✓ ${allPositions.length} positions (${duration}ms)`);

    return {
      success: true,
      platform: 'hyperliquid',
      positions: allPositions,
      duration,
    };
  } catch (error: any) {
    const duration = Date.now() - startTime;
    console.error(`[Hyperliquid] Error: ${error.message} (${duration}ms)`);
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

    console.log(`[LP] Fetching ${allWallets.length} wallets in parallel...`);

    // Fetch LP positions for all wallets in parallel
    // Manager staggering provides natural rate limiting
    const results = await Promise.allSettled(
      allWallets.map(async (wallet) => {
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
            signal: AbortSignal.timeout(15000), // 15s timeout (should be fast)
          }
        );

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();

        // Krystal API returns positions array directly
        if (!data || !data.positions || !Array.isArray(data.positions)) {
          return [];
        }

        return data.positions.map((pos: any) => {
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
      })
    );

    // Collect successful results
    for (const result of results) {
      if (result.status === 'fulfilled') {
        allPositions.push(...result.value);
      } else {
        console.warn('[LP] Wallet fetch failed:', result.reason?.message || result.reason);
      }
    }

    const duration = Date.now() - startTime;
    console.log(`[LP] ✓ ${allPositions.length} positions (${duration}ms)`);

    return {
      success: true,
      platform: 'lp',
      positions: allPositions,
      duration,
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

/**
 * Fetches Hyperliquid userFills (closed positions)
 * Returns last 30 days of fills on first run, then incremental
 */
export async function fetchHyperliquidUserFills(
  wallets: ManagerWallets,
  lastFetchTime?: number
): Promise<PositionFetchResult> {
  const startTime = Date.now();

  try {
    const allWallets = [wallets.primary, ...wallets.scouted];
    const allFills = [];

    console.log(`[Hyperliquid] Fetching fills for ${allWallets.length} wallets...`);

    // Fetch fills for all wallets in parallel
    const results = await Promise.allSettled(
      allWallets.map(async (wallet) => {
        let fillsData;

        if (lastFetchTime) {
          // Incremental: Fetch fills since last fetch
          const response = await fetch('https://api.hyperliquid.xyz/info', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type: 'userFillsByTime',
              user: wallet,
              startTime: lastFetchTime,
              endTime: Date.now(),
              aggregateByTime: true, // Combine partial fills from same order
            }),
            signal: AbortSignal.timeout(30000),
          });

          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }

          fillsData = await response.json();
        } else {
          // First run: Fetch last 30 days
          const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
          const response = await fetch('https://api.hyperliquid.xyz/info', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type: 'userFillsByTime',
              user: wallet,
              startTime: thirtyDaysAgo,
              endTime: Date.now(),
              aggregateByTime: true, // Combine partial fills from same order
            }),
            signal: AbortSignal.timeout(30000),
          });

          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }

          fillsData = await response.json();
        }

        // Add wallet address to each fill
        return fillsData.map((fill: any) => ({
          ...fill,
          walletAddress: wallet.toLowerCase(),
        }));
      })
    );

    // Collect successful results
    for (const result of results) {
      if (result.status === 'fulfilled') {
        allFills.push(...result.value);
      } else {
        console.warn('[Hyperliquid] Wallet fills fetch failed:', result.reason?.message);
      }
    }

    const duration = Date.now() - startTime;
    console.log(`[Hyperliquid] ✓ ${allFills.length} fills (${duration}ms)`);

    return {
      success: true,
      platform: 'hyperliquid',
      positions: allFills, // Using positions array for fills
      duration,
    };
  } catch (error: any) {
    const duration = Date.now() - startTime;
    console.error(`[Hyperliquid] Error fetching fills: ${error.message} (${duration}ms)`);
    return {
      success: false,
      platform: 'hyperliquid',
      positions: [],
      error: error.message,
      duration,
    };
  }
}

/**
 * Fetches Hyperliquid open orders
 */
export async function fetchHyperliquidOpenOrders(
  wallets: ManagerWallets
): Promise<PositionFetchResult> {
  const startTime = Date.now();

  try {
    const allWallets = [wallets.primary, ...wallets.scouted];
    const allOrders = [];

    console.log(`[Hyperliquid] Fetching open orders for ${allWallets.length} wallets...`);

    // Fetch open orders for all wallets in parallel
    const results = await Promise.allSettled(
      allWallets.map(async (wallet) => {
        const response = await fetch('https://api.hyperliquid.xyz/info', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'openOrders',
            user: wallet,
          }),
          signal: AbortSignal.timeout(15000),
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const ordersData = await response.json();

        // Add wallet address to each order
        return ordersData.map((order: any) => ({
          ...order,
          walletAddress: wallet.toLowerCase(),
          platform: 'hyperliquid',
        }));
      })
    );

    // Collect successful results
    for (const result of results) {
      if (result.status === 'fulfilled') {
        allOrders.push(...result.value);
      } else {
        console.warn('[Hyperliquid] Wallet orders fetch failed:', result.reason?.message);
      }
    }

    const duration = Date.now() - startTime;
    console.log(`[Hyperliquid] ✓ ${allOrders.length} open orders (${duration}ms)`);

    return {
      success: true,
      platform: 'hyperliquid',
      positions: allOrders, // Using positions array for orders
      duration,
    };
  } catch (error: any) {
    const duration = Date.now() - startTime;
    console.error(`[Hyperliquid] Error fetching orders: ${error.message} (${duration}ms)`);
    return {
      success: false,
      platform: 'hyperliquid',
      positions: [],
      error: error.message,
      duration,
    };
  }
}

/**
 * Fetches Hyperliquid portfolio data (account value and PnL history)
 * Used for computing time-based metrics and historical data
 */
export async function fetchHyperliquidPortfolio(
  wallets: ManagerWallets
): Promise<{
  success: boolean;
  platform: 'hyperliquid';
  portfolios: any[];
  duration: number;
  error?: string;
}> {
  const startTime = Date.now();

  try {
    const allWallets = [wallets.primary, ...wallets.scouted];
    const allPortfolios = [];

    console.log(`[Hyperliquid] Fetching portfolio data for ${allWallets.length} wallets...`);

    // Fetch portfolio data for all wallets in parallel
    const results = await Promise.allSettled(
      allWallets.map(async (wallet) => {
        const response = await fetch('https://api.hyperliquid.xyz/info', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'portfolio',
            user: wallet,
          }),
          signal: AbortSignal.timeout(15000),
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const portfolioData = await response.json();

        // Parse portfolio data structure
        // Format: [["day", {...}], ["week", {...}], ...]
        const parsed: any = {
          walletAddress: wallet.toLowerCase(),
          platform: 'hyperliquid',
          timestamp: new Date(),
        };

        for (const [period, data] of portfolioData) {
          const key = `${period}Data`;
          parsed[key] = data;

          // Extract latest values for quick access
          if (period === 'day') {
            const pnlHistory = data.pnlHistory || [];
            const accountValueHistory = data.accountValueHistory || [];

            if (pnlHistory.length > 0) {
              parsed.pnl = parseFloat(pnlHistory[pnlHistory.length - 1][1] || '0');
            }

            if (accountValueHistory.length > 0) {
              parsed.accountValue = parseFloat(accountValueHistory[accountValueHistory.length - 1][1] || '0');
            }
          }
        }

        return parsed;
      })
    );

    // Collect successful results
    for (const result of results) {
      if (result.status === 'fulfilled') {
        allPortfolios.push(result.value);
      } else {
        console.warn('[Hyperliquid] Wallet portfolio fetch failed:', result.reason?.message);
      }
    }

    const duration = Date.now() - startTime;
    console.log(`[Hyperliquid] ✓ ${allPortfolios.length} portfolio snapshots (${duration}ms)`);

    return {
      success: true,
      platform: 'hyperliquid',
      portfolios: allPortfolios,
      duration,
    };
  } catch (error: any) {
    const duration = Date.now() - startTime;
    console.error(`[Hyperliquid] Error fetching portfolio: ${error.message} (${duration}ms)`);
    return {
      success: false,
      platform: 'hyperliquid',
      portfolios: [],
      error: error.message,
      duration,
    };
  }
}
