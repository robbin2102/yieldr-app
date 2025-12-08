import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongodb';
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
  try {
    await connectDB();

    const body: LaunchAgentRequest = await request.json();
    const { walletAddress, market, platform, userId } = body;

    // Validate input
    if (!walletAddress || !market) {
      return NextResponse.json(
        { success: false, error: 'walletAddress and market are required' },
        { status: 400 }
      );
    }

    if (market === 'PERP' && !platform) {
      return NextResponse.json(
        { success: false, error: 'platform is required for PERP market' },
        { status: 400 }
      );
    }

    const normalizedWallet = walletAddress.toLowerCase();

    // Check if already monitored
    const existing = await MonitoredWallet.findOne({
      walletAddress: normalizedWallet,
      market,
      platform: market === 'PERP' ? platform : null
    });

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

    console.log(`Launching agent for ${normalizedWallet} (${market}${platform ? ` - ${platform}` : ''})...`);

    // Launch based on market type
    if (market === 'PERP' && platform === 'HYPERLIQUID') {
      // Hyperliquid monitoring
      const result = await launchHyperliquidAgent(normalizedWallet, userId);
      return NextResponse.json(result);
    } else if (market === 'LP') {
      // LP monitoring
      const result = await launchLPAgent(normalizedWallet, userId);
      return NextResponse.json(result);
    } else {
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
 */
async function launchHyperliquidAgent(walletAddress: string, userId?: string) {
  const now = new Date();

  try {
    // 1. Fetch 30-day fills history
    console.log('[Hyperliquid] Fetching 30-day fills...');
    const { saved, duplicates } = await fetchAndSaveInitialFills(walletAddress);
    console.log(`[Hyperliquid] Saved ${saved} fills (${duplicates} duplicates)`);

    // 2. Fetch current positions
    console.log('[Hyperliquid] Fetching current positions...');
    const { marginSummary, currentPositions } = await fetchHyperliquidPositions(walletAddress);
    console.log(`[Hyperliquid] Found ${currentPositions} open positions`);

    // 3. Compute initial metrics
    console.log('[Hyperliquid] Computing metrics...');
    await computeHyperliquidMetrics(walletAddress, marginSummary);

    // 4. Create MonitoredWallet entry
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

    // 5. Return initial data
    const positions = await HyperliquidPosition.find({ walletAddress });
    const metrics = await HyperliquidMetrics.findOne({ walletAddress });

    console.log(`✓ [Hyperliquid] Agent launched for ${walletAddress}`);

    return {
      success: true,
      status: 'launched',
      message: 'Hyperliquid monitoring agent launched successfully',
      data: {
        positions,
        metrics,
        stats: {
          fillsFetched: saved,
          openPositions: currentPositions
        }
      }
    };
  } catch (error: any) {
    console.error('[Hyperliquid] Error launching agent:', error);
    throw error;
  }
}

/**
 * Launch LP monitoring agent
 */
async function launchLPAgent(walletAddress: string, userId?: string) {
  const now = new Date();

  try {
    // 1. Fetch current LP positions
    console.log('[LP] Fetching current positions...');
    const { totalPositions } = await fetchLPPositions(walletAddress);
    console.log(`[LP] Found ${totalPositions} positions`);

    // 2. Compute initial metrics
    console.log('[LP] Computing metrics...');
    await computeLPMetrics(walletAddress);

    // 3. Create MonitoredWallet entry with random interval
    const interval = process.env.NODE_ENV === 'production'
      ? Math.floor(Math.random() * (30 - 5 + 1) + 5) * 60 * 1000 // 5-30 min
      : 60 * 1000; // 60s for testing

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

    // 4. Return initial data
    const positions = await LPPosition.find({ walletAddress });
    const metrics = await LPMetrics.findOne({ walletAddress });

    console.log(`✓ [LP] Agent launched for ${walletAddress}`);

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
    console.error('[LP] Error launching agent:', error);
    throw error;
  }
}
