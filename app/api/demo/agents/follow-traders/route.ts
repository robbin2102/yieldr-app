import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongoose';
import Agent from '@/models/Agent';

const MCP_URL = 'https://mcp-demo-production-59da.up.railway.app';

/**
 * POST /api/demo/agents/follow-traders
 * Finds top traders based on the agent's positions and markets,
 * then updates the agent's followedTraders array.
 *
 * Body: { wallet: string }
 */
export async function POST(request: NextRequest) {
  try {
    await connectDB();

    const { wallet } = await request.json();
    if (!wallet) {
      return NextResponse.json({ error: 'Wallet address required' }, { status: 400 });
    }

    const agent = await Agent.findOne({ ownerWallet: wallet.toLowerCase() });
    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

    const followedTraders: Array<{
      wallet: string;
      platform: 'avantis' | 'hyperliquid' | 'polymarket';
      username?: string;
      pnl30d?: number;
      winRate?: number;
      roi30d?: number;
      totalPositions?: number;
      totalAUM?: number;
      followedAt: Date;
    }> = [];

    const markets = agent.markets || ['perps'];
    const hasPerps = markets.includes('perps');
    const hasPredictions = markets.includes('predictions');

    // --- Get top perp traders (3 total: prefer HL, fill with Avantis) ---
    if (hasPerps) {
      const hlTraders = await callMCPTool('get_top_perp_traders', {
        protocol: 'hyperliquid',
        sortBy: 'pnl',
        timeframe: '30d',
        limit: 3,
      });

      const avTraders = await callMCPTool('get_top_perp_traders', {
        protocol: 'avantis',
        sortBy: 'pnl',
        limit: 3,
      });

      // Take top 2 from HL and top 1 from Avantis (or fill as available)
      const hlList = hlTraders?.traders || [];
      const avList = avTraders?.traders || [];

      const hlPicked = hlList.slice(0, 2);
      const avPicked = avList.slice(0, Math.max(1, 3 - hlPicked.length));

      for (const t of hlPicked) {
        followedTraders.push({
          wallet: t.wallet,
          platform: 'hyperliquid',
          username: t.username,
          pnl30d: t.pnl?.month || 0,
          winRate: t.stats?.positionWinRate || 0,
          roi30d: t.stats?.roi30d || 0,
          totalPositions: t.stats?.totalPositions || 0,
          totalAUM: parseFloat(t.accountValue) || 0,
          followedAt: new Date(),
        });
      }

      for (const t of avPicked) {
        followedTraders.push({
          wallet: t.wallet,
          platform: 'avantis',
          username: t.username,
          pnl30d: t.pnl?.month || 0,
          winRate: t.stats?.positionWinRate || 0,
          roi30d: t.stats?.roi30d || 0,
          totalPositions: t.stats?.totalPositions || 0,
          totalAUM: t.stats?.totalAUM || 0,
          followedAt: new Date(),
        });
      }
    }

    // --- Get top PM traders (3 from polymarket tracked traders) ---
    if (hasPredictions) {
      try {
        const pmRes = await fetch(`${getBaseUrl(request)}/api/copy-trading/traders?positions=true`);
        if (pmRes.ok) {
          const pmData = await pmRes.json();
          const pmTraders = (pmData.traders || [])
            .sort((a: any, b: any) => (b.totalPnl || 0) - (a.totalPnl || 0))
            .slice(0, 3);

          for (const t of pmTraders) {
            followedTraders.push({
              wallet: t.wallet,
              platform: 'polymarket',
              username: t.label,
              pnl30d: t.totalPnl || 0,
              winRate: t.winRate || 0,
              totalPositions: t.positionCount || 0,
              totalAUM: t.totalPositionValue || 0,
              followedAt: new Date(),
            });
          }
        }
      } catch (e) {
        console.error('Failed to fetch PM traders:', e);
      }
    }

    // Update agent with followed traders
    agent.followedTraders = followedTraders;
    await agent.save();

    return NextResponse.json({
      success: true,
      followedTraders,
      count: followedTraders.length,
    });
  } catch (error) {
    console.error('Error following traders:', error);
    return NextResponse.json({ error: 'Failed to follow traders' }, { status: 500 });
  }
}

/** Call MCP server tool via HTTP */
async function callMCPTool(toolName: string, args: Record<string, unknown>) {
  try {
    const res = await fetch(`${MCP_URL}/call-tool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: toolName, arguments: args }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    // MCP returns { content: [{ type: 'text', text: '...' }] }
    const text = data?.content?.[0]?.text;
    if (text) {
      return JSON.parse(text);
    }
    return null;
  } catch (e) {
    console.error(`MCP tool ${toolName} failed:`, e);
    return null;
  }
}

/** Derive base URL from the incoming request */
function getBaseUrl(request: NextRequest): string {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}
