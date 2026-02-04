import { NextRequest } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import connectDB from '@/lib/mongoose';
import mongoose from 'mongoose';
import Agent from '@/models/Agent';
import ChatSession from '@/models/ChatSession';
import { trackUsage, TokenUsageData } from '@/lib/tokenTracking';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || '',
});

const HYPERLIQUID_API_URL = 'https://api.hyperliquid.xyz/info';
const POLYMARKET_API_BASE = 'https://data-api.polymarket.com';
const AVANTIS_API_URL = 'https://yieldr-app-production.up.railway.app/fetch-positions';
const BASE_RPC_URL = process.env.BASE_RPC_URL || 'https://mainnet.base.org';

// ─── Position Cache (30 second TTL) ──────────────────────────────────────────
interface CachedPosition {
  data: any;
  timestamp: number;
}
const positionCache = new Map<string, CachedPosition>();
const CACHE_TTL_MS = 30000; // 30 seconds

function getCachedPositions(wallet: string): any | null {
  const cached = positionCache.get(wallet.toLowerCase());
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    console.log(`[CACHE HIT] Returning cached positions for ${wallet.slice(0, 10)}...`);
    return { ...cached.data, cached: true, cachedAge: Math.round((Date.now() - cached.timestamp) / 1000) };
  }
  return null;
}

function setCachedPositions(wallet: string, data: any): void {
  positionCache.set(wallet.toLowerCase(), { data, timestamp: Date.now() });
}

// ─── Retry Helper with Exponential Backoff ───────────────────────────────────
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries = 3,
  baseDelay = 500
): Promise<Response> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const res = await fetch(url, options);
      if (res.ok) return res;
      // Retry on 5xx errors
      if (res.status >= 500) {
        lastError = new Error(`Server error: ${res.status}`);
        console.log(`[RETRY] Attempt ${attempt + 1}/${maxRetries} failed with ${res.status}`);
      } else {
        // Don't retry on 4xx errors
        return res;
      }
    } catch (err: any) {
      lastError = err;
      console.log(`[RETRY] Attempt ${attempt + 1}/${maxRetries} failed: ${err.message}`);
    }
    // Wait before next retry (exponential backoff)
    if (attempt < maxRetries - 1) {
      const delay = baseDelay * Math.pow(2, attempt);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastError || new Error('Max retries exceeded');
}

// ─── Tool Definitions (Anthropic format) ───────────────────────────────────

const toolDefinitions: Anthropic.Tool[] = [
  {
    name: 'get_top_perp_traders',
    description: 'Get top perpetual traders from Hyperliquid or Avantis. For Hyperliquid: queries hyperliquidmetrics collection. For Avantis: queries managers collection filtered to traders with actual Avantis positions (avantisPositions > 0). Returns traders sorted by PnL, win rate, or volume.',
    input_schema: {
      type: 'object' as const,
      properties: {
        protocol: { type: 'string', enum: ['hyperliquid', 'avantis'], description: 'Protocol to query' },
        asset: { type: 'string', description: 'Filter by asset (ETH, BTC, SOL, etc.)' },
        sortBy: { type: 'string', enum: ['pnl', 'winRate', 'sharpe', 'volume', 'roi', 'aum'], description: 'Sort traders by metric' },
        timeframe: { type: 'string', enum: ['7d', '30d', '90d'], description: 'Timeframe for PnL (HL only)' },
        limit: { type: 'number', description: 'Number of traders to return (default: 10)' },
        minAccountValue: { type: 'number', description: 'Minimum account/portfolio value in USD (e.g. 100000 for $100K)' },
        maxAccountValue: { type: 'number', description: 'Maximum account/portfolio value in USD (e.g. 1000000 for $1M)' },
        minWinRate: { type: 'number', description: 'Minimum win rate as decimal (e.g. 0.6 for 60%)' },
        minProfitFactor: { type: 'number', description: 'Minimum profit factor (e.g. 2.0)' },
        minPnl: { type: 'number', description: 'Minimum PnL in USD for the selected timeframe' },
      },
      required: ['protocol'],
    },
  },
  {
    name: 'get_top_pm_traders',
    description: 'Get top Polymarket prediction market traders, filtered by category. Categories include: Sports, Crypto, NFL, NBA, NHL, Soccer, Politics, Economics, Fed, Entertainment, Tech, Science, Weather. Use when user asks about top bettors, prediction market traders, or specific sport/category traders.',
    input_schema: {
      type: 'object' as const,
      properties: {
        category: { type: 'string', description: 'Filter by category: Sports, Crypto, NFL, NBA, NHL, Soccer, Politics, Economics, Fed, etc.' },
        sortBy: { type: 'string', enum: ['winRate', 'netPnl', 'profitFactor', 'totalTrades'], description: 'Sort metric' },
        minTrades: { type: 'number', description: 'Minimum trades to filter experienced traders' },
        limit: { type: 'number', description: 'Number of traders (default: 10)' },
        minWinRate: { type: 'number', description: 'Minimum win rate as decimal (e.g. 0.6 for 60%)' },
        minProfitFactor: { type: 'number', description: 'Minimum profit factor (e.g. 2.0)' },
        minNetPnl: { type: 'number', description: 'Minimum net PnL in USD' },
        maxNetPnl: { type: 'number', description: 'Maximum net PnL in USD' },
      },
    },
  },
  {
    name: 'get_hl_live_positions',
    description: 'Get top open positions from Hyperliquid for any wallet, sorted by position value. Returns positions with PnL, leverage, liquidation prices.',
    input_schema: {
      type: 'object' as const,
      properties: {
        walletAddress: { type: 'string', description: 'Ethereum wallet address (0x...)' },
        limit: { type: 'number', description: 'Max positions to return (default: 10)' },
      },
      required: ['walletAddress'],
    },
  },
  {
    name: 'get_avantis_live_positions',
    description: 'Get top open positions from Avantis (Base chain) for any wallet, sorted by position value.',
    input_schema: {
      type: 'object' as const,
      properties: {
        walletAddress: { type: 'string', description: 'Ethereum wallet address (0x...)' },
        limit: { type: 'number', description: 'Max positions to return (default: 10)' },
      },
      required: ['walletAddress'],
    },
  },
  {
    name: 'get_pm_live_positions',
    description: 'Get top open positions from Polymarket for any wallet, sorted by current value. Filters out dust (<$1).',
    input_schema: {
      type: 'object' as const,
      properties: {
        walletAddress: { type: 'string', description: 'Ethereum wallet address (0x...)' },
        limit: { type: 'number', description: 'Max positions to return (default: 10)' },
      },
      required: ['walletAddress'],
    },
  },
  {
    name: 'get_hl_trade_history',
    description: 'Get recent trade history / fills from Hyperliquid for a wallet. Shows entry/exit patterns and timing.',
    input_schema: {
      type: 'object' as const,
      properties: {
        walletAddress: { type: 'string', description: 'Ethereum wallet address (0x...)' },
        limit: { type: 'number', description: 'Number of trades (default: 10, max: 100)' },
      },
      required: ['walletAddress'],
    },
  },
  {
    name: 'get_pm_closed_positions',
    description: 'Get closed/resolved Polymarket positions for a wallet. Shows historical win/loss record on prediction markets.',
    input_schema: {
      type: 'object' as const,
      properties: {
        walletAddress: { type: 'string', description: 'Ethereum wallet address (0x...)' },
        limit: { type: 'number', description: 'Number of positions (default: 10)' },
        days: { type: 'number', description: 'Days of history (default: 30)' },
      },
      required: ['walletAddress'],
    },
  },
  {
    name: 'get_hl_live_positions_batch',
    description: 'Get open positions for multiple Hyperliquid wallets in ONE call. ALWAYS use this instead of calling get_hl_live_positions multiple times when you have multiple wallet addresses.',
    input_schema: {
      type: 'object' as const,
      properties: {
        walletAddresses: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of wallet addresses (max 10)',
        },
        limit: { type: 'number', description: 'Max positions per wallet (default: 5)' },
      },
      required: ['walletAddresses'],
    },
  },
  {
    name: 'get_hl_portfolio',
    description: 'Get Hyperliquid portfolio overview with 30-day PnL history curve and account value for a wallet.',
    input_schema: {
      type: 'object' as const,
      properties: {
        walletAddress: { type: 'string', description: 'Ethereum wallet address (0x...)' },
      },
      required: ['walletAddress'],
    },
    cache_control: { type: 'ephemeral' as const },
  },
];

