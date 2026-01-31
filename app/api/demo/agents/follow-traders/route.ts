import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongoose';
import mongoose from 'mongoose';
import Agent from '@/models/Agent';

/**
 * POST /api/demo/agents/follow-traders
 * Matches top traders based on OVERLAP with user's actual positions:
 *   - Perps: finds HL traders holding the same coins as the user
 *   - Predictions: finds PM traders strong in the same categories as user's markets
 * Falls back to global top traders if user has no positions.
 *
 * Body: { wallet: string }
 */

// Reuse the same categorization logic from profile-trader.ts
function categorizeMarket(title: string): string {
  const lower = title.toLowerCase();

  const nbaTeams = ['nba', 'basketball', 'lakers', 'celtics', 'bulls', 'heat', 'warriors', 'nuggets',
    'clippers', 'spurs', 'mavericks', 'mavs', 'thunder', 'rockets', 'suns', 'knicks', 'nets', '76ers',
    'sixers', 'bucks', 'cavaliers', 'cavs', 'grizzlies', 'timberwolves', 'wolves', 'pelicans',
    'blazers', 'trail blazers', 'kings', 'jazz', 'hawks', 'hornets', 'magic', 'pistons', 'pacers',
    'wizards', 'raptors'];
  if (nbaTeams.some(team => lower.includes(team))) return 'NBA';

  const nflTeams = ['nfl', 'football', 'super bowl', 'chiefs', 'eagles', 'bills', 'ravens', 'cowboys',
    '49ers', 'niners', 'patriots', 'pats', 'broncos', 'packers', 'lions', 'dolphins', 'jets',
    'raiders', 'chargers', 'steelers', 'bengals', 'browns', 'texans', 'colts', 'jaguars', 'jags',
    'titans', 'saints', 'falcons', 'panthers', 'buccaneers', 'bucs', 'vikings', 'bears',
    'commanders', 'giants', 'cardinals', 'seahawks', 'rams'];
  if (nflTeams.some(team => lower.includes(team))) return 'NFL';

  const nhlTeams = ['nhl', 'hockey', 'canucks', 'flames', 'oilers', 'maple leafs', 'leafs',
    'canadiens', 'habs', 'senators', 'sens', 'bruins', 'rangers', 'islanders', 'devils',
    'flyers', 'penguins', 'pens', 'capitals', 'caps', 'hurricanes', 'canes', 'blue jackets',
    'lightning', 'bolts', 'red wings', 'blackhawks', 'wild', 'blues',
    'predators', 'preds', 'stars', 'avalanche', 'avs', 'coyotes', 'golden knights', 'knights',
    'kraken', 'ducks', 'sharks'];
  if (nhlTeams.some(team => lower.includes(team))) return 'NHL';

  const soccerTeams = ['premier league', 'la liga', 'bundesliga', 'serie a', 'ligue 1', 'champions league',
    'manchester', 'liverpool', 'chelsea', 'arsenal', 'tottenham', 'barcelona', 'real madrid',
    'bayern', 'juventus', 'psg', 'fc ', ' fc', 'united', 'city'];
  if (soccerTeams.some(team => lower.includes(team))) return 'Soccer';

  if (lower.includes('mlb') || lower.includes('baseball')) return 'MLB';

  if (lower.includes('trump') || lower.includes('biden') || lower.includes('election') ||
      lower.includes('president') || lower.includes('congress') || lower.includes('senate') ||
      lower.includes('democrat') || lower.includes('republican') || lower.includes('governor') ||
      lower.includes('vote') || lower.includes('poll')) return 'Politics';

  if (lower.includes('bitcoin') || lower.includes('ethereum') || lower.includes('crypto') ||
      lower.includes('btc') || lower.includes('eth') || lower.includes('solana') ||
      lower.includes('doge') || lower.includes('token')) return 'Crypto';

  return 'Other';
}

