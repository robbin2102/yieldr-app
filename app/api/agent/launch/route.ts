import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongoose';
import MonitoredWallet from '@/models/MonitoredWallet';
import HyperliquidPosition from '@/models/HyperliquidPosition';
import HyperliquidMetrics from '@/models/HyperliquidMetrics';
import LPPosition from '@/models/LPPosition';
import LPMetrics from '@/models/LPMetrics';

// Hyperliquid imports
import { fetchAndSaveInitialFills, fetchAndSavePositions as fetchHyperliquidPositions } from '@/services/monitors/hyperliquid/fetcher';
import { computeMetrics as computeHyperliquidMetrics } from '@/services/monitors/hyperliquid/metrics';

// LP imports
import { fetchAndSavePositions as fetchLPPositions } from '@/services/monitors/lp/fetcher';
import { computeMetrics as computeLPMetrics } from '@/services/monitors/lp/metrics';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface LaunchAgentRequest {
  walletAddress: string;
  market: 'LP' | 'PERP';
  platform?: 'HYPERLIQUID';
  userId?: string;
}

/**
 * POST /api/agent/launch
 * Launch monitoring agent for a wallet
 */
export async function POST(request: NextRequest) {
  const requestStartTime = Date.now();
  console.log('🔵 [API] POST /api/agent/launch - Request received');

  try {
    console.log('🔵 [API] Connecting to MongoDB...');
    const dbStart = Date.now();
    await connectDB();
    console.log(`🔵 [API] MongoDB connected in ${Date.now() - dbStart}ms`);

    console.log('🔵 [API] Parsing request body...');
    const body: LaunchAgentRequest = await request.json();
    console.log(`🔵 [API] Request body:`, JSON.stringify(body, null, 2));
    const { walletAddress, market, platform, userId } = body;

    // Validate input
    if (!walletAddress || !market) {
      console.log('🔴 [API] Validation failed: missing walletAddress or market');
      return NextResponse.json(
        { success: false, error: 'walletAddress and market are required' },
        { status: 400 }
      );
    }

    if (market === 'PERP' && !platform) {
      console.log('🔴 [API] Validation failed: PERP market requires platform');
      return NextResponse.json(
        { success: false, error: 'platform is required for PERP market' },
        { status: 400 }
      );
    }

    const normalizedWallet = walletAddress.toLowerCase();
    console.log(`🔵 [API] Normalized wallet: ${normalizedWallet}`);

    // Check if already monitored
    console.log('🔵 [API] Checking if wallet already monitored...');
    const dbQueryStart = Date.now();
    const existing = await MonitoredWallet.findOne({
      walletAddress: normalizedWallet,
      market,
      platform: market === 'PERP' ? platform : null
    });
    console.log(`🔵 [API] DB query took ${Date.now() - dbQueryStart}ms - Found existing: ${!!existing}`);

    if (existing) {
      if (existing.status === 'active') {
        // Already active, return existing data
        console.log(`Agent already active for ${normalizedWallet} (${market})`);

        if (market === 'PERP' && platform === 'HYPERLIQUID') {
          const positions = await HyperliquidPosition.find({ walletAddress: normalizedWallet });
          const metrics = await HyperliquidMetrics.findOne({ walletAddress: normalizedWallet });

          return NextResponse.json({
            success: true,
            status: 'already_active',
            data: {
              positions: positions || [],
              metrics: metrics || null
            }
          });
        } else if (market === 'LP') {
          const positions = await LPPosition.find({ walletAddress: normalizedWallet });
          const metrics = await LPMetrics.findOne({ walletAddress: normalizedWallet });

          return NextResponse.json({
            success: true,
            status: 'already_active',
            data: {
              positions: positions || [],
              metrics: metrics || null
            }
          });
        }
      } else {
        // Reactivate
        existing.status = 'active';
        existing.nextCheck = new Date();
        await existing.save();
      }
    }

    console.log(`🔵 [API] Launching agent for ${normalizedWallet} (${market}${platform ? ` - ${platform}` : ''})...`);

    // Launch based on market type
    if (market === 'PERP' && platform === 'HYPERLIQUID') {
      // Hyperliquid monitoring
      console.log('🔵 [API] Calling launchHyperliquidAgent...');
      const launchStart = Date.now();
      const result = await launchHyperliquidAgent(normalizedWallet, userId);
      console.log(`🔵 [API] launchHyperliquidAgent completed in ${Date.now() - launchStart}ms`);
      return NextResponse.json(result);
    } else if (market === 'LP') {
      // LP monitoring
      console.log('🔵 [API] Calling launchLPAgent...');
      const launchStart = Date.now();
      const result = await launchLPAgent(normalizedWallet, userId);
      console.log(`🔵 [API] launchLPAgent completed in ${Date.now() - launchStart}ms`);
      return NextResponse.json(result);
    } else {
      console.log('🔴 [API] Invalid market/platform combination');
      return NextResponse.json(
        { success: false, error: 'Invalid market/platform combination' },
        { status: 400 }
      );
    }
  } catch (error: any) {
    console.error('Error launching agent:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Failed to launch agent' },
      { status: 500 }
    );
  }
}