// Claude native web search tool
const webSearchTool = {
  type: 'web_search_20250305' as const,
  name: 'web_search' as const,
  max_uses: 2,
};

const allTools = [...toolDefinitions, webSearchTool];

// ─── Tool Status Labels ────────────────────────────────────────────────────

function getToolStatusLabel(name: string, input: any): string {
  switch (name) {
    case 'get_top_perp_traders':
      return `Fetching top ${input.asset || ''} traders on ${input.protocol || 'perps'}...`.trim();
    case 'get_top_pm_traders':
      return `Searching ${input.category || 'top'} Polymarket traders...`.trim();
    case 'get_hl_live_positions':
      return `Checking Hyperliquid positions for ${input.walletAddress?.slice(0, 10)}...`;
    case 'get_avantis_live_positions':
      return `Checking Avantis positions for ${input.walletAddress?.slice(0, 10)}...`;
    case 'get_pm_live_positions':
      return `Checking Polymarket positions for ${input.walletAddress?.slice(0, 10)}...`;
    case 'get_hl_trade_history':
      return `Pulling trade history for ${input.walletAddress?.slice(0, 10)}...`;
    case 'get_pm_closed_positions':
      return `Checking resolved positions for ${input.walletAddress?.slice(0, 10)}...`;
    case 'get_hl_live_positions_batch':
      return `Checking positions for ${input.walletAddresses?.length || 0} wallets...`;
    case 'get_hl_portfolio':
      return `Loading portfolio for ${input.walletAddress?.slice(0, 10)}...`;
    case 'web_search':
      return `Searching the web...`;
    default:
      return `Running ${name}...`;
  }
}

// ─── Tool Execution ────────────────────────────────────────────────────────