interface FollowedTrader {
  wallet: string;
  platform: string;
  username?: string;
  pnl30d: number;
  winRate: number;
  roi30d?: number;
  totalPositions: number;
  totalAUM?: number;
  matchReason?: string;
  followedAt: Date;
}

export async function POST(request: NextRequest) {
  try {
    await connectDB();
    const db = mongoose.connection.db;
    if (!db) {
      return NextResponse.json({ error: 'DB not connected' }, { status: 500 });
    }

    const { wallet } = await request.json();
    if (!wallet) {
      return NextResponse.json({ error: 'Wallet address required' }, { status: 400 });
    }

    const walletLower = wallet.toLowerCase();

    const agent = await Agent.findOne({ ownerWallet: walletLower });
    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

    const markets = agent.markets || ['perps'];
    const hasPerps = markets.includes('perps');
    const hasPredictions = markets.includes('predictions');

    // ── Step 1: Fetch user's positions to determine overlap criteria ──
    const [userPositions, userPmPositions] = await Promise.all([
      db.collection('positions').find({
        walletAddress: walletLower,
        type: 'PERP',
        status: 'active',
      }).toArray(),
      db.collection('polymarket-openPositions').find({
        walletAddress: walletLower,
      }).toArray(),
    ]);

    // Extract user's perp coins (e.g., ["BTC", "ETH", "SOL"])
    const userPerpCoins = [...new Set(
      userPositions
        .map(p => (p.pair || '').replace(/\/USD$/, '').toUpperCase())
        .filter(Boolean)
    )];

    // Extract user's PM categories from market titles
    const userPmCategories = [...new Set(
      userPmPositions
        .map(p => categorizeMarket(p.title || ''))
        .filter(cat => cat !== 'Other')
    )];

    console.log(`[follow-traders] User ${walletLower} coins: [${userPerpCoins.join(', ')}], PM categories: [${userPmCategories.join(', ')}]`);

    const followedTraders: FollowedTrader[] = [];

    // ── Step 2: Find perp traders who trade the same coins ──
    if (hasPerps) {
      let hlTraders: any[] = [];

      if (userPerpCoins.length > 0) {
        // Find HL traders who have open positions in the same coins as the user
        // Group by wallet, pick those with overlapping coins, then join with metrics
        const overlappingWallets = await db.collection('hyperliquidpositions').aggregate([
          { $match: { coin: { $in: userPerpCoins }, walletAddress: { $ne: walletLower } } },
          { $group: {
            _id: '$walletAddress',
            matchedCoins: { $addToSet: '$coin' },
            coinCount: { $sum: 1 },
          }},
          { $sort: { coinCount: -1 } },
          { $limit: 20 }, // get candidates
        ]).toArray();

        if (overlappingWallets.length > 0) {
          const candidateWallets = overlappingWallets.map(w => w._id);
          // Fetch metrics for these wallets and sort by PnL
          hlTraders = await db.collection('hyperliquidmetrics').find({
            walletAddress: { $in: candidateWallets },
            pnl_30d: { $gt: 0 }, // only profitable traders
          }).sort({ pnl_30d: -1 }).limit(2).toArray();

          // Attach match reason
          const coinMap = new Map(overlappingWallets.map(w => [w._id, w.matchedCoins]));
          for (const t of hlTraders) {
            const matched = coinMap.get(t.walletAddress) || [];
            followedTraders.push({
              wallet: t.walletAddress || 'unknown',
              platform: 'hyperliquid',
              username: t.username || t.name || undefined,
              pnl30d: t.pnl_30d || 0,
              winRate: t.winRate || t.positionWinRate || 0,
              totalPositions: t.totalTrades || 0,
              totalAUM: parseFloat(t.accountValue) || 0,
              matchReason: `Trades ${matched.join(', ')}`,
              followedAt: new Date(),
            });
          }
        }
      }

      // Fallback: if no overlapping traders found, use global top
      if (followedTraders.filter(t => t.platform === 'hyperliquid').length === 0) {
        const hlFallback = await db.collection('hyperliquidmetrics')
          .find({ walletAddress: { $ne: walletLower } })
          .sort({ pnl_30d: -1 }).limit(2).toArray();
        for (const t of hlFallback) {
          followedTraders.push({
            wallet: t.walletAddress || t.wallet || 'unknown',
            platform: 'hyperliquid',
            username: t.username || t.name || undefined,
            pnl30d: t.pnl_30d || 0,
            winRate: t.winRate || t.positionWinRate || 0,
            totalPositions: t.totalTrades || 0,
            totalAUM: parseFloat(t.accountValue) || 0,
            matchReason: 'Top PnL (global)',
            followedAt: new Date(),
          });
        }
      }

      // Avantis: 1 trader (position-matched if possible)
      const avQuery: any = { walletAddress: { $ne: walletLower } };
      if (userPerpCoins.length > 0) {
        // Check if managers have positions with matching pairs
        avQuery['positions.pair'] = { $in: userPerpCoins.map(c => new RegExp(c, 'i')) };
      }
      const avTop = await db.collection('managers')
        .find(avQuery)
        .sort({ 'metrics.totalPnL30d': -1 }).limit(1).toArray();

      // Fallback if regex query returned nothing
      const avResult = avTop.length > 0 ? avTop : await db.collection('managers')
        .find({ walletAddress: { $ne: walletLower } })
        .sort({ 'metrics.totalPnL30d': -1 }).limit(1).toArray();

      for (const t of avResult) {
        followedTraders.push({
          wallet: t.walletAddress || 'unknown',
          platform: 'avantis',
          username: t.username,
          pnl30d: t.metrics?.totalPnL30d || 0,
          winRate: t.metrics?.winRate || 0,
          roi30d: t.metrics?.roi30d || 0,
          totalPositions: t.metrics?.totalTrades || 0,
          totalAUM: t.metrics?.totalAUM || 0,
          matchReason: userPerpCoins.length > 0 ? `Similar assets` : 'Top PnL (global)',
          followedAt: new Date(),
        });
      }
    }

    // ── Step 3: Find PM traders strong in user's same categories (from traderProfiles) ──
    // Market-level matching skipped — only 370 openPositions vs 15k profiles.
    // For specific market queries, the LLM can use the getPMPositions MCP tool on-demand.
    if (hasPredictions) {
      let pmTraders: any[] = [];

      if (userPmCategories.length > 0) {
        pmTraders = await db.collection('polymarket-traderProfiles').find({
          wallet: { $ne: walletLower },
          'strengths.category': { $in: userPmCategories },
          netPnl: { $gt: 0 },
        }).sort({ netPnl: -1 }).limit(3).toArray();
      }

      // Fallback to global top PM traders
      if (pmTraders.length === 0) {
        pmTraders = await db.collection('polymarket-traderProfiles')
          .find({ wallet: { $ne: walletLower } })
          .sort({ netPnl: -1 }).limit(3).toArray();
      }

      for (const t of pmTraders) {
        const traderCategories = (t.strengths || []).map((s: any) => s.category);
        const categoryOverlap = userPmCategories.filter(c => traderCategories.includes(c));

        followedTraders.push({
          wallet: t.wallet || 'unknown',
          platform: 'polymarket',
          pnl30d: t.netPnl || 0,
          winRate: t.winRate || 0,
          totalPositions: t.totalActivities || 0,
          totalAUM: t.openValue || 0,
          matchReason: categoryOverlap.length > 0
            ? `Strong in ${categoryOverlap.join(', ')}`
            : 'Top PnL (global)',
          followedAt: new Date(),
        });
      }
      console.log(`[follow-traders] PM traders matched: ${pmTraders.length} (categories: [${userPmCategories.join(', ')}])`);
    }

    // Update agent
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
