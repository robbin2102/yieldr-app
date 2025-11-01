import { NextRequest, NextResponse } from 'next/server';
import type {
  HyperliquidAPIRequest,
  HyperliquidClearinghouseState,
  HyperliquidAssetPosition,
  StandardizedPerpPosition,
  PositionAPIResponse,
} from '@/types/hyperliquid';

/**
 * Hyperliquid Positions API Route
 * Fetches live perpetual positions from Hyperliquid DEX
 *
 * API Docs: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals
 *
 * @route GET /api/hyperliquid-positions?address=0x...
 */

const HYPERLIQUID_API_URL = 'https://api.hyperliquid.xyz/info';
const REQUEST_TIMEOUT = 30000; // 30 seconds (Hyperliquid is fast)

/**
 * Validates Ethereum address format
 */
function isValidEthereumAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

/**
 * Maps Hyperliquid position to standardized PERP format (matching Avantis)
 */
function mapHyperliquidPosition(
  assetPosition: HyperliquidAssetPosition
): StandardizedPerpPosition {
  const pos = assetPosition.position;

  // Parse numeric values from string
  const szi = parseFloat(pos.szi);
  const entryPrice = parseFloat(pos.entryPx);
  const marginUsed = parseFloat(pos.marginUsed);
  const unrealizedPnl = parseFloat(pos.unrealizedPnl);
  const positionValue = parseFloat(pos.positionValue);
  const liquidationPrice = pos.liquidationPx ? parseFloat(pos.liquidationPx) : null;

  // Determine direction: positive szi = long, negative = short
  const direction: 'LONG' | 'SHORT' = szi > 0 ? 'LONG' : 'SHORT';

  // Calculate position size (absolute value of position)
  const size = Math.abs(szi);
  const positionSizeUSD = Math.abs(positionValue);

  // Calculate current price from unrealized PnL
  // For LONG: currentPrice = entryPrice + (pnl / size)
  // For SHORT: currentPrice = entryPrice - (pnl / size)
  let currentPrice = entryPrice;
  if (size > 0) {
    if (direction === 'LONG') {
      currentPrice = entryPrice + (unrealizedPnl / size);
    } else {
      currentPrice = entryPrice - (unrealizedPnl / size);
    }
  }

  // Calculate ROI: (PnL / Margin Used) * 100
  const roi = marginUsed > 0 ? (unrealizedPnl / marginUsed) * 100 : 0;

  // Map to standardized format
  return {
    type: 'PERP',
    platform: 'Hyperliquid',
    pair: `${pos.coin}/USD`,
    direction,
    leverage: pos.leverage.value,
    positionSize: positionSizeUSD,
    margin: marginUsed,
    entryPrice,
    currentPrice,
    liquidationPrice,
    pnl: unrealizedPnl,
    roi,
    status: 'active',
    positionId: `hl-${pos.coin}-${Date.now()}`,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/**
 * Fetches positions from Hyperliquid API with timeout
 */
async function fetchHyperliquidPositions(
  address: string
): Promise<HyperliquidClearinghouseState> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    const requestBody: HyperliquidAPIRequest = {
      type: 'clearinghouseState',
      user: address,
    };

    const response = await fetch(HYPERLIQUID_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Hyperliquid API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    return data;
  } catch (error: any) {
    clearTimeout(timeoutId);

    if (error.name === 'AbortError') {
      throw new Error('Request timeout: Hyperliquid API took too long to respond');
    }

    throw error;
  }
}

/**
 * GET handler for fetching Hyperliquid positions
 */
export async function GET(request: NextRequest) {
  try {
    // Extract wallet address from query parameters
    const searchParams = request.nextUrl.searchParams;
    const address = searchParams.get('address');

    // Validate address parameter
    if (!address) {
      return NextResponse.json(
        {
          success: false,
          error: 'Missing required parameter: address',
          message: 'Please provide a wallet address in the query string (?address=0x...)',
        } as PositionAPIResponse,
        { status: 400 }
      );
    }

    // Validate Ethereum address format
    if (!isValidEthereumAddress(address)) {
      return NextResponse.json(
        {
          success: false,
          error: 'Invalid Ethereum address',
          message: 'Please provide a valid Ethereum address (0x followed by 40 hex characters)',
        } as PositionAPIResponse,
        { status: 400 }
      );
    }

    console.log(`[Hyperliquid] Fetching positions for address: ${address}`);

    // Fetch clearinghouse state from Hyperliquid
    const clearinghouseState = await fetchHyperliquidPositions(address);

    // Extract asset positions
    const assetPositions = clearinghouseState.assetPositions || [];

    console.log(`[Hyperliquid] Found ${assetPositions.length} positions`);

    // Map to standardized format
    const positions: StandardizedPerpPosition[] = assetPositions.map(mapHyperliquidPosition);

    // Calculate summary statistics
    const totalPnL = positions.reduce((sum, pos) => sum + pos.pnl, 0);
    const totalMargin = positions.reduce((sum, pos) => sum + pos.margin, 0);
    const overallROI = totalMargin > 0 ? (totalPnL / totalMargin) * 100 : 0;
    const accountValue = parseFloat(clearinghouseState.marginSummary.accountValue);
    const withdrawable = parseFloat(clearinghouseState.withdrawable);

    // Return success response
    const response: PositionAPIResponse = {
      success: true,
      data: {
        totalPositions: positions.length,
        positions,
        summary: {
          totalPnL,
          totalMargin,
          overallROI,
          accountValue,
          withdrawable,
        },
      },
    };

    console.log(`[Hyperliquid] Success - PnL: ${totalPnL.toFixed(2)}, Margin: ${totalMargin.toFixed(2)}, ROI: ${overallROI.toFixed(2)}%`);

    return NextResponse.json(response);
  } catch (error: any) {
    console.error('[Hyperliquid] Error fetching positions:', error);

    return NextResponse.json(
      {
        success: false,
        error: 'Failed to fetch Hyperliquid positions',
        message: error.message || 'An unexpected error occurred',
      } as PositionAPIResponse,
      { status: 500 }
    );
  }
}