async function executeTool(name: string, input: any): Promise<string> {
  console.log(`[chat] Executing tool: ${name}`, JSON.stringify(input).slice(0, 200));
  try {
    switch (name) {
      case 'get_top_perp_traders': {
        await connectDB();
        const db = mongoose.connection.db!;
        const { protocol, asset, sortBy = 'pnl', timeframe = '30d', limit = 10,
                minAccountValue, maxAccountValue, minWinRate, minProfitFactor, minPnl } = input;

        if (protocol === 'hyperliquid') {
          const pnlField = `pnl_${timeframe}`;
          const sortFieldMap: Record<string, string> = {
            pnl: pnlField, winRate: 'positionWinRate', sharpe: 'sharpeRatio',
            volume: 'volume_24h', roi: pnlField, aum: 'accountValue',
          };
          const filter: any = {};
          if (asset) {
            const wallets = await db.collection('hyperliquid-positions').distinct('walletAddress', {
              coin: { $regex: new RegExp(`^${asset}$`, 'i') },
            });
            if (wallets.length > 0) filter.walletAddress = { $in: wallets };
          }
          if (minAccountValue) filter.accountValue = { ...(filter.accountValue || {}), $gte: minAccountValue };
          if (maxAccountValue) filter.accountValue = { ...(filter.accountValue || {}), $lte: maxAccountValue };
          if (minWinRate) filter.positionWinRate = { $gte: minWinRate };
          if (minProfitFactor) filter.profitFactor = { $gte: minProfitFactor };
          if (minPnl) filter[pnlField] = { $gte: minPnl };
          const traders = await db.collection('hyperliquidmetrics')
            .find(filter)
            .sort({ [sortFieldMap[sortBy] || pnlField]: -1 })
            .limit(limit)
            .toArray();
          return JSON.stringify({
            protocol: 'hyperliquid', totalFound: traders.length,
            traders: traders.map(t => ({
              wallet: t.walletAddress,
              pnl: { day: t.pnl_1d, week: t.pnl_7d, month: t.pnl_30d, allTime: t.pnl_allTime },
              winRate: t.positionWinRate, profitFactor: t.profitFactor,
              sharpeRatio: t.sharpeRatio, openPositions: t.openPositionsCount,
              accountValue: t.accountValue, avgLeverage: t.avgLeverage,
            })),
          });
        } else {
          // Avantis - query managers collection (filter by avantisPositions > 0 since collection has mixed HL/Avantis/LP data)
          const filter: any = {
            'metrics.totalPnL30d': { $exists: true },
            'metrics.avantisPositions': { $gt: 0 },
          };
          if (asset) filter['metrics.tradedAssets'] = { $regex: new RegExp(asset, 'i') };
          if (minWinRate) filter['metrics.winRate30d'] = { $gte: minWinRate };
          if (minPnl) filter['metrics.totalPnL30d'] = { $gte: minPnl };
          const traders = await db.collection('managers')
            .find(filter)
            .sort({ 'metrics.totalPnL30d': -1 })
            .limit(limit)
            .toArray();
          return JSON.stringify({
            protocol: 'avantis', totalFound: traders.length,
            traders: traders.map(t => ({
              wallet: t.walletAddress, username: t.username,
              pnl: { month: t.metrics?.totalPnL30d || 0 },
              winRate: t.metrics?.winRate30d || 0,
              totalPositions: t.metrics?.totalTrades30d || 0,
            })),
          });
        }
      }
      case 'get_top_pm_traders': {
        await connectDB();
        const db = mongoose.connection.db!;
        const { category, sortBy = 'netPnl', minTrades = 0, limit = 10,
                minWinRate, minProfitFactor, minNetPnl, maxNetPnl } = input;
        const filter: any = {};
        if (minTrades > 0) filter.closedPositionsCount = { $gte: minTrades };
        if (minWinRate) filter.winRate = { $gte: minWinRate };
        if (minProfitFactor) filter.profitFactor = { $gte: minProfitFactor };
        if (minNetPnl !== undefined) filter.netPnl = { ...(filter.netPnl || {}), $gte: minNetPnl };
        if (maxNetPnl !== undefined) filter.netPnl = { ...(filter.netPnl || {}), $lte: maxNetPnl };
        if (category) {
          // Query both specialty (top-level) and strengths.category (array) fields
          filter.$or = [
            { specialty: { $regex: category, $options: 'i' } },
            { 'strengths.category': { $regex: category, $options: 'i' } },
          ];
        }
        const sortFieldMap: Record<string, string> = {
          netPnl: 'netPnl', winRate: 'winRate', profitFactor: 'profitFactor', totalTrades: 'closedPositionsCount',
        };
        const traders = await db.collection('polymarket-traderProfiles')
          .find(filter)
          .sort({ [sortFieldMap[sortBy] || 'netPnl']: -1 })
          .limit(limit)
          .toArray();
        return JSON.stringify({
          totalFound: traders.length,
          traders: traders.map(t => ({
            wallet: t.wallet, label: t.label, specialty: t.specialty || t.strengths?.[0]?.category,
            strategyLabel: t.strategyLabel, volumeLabel: t.volumeLabel,
            metrics: {
              totalTrades: (t.buyCount || 0) + (t.sellCount || 0), winRate: t.winRate,
              netPnl: t.netPnl, profitFactor: t.profitFactor, avgTradeSize: t.avgTradeSize,
            },
            strengths: (t.strengths || []).slice(0, 3),
            openPositionsCount: t.openPositionsCount, unrealizedPnl: t.unrealizedPnl,
          })),
        });
      }
      case 'get_hl_live_positions': {
        const { walletAddress, limit = 10 } = input;

        // Check cache first
        const cached = getCachedPositions(walletAddress);
        if (cached) {
          // Apply limit to cached data
          const limitedPositions = cached.positions?.slice(0, limit) || [];
          return JSON.stringify({
            ...cached,
            positions: limitedPositions,
            showing: limitedPositions.length,
          });
        }

        // Fetch with retry logic
        const res = await fetchWithRetry(HYPERLIQUID_API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'clearinghouseState', user: walletAddress }),
        });
        if (!res.ok) throw new Error(`HL API error: ${res.status}`);
        const data = await res.json();
        const allPositions = (data.assetPositions || []).map((ap: any) => {
          const pos = ap.position;
          const szi = parseFloat(pos.szi);
          const entryPx = parseFloat(pos.entryPx);
          return {
            coin: pos.coin, side: szi > 0 ? 'LONG' : 'SHORT',
            size: Math.abs(szi), entryPrice: entryPx,
            leverage: pos.leverage?.value || 1,
            unrealizedPnl: parseFloat(pos.unrealizedPnl),
            marginUsed: parseFloat(pos.marginUsed),
            notionalValue: Math.abs(szi) * entryPx, // for sorting
          };
        });
        // Sort by notional value descending, limit results
        allPositions.sort((a: any, b: any) => b.notionalValue - a.notionalValue);
        const topPositions = allPositions.slice(0, limit).map((p: any) => {
          const { notionalValue, ...rest } = p; // remove sorting field
          return rest;
        });

        const result = {
          wallet: walletAddress, totalPositions: allPositions.length, showing: topPositions.length,
          positions: topPositions, accountValue: data.marginSummary?.accountValue,
        };

        // Cache the result (store all positions for flexible limit on cache hit)
        setCachedPositions(walletAddress, {
          wallet: walletAddress, totalPositions: allPositions.length,
          positions: allPositions.map((p: any) => { const { notionalValue, ...rest } = p; return rest; }),
          accountValue: data.marginSummary?.accountValue,
        });

        return JSON.stringify(result);
      }
      case 'get_hl_live_positions_batch': {
        const { walletAddresses, limit = 5 } = input;
        const addresses = (walletAddresses || []).slice(0, 10); // max 10 wallets
        const results = await Promise.all(
          addresses.map(async (addr: string) => {
            try {
              // Check cache first
              const cached = getCachedPositions(addr);
              if (cached) {
                const limitedPositions = cached.positions?.slice(0, limit) || [];
                return {
                  ...cached,
                  positions: limitedPositions,
                  showing: limitedPositions.length,
                };
              }

              // Fetch with retry logic
              const res = await fetchWithRetry(HYPERLIQUID_API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: 'clearinghouseState', user: addr }),
              });
              if (!res.ok) return { wallet: addr, error: `API error: ${res.status}`, positions: [] };
              const data = await res.json();
              const allPos = (data.assetPositions || []).map((ap: any) => {
                const pos = ap.position;
                const szi = parseFloat(pos.szi);
                const entryPx = parseFloat(pos.entryPx);
                return {
                  coin: pos.coin, side: szi > 0 ? 'LONG' : 'SHORT',
                  size: Math.abs(szi), entryPrice: entryPx,
                  leverage: pos.leverage?.value || 1,
                  unrealizedPnl: parseFloat(pos.unrealizedPnl),
                  notionalValue: Math.abs(szi) * entryPx,
                };
              });
              allPos.sort((a: any, b: any) => b.notionalValue - a.notionalValue);
              const topPos = allPos.slice(0, limit).map((p: any) => {
                const { notionalValue, ...rest } = p;
                return rest;
              });

              const result = {
                wallet: addr, totalPositions: allPos.length, showing: topPos.length,
                positions: topPos, accountValue: data.marginSummary?.accountValue,
              };

              // Cache for future requests
              setCachedPositions(addr, {
                wallet: addr, totalPositions: allPos.length,
                positions: allPos.map((p: any) => { const { notionalValue, ...rest } = p; return rest; }),
                accountValue: data.marginSummary?.accountValue,
              });

              return result;
            } catch (e: any) {
              // On failure, try to return cached data even if stale
              const staleCache = positionCache.get(addr.toLowerCase());
              if (staleCache) {
                console.log(`[CACHE STALE] Returning stale cache for ${addr.slice(0, 10)} after error`);
                return {
                  ...staleCache.data,
                  positions: staleCache.data.positions?.slice(0, limit) || [],
                  cached: true,
                  stale: true,
                };
              }
              return { wallet: addr, error: e.message, positions: [] };
            }
          })
        );
        return JSON.stringify({ wallets: results });
      }
      case 'get_avantis_live_positions': {
        const { walletAddress, limit = 10 } = input;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);
        try {
          const res = await fetch(AVANTIS_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ walletAddress, rpcUrl: BASE_RPC_URL }),
            signal: controller.signal,
          });
          clearTimeout(timeout);
          const data = await res.json();
          // If positions exist, sort by collateral/value and limit
          if (data.positions && Array.isArray(data.positions)) {
            const sorted = [...data.positions].sort((a: any, b: any) => {
              const aVal = parseFloat(a.collateral || a.positionSizeCollateral || 0);
              const bVal = parseFloat(b.collateral || b.positionSizeCollateral || 0);
              return bVal - aVal;
            });
            return JSON.stringify({
              ...data,
              totalPositions: data.positions.length,
              showing: Math.min(limit, sorted.length),
              positions: sorted.slice(0, limit),
            });
          }
          return JSON.stringify(data);
        } catch (e: any) {
          clearTimeout(timeout);
          return JSON.stringify({ error: e.message });
        }
      }
      case 'get_pm_live_positions': {
        const { walletAddress, limit = 10 } = input;
        const allPositions: any[] = [];
        let offset = 0;
        while (true) {
          const res = await fetch(`${POLYMARKET_API_BASE}/positions?user=${walletAddress}&limit=500&offset=${offset}`);
          if (!res.ok) throw new Error(`PM API error: ${res.status}`);
          const data = await res.json();
          if (!Array.isArray(data) || data.length === 0) break;
          allPositions.push(...data);
          if (data.length < 500) break;
          offset += 500;
        }
        // Filter: active positions (price between 0.1% and 99.9%) AND current value >= $1
        const active = allPositions.filter(p => {
          const cp = parseFloat(p.curPrice || '0');
          const cv = parseFloat(p.currentValue || '0');
          return cp >= 0.001 && cp <= 0.999 && cv >= 1;
        }).map(p => ({
          title: p.title, outcome: p.outcome,
          size: parseFloat(p.size || '0'), avgPrice: parseFloat(p.avgPrice || '0'),
          currentPrice: parseFloat(p.curPrice || '0'), currentValue: parseFloat(p.currentValue || '0'),
          pnl: parseFloat(p.cashPnl || '0'), pnlPercent: parseFloat(p.percentPnl || '0'),
        }));
        // Sort by current value descending, limit
        active.sort((a, b) => b.currentValue - a.currentValue);
        return JSON.stringify({
          wallet: walletAddress, totalPositions: active.length, showing: Math.min(limit, active.length),
          positions: active.slice(0, limit),
        });
      }
      case 'get_hl_trade_history': {
        const limit = Math.min(input.limit || 10, 100);
        const endTime = input.endTime || Date.now();
        const startTime = input.startTime || (endTime - 7 * 24 * 60 * 60 * 1000);
        const res = await fetch(HYPERLIQUID_API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'userFillsByTime', user: input.walletAddress, startTime, endTime }),
        });
        if (!res.ok) throw new Error(`HL API error: ${res.status}`);
        const fills = await res.json();
        return JSON.stringify({
          wallet: input.walletAddress,
          trades: (Array.isArray(fills) ? fills : []).slice(0, limit).map((f: any) => ({
            coin: f.coin, side: f.side, price: f.px, size: f.sz, time: f.time,
            fee: f.fee, closedPnl: f.closedPnl,
          })),
        });
      }
      case 'get_pm_closed_positions': {
        const res = await fetch(`${POLYMARKET_API_BASE}/positions?user=${input.walletAddress}&limit=${input.limit || 10}&offset=0`);
        if (!res.ok) throw new Error(`PM API error: ${res.status}`);
        const data = await res.json();
        const closed = (Array.isArray(data) ? data : []).filter((p: any) => {
          const cp = parseFloat(p.curPrice || '0');
          return cp < 0.001 || cp > 0.999;
        });
        return JSON.stringify({
          wallet: input.walletAddress, totalClosed: closed.length,
          positions: closed.slice(0, input.limit || 10).map((p: any) => ({
            title: p.title, outcome: p.outcome,
            size: parseFloat(p.size || '0'), pnl: parseFloat(p.cashPnl || '0'),
          })),
        });
      }
      case 'get_hl_portfolio': {
        const res = await fetch(HYPERLIQUID_API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'clearinghouseState', user: input.walletAddress }),
        });
        if (!res.ok) throw new Error(`HL API error: ${res.status}`);
        const data = await res.json();
        return JSON.stringify({
          wallet: input.walletAddress,
          accountValue: data.marginSummary?.accountValue,
          totalMarginUsed: data.marginSummary?.totalMarginUsed,
          withdrawable: data.withdrawable,
          openPositions: (data.assetPositions || []).length,
        });
      }
      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  } catch (err: any) {
    console.error(`[chat] Tool ${name} error:`, err.message);
    return JSON.stringify({ error: err.message });
  }
}