/**
 * Launch Hyperliquid monitoring agent
 * Note: Historical fills backfill is skipped for fast response.
 * Monitoring will capture new fills going forward.
 */
async function launchHyperliquidAgent(walletAddress: string, userId?: string) {
  const now = new Date();

  try {
    console.log(`[Hyperliquid] 🚀 Launching agent for ${walletAddress}...`);

    // 1. Fetch current positions ONLY (fast response)
    console.log('[Hyperliquid] 📊 Fetching current positions...');
    const { marginSummary, currentPositions } = await fetchHyperliquidPositions(walletAddress);
    console.log(`[Hyperliquid] ✓ Found ${currentPositions} open positions`);

    // 2. Compute initial metrics (will be empty initially, filled by monitoring)
    console.log('[Hyperliquid] 📈 Computing initial metrics...');
    await computeHyperliquidMetrics(walletAddress, marginSummary);
    console.log('[Hyperliquid] ✓ Metrics initialized');

    // 3. Create MonitoredWallet entry
    console.log('[Hyperliquid] 🔧 Setting up monitoring...');
    await MonitoredWallet.findOneAndUpdate(
      { walletAddress, market: 'PERP', platform: 'HYPERLIQUID' },
      {
        walletAddress,
        market: 'PERP',
        platform: 'HYPERLIQUID',
        status: 'active',
        monitorInterval: 5 * 60 * 1000, // 5 minutes
        lastChecked: now,
        nextCheck: new Date(now.getTime() + 5 * 60 * 1000),
        userId,
        createdAt: now
      },
      { upsert: true, new: true }
    );
    console.log('[Hyperliquid] ✓ Monitoring activated (5min intervals)');

    // 4. Return initial data
    const positions = await HyperliquidPosition.find({ walletAddress });
    const metrics = await HyperliquidMetrics.findOne({ walletAddress });

    console.log(`[Hyperliquid] ✅ Agent launched successfully for ${walletAddress}`);

    return {
      success: true,
      status: 'launched',
      message: 'Hyperliquid monitoring agent launched successfully',
      data: {
        positions,
        metrics,
        stats: {
          openPositions: currentPositions,
          note: 'Historical fills will be captured by background monitoring. Metrics will populate as trades occur.'
        }
      }
    };
  } catch (error: any) {
    console.error('[Hyperliquid] ❌ Error launching agent:', error);
    throw error;
  }
}

/**
 * Launch LP monitoring agent
 */
async function launchLPAgent(walletAddress: string, userId?: string) {
  const now = new Date();

  try {
    console.log(`[LP] 🚀 Launching agent for ${walletAddress}...`);

    // 1. Fetch current LP positions
    console.log('[LP] 📊 Fetching current positions from DefiKrystal...');
    const { totalPositions } = await fetchLPPositions(walletAddress);
    console.log(`[LP] ✓ Found ${totalPositions} positions`);

    // 2. Compute initial metrics
    console.log('[LP] 📈 Computing metrics...');
    await computeLPMetrics(walletAddress);
    console.log('[LP] ✓ Metrics computed');

    // 3. Create MonitoredWallet entry with random interval
    const interval = process.env.NODE_ENV === 'production'
      ? Math.floor(Math.random() * (30 - 5 + 1) + 5) * 60 * 1000 // 5-30 min
      : 60 * 1000; // 60s for testing

    console.log(`[LP] 🔧 Setting up monitoring (${Math.round(interval / 1000)}s intervals)...`);
    await MonitoredWallet.findOneAndUpdate(
      { walletAddress, market: 'LP', platform: null },
      {
        walletAddress,
        market: 'LP',
        platform: null,
        status: 'active',
        monitorInterval: interval,
        lastChecked: now,
        nextCheck: new Date(now.getTime() + interval),
        userId,
        createdAt: now
      },
      { upsert: true, new: true }
    );
    console.log('[LP] ✓ Monitoring activated');

    // 4. Return initial data
    const positions = await LPPosition.find({ walletAddress });
    const metrics = await LPMetrics.findOne({ walletAddress });

    console.log(`[LP] ✅ Agent launched successfully for ${walletAddress}`);

    return {
      success: true,
      status: 'launched',
      message: 'LP monitoring agent launched successfully',
      data: {
        positions,
        metrics,
        stats: {
          positionsFetched: totalPositions,
          nextCheckIn: Math.round(interval / 1000 / 60) // minutes
        }
      }
    };
  } catch (error: any) {
    console.error('[LP] ❌ Error launching agent:', error);
    throw error;
  }
}