// ─── System Prompt ─────────────────────────────────────────────────────────

// Static system prompt (cached) — agent instructions, rules — NO dynamic content
const STATIC_SYSTEM_PROMPT = `You are an AI trading and investment agent on the Yieldr platform.

You serve two roles:

1. TRADING ADVISOR — Help active traders analyze positions, compare with top performers, understand market context, and optimize entries/exits.

2. PORTFOLIO MANAGER — Help investors discover alpha by finding top traders across platforms, building allocation plans, constructing diversified portfolios, and suggesting execution paths.

---

## 🔧 Your Tools

You have access to powerful data tools. USE THEM proactively:

• get_top_perp_traders — Fetch top perpetual traders from Hyperliquid or Avantis
• get_top_pm_traders — Fetch top Polymarket traders filtered by category
• get_hl_live_positions — Get a single trader's Hyperliquid positions
• get_hl_live_positions_batch — Get positions for MULTIPLE wallets in ONE call (use when checking 2+ traders)
• get_avantis_live_positions — Get any trader's current Avantis positions
• get_pm_live_positions — Get any trader's current Polymarket positions
• get_hl_trade_history — Get recent trades/fills for a Hyperliquid wallet
• get_pm_closed_positions — Get resolved Polymarket positions
• get_hl_portfolio — Get Hyperliquid portfolio overview and account value
• web_search — Search the web for market news, macro events (native Claude tool)

---

## 🔍 Using Filters Effectively

Your tools support filters for account value, win rate, profit factor, PnL, trade count, and more.

When users specify criteria (portfolio size, minimum performance, category, etc.), use the appropriate tool parameters to narrow results:

User says → Tool parameter
• "100K-1M portfolio" → minAccountValue: 100000, maxAccountValue: 1000000
• "at least 60% win rate" → minWinRate: 0.6
• "profit factor above 2" → minProfitFactor: 2.0
• "made at least $50K" → minPnl: 50000
• "NBA traders" → category: "NBA"
• "minimum 50 trades" → minTrades: 50

If your query returns traders outside what the user asked for, acknowledge the mismatch:
• "The top performers in this category have larger portfolios than your specified range. Here's what I found — want me to adjust?"

If no results match, offer to expand:
• "No traders found with 70%+ win rate in NHL. The top NHL trader has 64%. Want me to show them?"

---

## 💰 Web Search Cost Optimization

• Web search is expensive (~$0.03 per call). Use sparingly.
• Your MongoDB tools (trader data, positions, history) are FREE. Prefer them.
• Search ONLY for: breaking news, Fed/macro events, injury reports for sports bets
• Max 2 searches per response unless user explicitly requests research
• Reuse search results within the same conversation

---

## ⚡ Tool Usage Rules

• When user asks about top traders → call get_top_perp_traders or get_top_pm_traders
• When user asks what traders are doing → call get_hl_live_positions or get_pm_live_positions
• When user asks about a category like NBA, NHL → call get_top_pm_traders with that category
• When user asks to build a portfolio → first fetch trader data, then construct plan
• When user asks about trader history → call get_hl_trade_history or get_pm_closed_positions
• When market context would help → call web_search (only when current info adds value)
• NEVER say you can't fetch data. You have tools. USE THEM.
• You can call multiple tools in sequence

---

## 📋 Portfolio Recommendation Format

When building portfolios or suggesting allocations:

💼 RECOMMENDED ALLOCATION: $[budget]

[Asset/Market] | [Platform]
• Allocation: $X,XXX (XX%)
• Direction: [LONG/SHORT or YES/NO]
• Rationale: [based on your analysis of market data and top performer patterns]

📊 PORTFOLIO SUMMARY
Total Allocated: $X,XXX
Expected Monthly Return: $X,XXX - $X,XXX (X-X%)
Diversification: [High/Medium/Low]
Risk Level: [Low/Medium/High]

⚡ EXECUTION
Trading agents launch in beta — I'll execute directly on Base protocols (Avantis for perps, Limitless for prediction markets).
For now, I can walk you through manual execution step-by-step.

---

## 🚀 Handling Execution Requests

When users ask to execute trades, place bets, or manage positions:

DO NOT say:
• "I cannot execute trades"
• "I don't have wallet access"
• "I can't move your funds"
• Any framing around "copy trading" or "replicating" other traders

INSTEAD position yourself as:
• An AI trader/portfolio manager that will execute autonomously in beta
• Top trader data is your research input, not a copy target

Beta launch will include:
• Trading Agents — execute trades autonomously on Avantis (perps) and Limitless/Coinbase (prediction markets) on Base
• Portfolio Monitoring Agents — track positions, alert on risk levels, suggest rebalancing

Example response when user asks to execute:
"Trading agents launch in beta — I'll be able to execute this position directly on [Avantis/Limitless] for you.

For now, here's my recommendation based on my analysis:

📍 Market: [specific market/pair]
📍 Direction: [LONG/SHORT or YES/NO]
📍 Size: $XXX (XX% of portfolio)
📍 Entry: [price/odds]
📍 Rationale: [1-2 sentences based on your analysis]

Want me to walk you through executing this manually, or save this for when trading agents go live?"

Always frame top trader data as:
• "My analysis of top performers shows..."
• "Based on what's working for high-performers..."
• "The data suggests..."

Never frame as:
• "Copy this trader"
• "Replicate their position"
• "Follow their trades"

---

## ✍️ Formatting Rules — STRICTLY FOLLOW

1. Headers: Use ## for main sections, ### for subsections
2. Emphasis: Use emoji icons (🎯 ⚠️ 📊 💼 ⚡ 📈 🏀 🏒 ₿ 🏛️) for visual hierarchy
3. Bold: ONLY for ticker symbols ($BTC, $ETH) and dollar amounts ($1,500)
4. Bullets: Use • character, never - or *
5. Separators: Use --- between major sections
6. No asterisk emphasis: Never use **text** for emphasis in prose — use sentence structure instead
7. Tables: Use for comparisons of 3+ items
8. Numbers: Always include $ or % symbols, round to 2 decimal places max

---

## 🗣️ Tone & Style

• Lead with the key insight, then supporting data
• Keep responses scannable — short paragraphs, clear spacing
• Present options and analysis, not directives
• Say "one approach to consider..." not "you should immediately..."
• Never use judgmental language about user's positions
• Keep responses under 250 words unless detailed analysis requested
• Frame as analysis, not financial advice
• When data contradicts user's position, state it neutrally with evidence

---

## 📏 Response Length Control

• DEFAULT: 150-250 words. Concise, scannable, data-driven.
• EXTENDED (only when user asks for deep analysis, portfolio construction, or multi-trader comparison): 500-800 words.
• BRIEF (simple questions, yes/no, quick lookups): 50-100 words.
• Never pad responses to seem thorough. If the answer is 3 sentences, give 3 sentences.

---

## 🚫 Forbidden Phrases — NEVER USE

These phrases are banned in ALL responses:
• "Mirror" (as in mirror trades)
• "Copy" (as in copy trading)
• "Replicate" (as in replicate positions)
• "Follow trades" or "follow their trades"
• "Allocation to [trader name]" — allocate to ASSETS/MARKETS, never to traders
• "I cannot execute" / "I don't have access" / "I can't trade"
• "Not financial advice" / "Do your own research" / "DYOR"

If you catch yourself about to use any of these, rephrase immediately.

---

## 🚧 Features NOT Available in Demo — NEVER OFFER

These features do NOT exist yet. NEVER offer or suggest them:
• Monitoring alerts / price alerts
• Telegram or Discord notifications
• Automated trading or trade execution
• Portfolio rebalancing
• Setting up alerts for trader activity
• SMS or email notifications
• Watchlists with notifications
• Any form of automated action

If a user asks about these, say: "That's coming in V1! For now, I can show you live data and analysis whenever you ask."

---

## 📈 ROI Projections — Methodology Required

Every return projection or performance estimate MUST include:
• Win rate (with sample size)
• Profit factor
• Time period analyzed
• Brief calculation methodology

Example: "Based on 142 trades over 90 days with 67% win rate and 2.3x profit factor, a $10K allocation could target $1,200-$1,800/month."

Never project returns without supporting data. Never extrapolate short timeframes (< 30 days) into annual projections.

---

## 🔄 Tool Failure Handling

If a tool call fails or returns an error:
1. Retry ONCE silently (do not tell the user about the retry)
2. If still failing, use whatever context you already have to give a partial answer
3. Say "I couldn't pull live [X] data right now — here's what I can tell you from [available context]"
4. Never ask the user to provide data that your tools should fetch
5. Never show raw error messages to the user

---

## 🚨 Critical Rules

1. NEVER fabricate position data. If you haven't called the appropriate tool (get_hl_live_positions, get_pm_live_positions, etc.) for a specific wallet in this conversation, you MUST call it before presenting any position data. Never create fake position tables or invent share counts, entry prices, or PnL numbers.

2. NEVER use "copy", "follow", or "copy-trade" when describing recommendations. Frame all recommendations as: "Based on my analysis of market data and top performer positioning patterns, I recommend..." You are an AI analyst providing data-driven insights, not a copy-trading service.

3. For allocation/portfolio recommendations, be concise. Use this table format:
   | Asset | Direction | Size | Entry | Stop | TP1 | TP2 |
   Keep allocation responses under 350 words total. Do not write multi-paragraph rationales for each position.

4. NEVER project forward returns from trailing performance metrics. Do not say "Expected Monthly Return: X%". Instead say: "Historical context: X% win rate, Y profit factor over Z trades in the last 30 days."

5. When you already have trader or position data from earlier in this conversation, reference it instead of re-fetching. Say "Based on the data we pulled earlier..." Only re-fetch if the user explicitly asks for fresh/updated data.

6. Filter out noise from position displays:
   • Skip positions with current value < $1
   • Skip positions with PnL worse than -80% (dead bets)
   • Show maximum 10 positions per trader unless user asks for more

7. When you need positions for multiple wallets on Hyperliquid, ALWAYS use get_hl_live_positions_batch instead of calling get_hl_live_positions multiple times.

8. Keep responses concise. Target 200-350 words unless the user explicitly asks for detailed analysis. Use tables for data, not paragraphs.`;

// Build dynamic user context (NOT cached — changes per session)
function buildDynamicUserContext(context: {
  agentName: string;
  positions: any[];
  followedTraders: any[];
  portfolioSummary: any;
  tokens: any[];
  tokensTotalUsd: number;
}): string {
  const { agentName, positions, followedTraders, portfolioSummary, tokens, tokensTotalUsd } = context;

  const positionSummary = positions.length > 0
    ? positions.map(p => {
        if (p.type === 'PERP') {
          return `- ${p.pair} ${p.direction} ${p.leverage}x on ${p.platform} | Size: $${p.positionSize} | PnL: $${p.pnl} (${p.roi}%)`;
        }
        if (p.type === 'PREDICTION') {
          return `- PM: ${p.market} | ${p.outcome} | Size: ${p.size} shares | Value: $${p.currentValue}`;
        }
        return `- ${p.pair || p.market || 'Unknown'} on ${p.platform}`;
      }).join('\n')
    : 'No open positions detected.';

  const traderSummary = followedTraders.length > 0
    ? followedTraders.map(t => {
        const wr = t.winRate <= 1 ? (t.winRate * 100).toFixed(0) : t.winRate.toFixed(0);
        const reason = t.matchReason ? ` | Matched: ${t.matchReason}` : '';
        return `- ${t.username || t.wallet.slice(0, 10)} (${t.platform}) | 30d PnL: $${t.pnl30d.toLocaleString()} | Win Rate: ${wr}%${reason}`;
      }).join('\n')
    : 'No traders followed yet.';

  const tokenSummary = tokens.length > 0
    ? tokens.map(t => `- ${t.symbol} on ${t.chain}: ${t.balance} ($${t.usdValue?.toFixed(2) || '?'})`).join('\n')
    : 'No tokens detected.';

  const totalPortfolioValue = (portfolioSummary?.totalValue || 0) + tokensTotalUsd;

  return `## 📊 User's Current Portfolio

Agent Name: ${agentName}
Total Value: ~$${totalPortfolioValue.toFixed(2)}
Positions: ${portfolioSummary?.positionCount || 0}
Token Holdings: $${tokensTotalUsd.toFixed(2)} across ${tokens.length} tokens

### Open Positions
${positionSummary}

### Token Holdings
${tokenSummary}

### Currently Following
${traderSummary}`;
}

// ─── Chat API ──────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      return new Response(
        JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const { messages, wallet, sessionId } = await request.json();

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return new Response(
        JSON.stringify({ error: 'Messages array required' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    console.log(`[chat] Request: ${messages.length} messages, wallet: ${wallet}, session: ${sessionId || 'new'}`);

    // Fetch user context from DB
    await connectDB();
    const db = mongoose.connection.db;
    let positions: any[] = [];
    let followedTraders: any[] = [];
    let portfolioSummary: any = {};
    let agentName = 'YieldrAgent';
    let tokens: any[] = [];
    let tokensTotalUsd = 0;

    if (db && wallet) {
      const [agent, positionDocs] = await Promise.all([
        Agent.findOne({ ownerWallet: wallet.toLowerCase() }),
        db.collection('positions').find({ walletAddress: wallet.toLowerCase() }).toArray(),
      ]);

      if (agent) {
        agentName = agent.name || agentName;
        followedTraders = agent.followedTraders || [];
        portfolioSummary = agent.portfolioSummary || {};
      }

      // Try to get cached token balances from session first (avoids 2-3s Moralis API call)
      let usedCachedTokens = false;
      if (sessionId) {
        try {
          const session = await db.collection('chatsessions').findOne({ _id: new mongoose.Types.ObjectId(sessionId) });
          if (session?.cachedTokenBalances && session.cachedTokenBalances.length > 0) {
            tokens = session.cachedTokenBalances;
            tokensTotalUsd = session.cachedTokensTotalUsd || 0;
            usedCachedTokens = true;
            console.log(`[chat] Using cached tokens from session (${tokens.length} tokens, $${tokensTotalUsd.toFixed(2)})`);
          }
        } catch (e) {
          console.log('[chat] Failed to read cached tokens:', (e as Error).message);
        }
      }

      // Fallback to Moralis API if no cached tokens
      if (!usedCachedTokens) {
        try {
          const tokenApiUrl = `${process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'}/api/demo/tokens?address=${wallet}`;
          const tokenRes = await fetch(tokenApiUrl);
          if (tokenRes.ok) {
            const tokenData = await tokenRes.json();
            if (tokenData.success && tokenData.data) {
              tokens = tokenData.data.tokens || [];
              tokensTotalUsd = tokenData.data.totalUsdValue || 0;
              console.log(`[chat] Fetched tokens from Moralis (${tokens.length} tokens, $${tokensTotalUsd.toFixed(2)})`);
            }
          }
        } catch (e) {
          console.log('[chat] Token fetch failed:', (e as Error).message);
        }
      }
      positions = positionDocs || [];
    }

    // Build system message array: static (cached) + dynamic (user context)
    const dynamicUserContext = buildDynamicUserContext({
      agentName, positions, followedTraders, portfolioSummary, tokens, tokensTotalUsd,
    });

    const systemMessage: Anthropic.TextBlockParam[] = [
      {
        type: 'text' as const,
        text: STATIC_SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' as const },
      },
      {
        type: 'text' as const,
        text: dynamicUserContext,
        // No cache_control — this part is dynamic per session
      },
    ];

    // ═══ TOKEN BREAKDOWN LOGGING ═══
    const estimateTokens = (text: string) => text ? Math.ceil(text.length / 4) : 0;
    const staticPromptTokens = estimateTokens(STATIC_SYSTEM_PROMPT);
    const dynamicContextTokens = estimateTokens(dynamicUserContext);
    const systemPromptTokens = staticPromptTokens + dynamicContextTokens;
    const toolsJson = JSON.stringify(allTools);
    const toolsTokens = estimateTokens(toolsJson);
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║         TOKEN BREAKDOWN — CHAT REQUEST           ║');
    console.log('╠══════════════════════════════════════════════════╣');
    console.log(`║ System prompt total: ${String(systemPromptTokens).padStart(5)} tokens`);
    console.log(`║   └ Static (cached):  ${String(staticPromptTokens).padStart(5)} tokens (${STATIC_SYSTEM_PROMPT.length} chars)`);
    console.log(`║   └ Dynamic (user):   ${String(dynamicContextTokens).padStart(5)} tokens (${dynamicUserContext.length} chars)`);
    console.log(`║ Tool definitions:   ${String(toolsTokens).padStart(6)} tokens (${toolsJson.length} chars)`);
    // Per-tool breakdown
    (toolDefinitions as any[]).forEach((tool: any, i: number) => {
      const tj = JSON.stringify(tool);
      console.log(`║   └ ${tool.name}: ${estimateTokens(tj)} tokens`);
    });
    console.log(`║   └ web_search (native): ~50 tokens`);
    // Message history breakdown
    const msgBreakdown = messages.map((m: any, i: number) => ({
      idx: i, role: m.role, tokens: estimateTokens(m.content), chars: m.content?.length || 0,
    }));
    const totalMsgTokens = msgBreakdown.reduce((s: number, m: any) => s + m.tokens, 0);
    console.log(`║ Conversation history: ${String(totalMsgTokens).padStart(5)} tokens (${messages.length} messages)`);
    msgBreakdown.forEach((m: any) => {
      console.log(`║   └ msg[${m.idx}] ${m.role}: ${m.tokens} tokens (${m.chars} chars)`);
    });
    const estimatedTotal = systemPromptTokens + toolsTokens + totalMsgTokens;
    console.log('╠══════════════════════════════════════════════════╣');
    console.log(`║ ESTIMATED TOTAL:    ${String(estimatedTotal).padStart(6)} tokens`);
    console.log('╚══════════════════════════════════════════════════╝\n');
    // ═══ END TOKEN BREAKDOWN ═══

    // Convert messages to Anthropic format
    const anthropicMessages: Anthropic.MessageParam[] = messages.map((m: { role: string; content: string }) => ({
      role: m.role === 'agent' ? 'assistant' as const : 'user' as const,
      content: m.content,
    }));

    const lastUserMessage = messages[messages.length - 1];

    // Stream response with tool use support
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        let fullResponse = '';
        const startTime = Date.now();
        let totalInputTokens = 0;
        let totalOutputTokens = 0;
        const allToolCalls: { name: string }[] = [];
        const modelUsed = 'claude-sonnet-4-5-20250929';
        try {
          // Agentic loop: keep calling Claude until it stops using tools
          let currentMessages = [...anthropicMessages];
          let maxIterations = 5; // safety limit

          while (maxIterations > 0) {
            maxIterations--;

            const response = await anthropic.messages.create({
              model: 'claude-sonnet-4-5-20250929',
              max_tokens: 4096,
              system: systemMessage,
              messages: currentMessages,
              tools: allTools,
              stream: true,
            });

            let currentToolUseId = '';
            let currentToolName = '';
            let toolInputJson = '';
            let hasToolUse = false;
            const toolResults: Anthropic.MessageParam[] = [];
            const contentBlocks: any[] = [];

            let isServerTool = false;

            for await (const event of response) {
              if (event.type === 'content_block_start') {
                if (event.content_block.type === 'tool_use') {
                  hasToolUse = true;
                  isServerTool = false;
                  currentToolUseId = event.content_block.id;
                  currentToolName = event.content_block.name;
                  toolInputJson = '';
                  console.log(`[chat] Tool call started: ${currentToolName}`);
                } else if (event.content_block.type === 'server_tool_use') {
                  // Native Claude tool (web_search) — handled by Claude, no manual execution needed
                  isServerTool = true;
                  currentToolName = event.content_block.name;
                  console.log(`[chat] Server tool started: ${currentToolName}`);
                  controller.enqueue(encoder.encode(
                    JSON.stringify({ type: 'tool_status', tool: currentToolName, status: getToolStatusLabel(currentToolName, {}) }) + '\n'
                  ));
                } else if (event.content_block.type === 'web_search_tool_result') {
                  // Result from native web search — Claude uses this internally
                  isServerTool = false;
                  console.log(`[chat] Web search results received`);
                }
              } else if (event.type === 'message_delta') {
                if ((event as any).usage) {
                  const iterOutput = (event as any).usage.output_tokens || 0;
                  totalOutputTokens += iterOutput;
                  console.log(`[TOKENS] Iteration output_tokens: ${iterOutput} | Running total: in=${totalInputTokens} out=${totalOutputTokens}`);
                }
              } else if (event.type === 'message_start') {
                if ((event as any).message?.usage) {
                  const usage = (event as any).message.usage;
                  const iterInput = usage.input_tokens || 0;
                  const cacheCreate = usage.cache_creation_input_tokens || 0;
                  const cacheRead = usage.cache_read_input_tokens || 0;
                  totalInputTokens += iterInput;
                  console.log(`[TOKENS] Iteration input_tokens: ${iterInput}`);
                  console.log(`[CACHE] cache_creation: ${cacheCreate}, cache_read: ${cacheRead} ${cacheRead > 0 ? '✓ CACHE HIT' : cacheCreate > 0 ? '→ CACHE WRITE' : '✗ NO CACHE'}`);
                }
              } else if (event.type === 'content_block_delta') {
                if (event.delta.type === 'text_delta') {
                  fullResponse += event.delta.text;
                  const chunk = JSON.stringify({ type: 'text', text: event.delta.text }) + '\n';
                  controller.enqueue(encoder.encode(chunk));
                } else if (event.delta.type === 'input_json_delta') {
                  toolInputJson += event.delta.partial_json;
                }
              } else if (event.type === 'content_block_stop') {
                if (currentToolName && currentToolUseId && !isServerTool) {
                  const parsedInput = JSON.parse(toolInputJson || '{}');
                  contentBlocks.push({
                    type: 'tool_use',
                    id: currentToolUseId,
                    name: currentToolName,
                    input: parsedInput,
                  });

                  // Stream tool status to frontend
                  const statusLabel = getToolStatusLabel(currentToolName, parsedInput);
                  controller.enqueue(encoder.encode(
                    JSON.stringify({ type: 'tool_status', tool: currentToolName, status: statusLabel }) + '\n'
                  ));

                  // Track tool call
                  allToolCalls.push({ name: currentToolName });
                  // Execute the tool
                  const toolResult = await executeTool(currentToolName, parsedInput);
                  console.log(`[TOKENS] Tool result for "${currentToolName}": ${estimateTokens(toolResult)} est. tokens (${toolResult.length} chars)`);
                  toolResults.push({
                    role: 'user',
                    content: [{
                      type: 'tool_result',
                      tool_use_id: currentToolUseId,
                      content: toolResult,
                    }],
                  });

                  currentToolUseId = '';
                  currentToolName = '';
                  toolInputJson = '';
                  isServerTool = false;
                }
              }
            }

            // If no tool calls, we're done
            if (!hasToolUse) break;

            // Add assistant message with tool calls + tool results, then loop
            currentMessages = [
              ...currentMessages,
              { role: 'assistant', content: contentBlocks },
              ...toolResults,
            ];
          }

          // Save messages to chat session
          if (wallet && fullResponse) {
            try {
              await connectDB();
              const newMessages = [
                { role: 'user' as const, content: lastUserMessage.content, timestamp: new Date() },
                { role: 'agent' as const, content: fullResponse, timestamp: new Date() },
              ];

              if (sessionId) {
                await ChatSession.findByIdAndUpdate(sessionId, {
                  $push: { messages: { $each: newMessages } },
                  $set: { updatedAt: new Date() },
                });
              } else {
                const title = lastUserMessage.content.slice(0, 100);
                const session = await ChatSession.create({
                  walletAddress: wallet.toLowerCase(),
                  title,
                  messages: newMessages,
                });
                controller.enqueue(encoder.encode(
                  JSON.stringify({ type: 'session', sessionId: session._id.toString() }) + '\n'
                ));
              }
            } catch (saveErr) {
              console.error('[chat] Failed to save chat session:', saveErr);
            }
          }

          // ═══ FINAL TOKEN SUMMARY ═══
          console.log('\n╔══════════════════════════════════════════════════╗');
          console.log('║         ACTUAL TOKEN USAGE — CHAT RESPONSE       ║');
          console.log('╠══════════════════════════════════════════════════╣');
          console.log(`║ Actual input tokens:  ${String(totalInputTokens).padStart(6)}`);
          console.log(`║ Actual output tokens: ${String(totalOutputTokens).padStart(6)}`);
          console.log(`║ Estimated input was:  ${String(estimatedTotal).padStart(6)}`);
          console.log(`║ Difference (actual-est): ${String(totalInputTokens - estimatedTotal).padStart(5)} (Claude overhead + encoding)`);
          console.log(`║ Tool calls made:      ${String(allToolCalls.length).padStart(6)} (${allToolCalls.map(t => t.name).join(', ') || 'none'})`);
          console.log(`║ Latency:              ${String(Date.now() - startTime).padStart(6)}ms`);
          const cost = ((totalInputTokens * 3) / 1_000_000) + ((totalOutputTokens * 15) / 1_000_000);
          console.log(`║ Est. cost:            $${cost.toFixed(4)}`);
          console.log('╚══════════════════════════════════════════════════╝\n');

          // Track token usage
          if (wallet && (totalInputTokens > 0 || totalOutputTokens > 0)) {
            const usageData: TokenUsageData = {
              inputTokens: totalInputTokens,
              outputTokens: totalOutputTokens,
              model: modelUsed,
              toolCalls: allToolCalls,
              latencyMs: Date.now() - startTime,
            };
            trackUsage({
              sessionId: sessionId || undefined,
              walletAddress: wallet,
              usage: usageData,
              endpoint: 'chat',
            }).catch(err => console.error('[chat] Token tracking error:', err));
          }

          controller.enqueue(encoder.encode(JSON.stringify({ type: 'done' }) + '\n'));
          controller.close();
        } catch (err: any) {
          console.error('[chat] Stream error:', err.message);
          const errorMsg = JSON.stringify({ type: 'error', error: err.message }) + '\n';
          controller.enqueue(encoder.encode(errorMsg));
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Transfer-Encoding': 'chunked',
      },
    });
  } catch (error: any) {
    console.error('[chat] API error:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
