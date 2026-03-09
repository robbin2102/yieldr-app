import { NextRequest } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import connectDB from '@/lib/mongoose';
import mongoose from 'mongoose';
import Agent from '@/models/Agent';
import ChatSession from '@/models/ChatSession';
import { trackUsage, TokenUsageData } from '@/lib/tokenTracking';
import { fetchNews, formatArticlesForLLM } from '@/lib/rss';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || '',
});

const HYPERLIQUID_API_URL = 'https://api.hyperliquid.xyz/info';
const POLYMARKET_API_BASE = 'https://data-api.polymarket.com';
const AVANTIS_API_URL = 'https://yieldr-app-production.up.railway.app/fetch-positions';
const BASE_RPC_URL = process.env.QUICKNODE_BASE_RPC_URL || process.env.BASE_RPC_URL || 'https://mainnet.base.org';

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

// ─── Claude API Retry Helper ─────────────────────────────────────────────────
async function callClaudeWithRetry<T>(
  apiCall: () => Promise<T>,
  maxRetries = 3,
  baseDelay = 1000
): Promise<T> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await apiCall();
    } catch (err: any) {
      lastError = err;
      // Check if it's an overloaded error (529)
      const isOverloaded = err.status === 529 ||
                           err.message?.includes('overloaded') ||
                           err.message?.includes('Overloaded') ||
                           err.error?.type === 'overloaded_error';

      if (isOverloaded && attempt < maxRetries - 1) {
        const delay = baseDelay * Math.pow(2, attempt);
        console.log(`[CLAUDE RETRY] Overloaded, attempt ${attempt + 1}/${maxRetries}, waiting ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else if (!isOverloaded) {
        // Don't retry non-overload errors
        throw err;
      }
    }
  }
  throw lastError || new Error('Claude API max retries exceeded');
}

// Helper to format Claude errors for user display
function formatClaudeError(err: any): string {
  if (err.status === 529 || err.error?.type === 'overloaded_error') {
    return "I'm experiencing high demand right now. Please try again in a moment.";
  }
  if (err.status === 401) {
    return "Authentication error. Please contact support.";
  }
  if (err.status === 400) {
    return "I encountered an issue processing your request. Please try rephrasing.";
  }
  return "Something went wrong. Please try again.";
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
  {
    name: 'get_market_snapshot',
    description: 'Get latest technical indicators + derivatives data for a tracked coin from MongoDB. Returns price OHLCV, EMA/SMA (8/21/50/200), RSI, MACD, ADX, Bollinger Bands, Ichimoku, Supertrend, funding rate, open interest, long/short ratios, CVD, liquidations, taker buy/sell, and computed signals. Data refreshes every 1H. Use fields param to limit response size.',
    input_schema: {
      type: 'object' as const,
      properties: {
        symbol: { type: 'string', description: 'Coin symbol, e.g. BTC, ETH, SOL' },
        fields: {
          type: 'string',
          enum: ['price', 'indicators', 'derivatives', 'computed', 'candlestick_patterns', 'all'],
          description: 'Which fields to return. Default: all. Use specific fields to limit response size.',
        },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'fetch_live_indicator',
    description: 'Fetch real-time indicator values from TAAPI for any coin. Use when the MongoDB snapshot is stale (data_age_minutes > 60) or user asks for current/live values. Fetches all 18 core indicators by default (EMA 8/21/50/200, SMA 50/200, RSI, MACD, StochRSI, ADX, BBands, ATR, VWAP, OBV, CMF, Ichimoku, Supertrend, Pivots), or specific ones if provided.',
    input_schema: {
      type: 'object' as const,
      properties: {
        symbol: { type: 'string', description: 'Coin symbol without /USDT, e.g. BTC, ETH, SOL' },
        indicators: {
          type: 'array',
          items: { type: 'string' },
          description: 'Specific indicators, e.g. ["rsi", "macd", "ema_21"]. For EMAs/SMAs use format "ema_8", "sma_50". Omit to fetch all 18 core indicators.',
        },
        timeframe: { type: 'string', description: 'Candle timeframe: 1m, 5m, 15m, 1h, 4h, 1d. Default: 1h' },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'get_macro_snapshot',
    description: 'Get daily macro data: BTC + ETH ETF flows (total + by ticker), ETF net assets, Coinbase premium index (BTC + ETH), Fear & Greed index (0-100 + classification), and stablecoin market cap. Updated daily at 10:00 UTC. Use for macro context when analyzing any coin setup or market conditions.',
    input_schema: {
      type: 'object' as const,
      properties: {
        days: { type: 'number', description: 'Number of days to return (default: 1, max: 30)' },
      },
    },
  },
  {
    name: 'get_funding_rate_history',
    description: 'Get settled 8h funding rate history for a coin from Binance Futures (up to 30 days). NOTE: requires the binance-fetcher service to have data — if it returns found:false, fall back to get_market_snapshot which always has funding rate in derivatives.funding_rate. Prefer get_market_snapshot for most funding rate queries. Only use this tool when the user specifically needs a multi-day funding rate time-series or trend analysis.',
    input_schema: {
      type: 'object' as const,
      properties: {
        symbol: { type: 'string', description: 'Coin symbol, e.g. BTC, ETH, SOL (no USDT suffix)' },
        hours: { type: 'number', description: 'Lookback window in hours. Default: 24. Max: 720 (30 days).' },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'get_derivatives_history',
    description: 'Get 15-minute open interest + long/short ratio history for a coin from Binance Futures (up to 7 days). Returns OI in USDT with 4h and 24h % change, plus three L/S ratio views: global retail accounts, top trader accounts, and top trader positions. Each L/S view includes current long/short %, ratio, average over period, and bias label (longs_dominant / shorts_dominant / balanced). Use when analyzing positioning, OI trends, or sentiment divergence between retail and smart money. Symbol is just the coin name (BTC, ETH, SOL) — no USDT suffix.',
    input_schema: {
      type: 'object' as const,
      properties: {
        symbol: { type: 'string', description: 'Coin symbol, e.g. BTC, ETH, SOL (no USDT suffix)' },
        hours: { type: 'number', description: 'Lookback window in hours. Default: 24. Max: 168 (7 days).' },
        include: {
          type: 'array',
          items: { type: 'string', enum: ['oi', 'ls_global', 'ls_top_accounts', 'ls_top_positions'] },
          description: 'Which fields to include. Omit for all. Use ["oi"] for OI-only, ["ls_global","ls_top_accounts"] for L/S only.',
        },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'manage_monitoring',
    description: 'Create, list, update, pause, resume, or delete persistent monitoring tasks that run on a schedule. Each task calls MCP tools each cycle, extracts key fields, and uses an LLM evaluator to decide whether to alert. Use when a user asks to monitor market data, funding rates, RSI/indicators, trader activity, or position changes. ALWAYS call the relevant data tool(s) first to verify the exact field paths before creating a monitor.',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string' as const,
          enum: ['create', 'list', 'get', 'update', 'pause', 'resume', 'delete'],
          description: 'Operation to perform',
        },
        taskId: { type: 'string', description: 'Required for get/update/pause/resume/delete' },
        task: { type: 'string', description: 'Short title, e.g. "ETH RSI oversold monitor"' },
        monitorInstruction: { type: 'string', description: 'Detailed natural-language instruction for the evaluator LLM — what to watch, thresholds, severity. Be specific with numbers. The evaluator only sees the extracted fields + last 5 cycles + user positions.' },
        tools: {
          type: 'array' as const,
          description: 'Tools to call each cycle (max 5). extractFields are dot-path strings into the tool response (e.g. "stats.avg_24h"). Keep minimal — each field adds to per-cycle token cost. Use [*] wildcard for arrays.',
          items: {
            type: 'object' as const,
            properties: {
              toolName: { type: 'string' },
              toolParams: { type: 'object' },
              extractFields: { type: 'array', items: { type: 'string' } },
            },
          },
        },
        intervalSeconds: { type: 'number', description: 'Check interval in seconds. Minimum 300 (5 minutes).' },
        updates: { type: 'object', description: 'For action=update: fields to change (task, monitorInstruction, tools, intervalSeconds, status)' },
      },
      required: ['action'],
    },
  },
];

// ─── RSS News tool ───────────────────────────────────────────────────────────
toolDefinitions.push({
  name: 'get_news_headlines',
  description: 'Fetch the latest news headlines from 5 live RSS feeds (BBC World, Al Jazeera, Sky News, NPR World, CoinTelegraph). Returns top 2-3 articles per source with title, clickable URL, source, recency (age), and a short snippet. Use for macro/geopolitical context, market-moving events, or when a user asks about news affecting a position or asset. Supports keyword filtering (topics param) and source type filtering (geo=world news, crypto=crypto news, all=both). Token-optimised — each call returns at most 15 articles.',
  input_schema: {
    type: 'object' as const,
    properties: {
      topics: {
        type: 'string',
        description: 'Comma-separated keywords to filter headlines, e.g. "iran,oil,sanctions" or "bitcoin,etf,sec". Omit for top headlines.',
      },
      sourceTypes: {
        type: 'string',
        enum: ['geo', 'crypto', 'all'],
        description: '"geo" for world/geopolitical news (BBC, AJZ, Sky, NPR), "crypto" for crypto news (CoinTelegraph), "all" for both. Default: all.',
      },
      limitPerFeed: {
        type: 'number',
        description: 'Max articles per RSS source (default: 3, max: 5). Keep at 2-3 to save tokens.',
      },
      maxAgeMinutes: {
        type: 'number',
        description: 'Only include articles published in the last N minutes (default: 1440 = 24h). Use 120 for last 2h only.',
      },
    },
  },
});

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
    case 'get_market_snapshot':
      return `Fetching ${input.symbol?.toUpperCase()} market snapshot...`;
    case 'fetch_live_indicator':
      return `Fetching live ${input.indicators?.join(', ') || 'indicators'} for ${input.symbol?.toUpperCase()}...`;
    case 'get_macro_snapshot':
      return `Loading macro data (ETF flows, Fear & Greed, Coinbase premium)...`;
    case 'get_funding_rate_history':
      return `Fetching ${input.hours || 24}h funding rate history for ${input.symbol?.toUpperCase()}...`;
    case 'get_derivatives_history':
      return `Fetching ${input.hours || 24}h OI + L/S data for ${input.symbol?.toUpperCase()}...`;
    case 'manage_monitoring': {
      const actionLabels: Record<string, string> = {
        create: 'Creating monitoring task...',
        list:   'Loading your monitors...',
        get:    'Loading monitor details...',
        update: 'Updating monitor...',
        pause:  'Pausing monitor...',
        resume: 'Resuming monitor...',
        delete: 'Deleting monitor...',
      };
      return actionLabels[input.action] || 'Managing monitor...';
    }
    case 'get_news_headlines': {
      const src = input.sourceTypes === 'geo' ? 'world' : input.sourceTypes === 'crypto' ? 'crypto' : 'world + crypto';
      return input.topics
        ? `Scanning ${src} news for "${input.topics}"...`
        : `Fetching latest ${src} headlines...`;
    }
    case 'web_search':
      return `Searching the web...`;
    default:
      return `Running ${name}...`;
  }
}

// ─── Tool Execution ────────────────────────────────────────────────────────

async function executeTool(name: string, input: any, wallet?: string): Promise<string> {
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
      case 'get_market_snapshot': {
        await connectDB();
        const db = mongoose.connection.db!;
        const { symbol, fields = 'all' } = input;
        const projection: Record<string, 1> = {
          symbol: 1, timestamp: 1, interval: 1, tier: 1,
          fetched_on_demand: 1, on_demand_expires_at: 1, fetch_duration_ms: 1, errors: 1,
        };
        if (fields === 'all' || fields === 'price') projection.price = 1;
        if (fields === 'all' || fields === 'indicators') projection.indicators = 1;
        if (fields === 'all' || fields === 'derivatives') projection.derivatives = 1;
        if (fields === 'all' || fields === 'computed') projection.computed = 1;
        if (fields === 'all' || fields === 'candlestick_patterns') projection.candlestick_patterns = 1;
        const snap = await db.collection('market_snapshots').findOne(
          { symbol: symbol.toUpperCase() },
          { sort: { timestamp: -1 }, projection }
        );
        if (!snap) {
          return JSON.stringify({ found: false, symbol: symbol.toUpperCase(), message: `No snapshot found for ${symbol}. Cron may not have run yet.` });
        }
        const ageMs = Date.now() - new Date(snap.timestamp).getTime();
        const activePatterns = (snap.candlestick_patterns as any[] | undefined)?.filter((p: any) => p.value !== 0) ?? [];
        return JSON.stringify({
          found: true, symbol: snap.symbol, timestamp: snap.timestamp,
          data_age_minutes: Math.round(ageMs / 60000), tier: snap.tier,
          ...(snap.price && { price: snap.price }),
          ...(snap.indicators && { indicators: snap.indicators }),
          ...(snap.derivatives && { derivatives: snap.derivatives }),
          ...(snap.computed && { computed: snap.computed }),
          ...(activePatterns.length && { candlestick_patterns: activePatterns }),
        });
      }
      case 'fetch_live_indicator': {
        const apiKey = process.env.TAAPI_API_KEY;
        if (!apiKey) throw new Error('TAAPI_API_KEY not configured');
        const { symbol, indicators, timeframe = '1h' } = input;
        const CORE: Record<string, any>[] = [
          { indicator: 'ema', period: 8 }, { indicator: 'ema', period: 21 },
          { indicator: 'ema', period: 50 }, { indicator: 'ema', period: 200 },
          { indicator: 'sma', period: 50 }, { indicator: 'sma', period: 200 },
          { indicator: 'rsi' }, { indicator: 'macd' }, { indicator: 'stochrsi' },
          { indicator: 'adx' }, { indicator: 'bbands' }, { indicator: 'atr', period: 14 },
          { indicator: 'vwap' }, { indicator: 'obv' }, { indicator: 'cmf' },
          { indicator: 'ichimoku' }, { indicator: 'supertrend' }, { indicator: 'pivot_points' },
        ];
        const parseInd = (ind: string) => {
          const m = ind.match(/^([a-z]+)_(\d+)$/);
          return m ? { indicator: m[1], period: parseInt(m[2]) } : { indicator: ind };
        };
        const indicatorList = indicators?.length ? indicators.map(parseInd) : CORE;
        const results: Record<string, any> = {};
        for (let i = 0; i < indicatorList.length; i += 20) {
          const chunk = indicatorList.slice(i, i + 20);
          const res = await fetch('https://api.taapi.io/bulk', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              secret: apiKey,
              construct: { exchange: 'binancefutures', symbol: `${symbol.toUpperCase()}/USDT`, interval: timeframe, indicators: chunk },
            }),
          });
          if (!res.ok) throw new Error(`TAAPI error ${res.status}: ${await res.text()}`);
          const data = await res.json() as { data?: any[] };
          for (const item of (data.data || [])) {
            const key = item.indicator + (item.period != null ? `_${item.period}` : '');
            results[key] = item.result ?? item.errors ?? null;
          }
        }
        return JSON.stringify({ symbol: symbol.toUpperCase(), timeframe, fetched_at: new Date().toISOString(), source: 'TAAPI real-time', indicators: results });
      }
      case 'get_macro_snapshot': {
        await connectDB();
        const db = mongoose.connection.db!;
        const limit = Math.min(input.days || 1, 30);
        const docs = await db.collection('macro_daily').find({}).sort({ date: -1 }).limit(limit).toArray();
        if (!docs.length) return JSON.stringify({ found: false, message: 'No macro data yet. Daily cron runs at 10:00 UTC.' });
        const ageHours = Math.round((Date.now() - new Date(docs[0].date).getTime()) / 3600000);
        return JSON.stringify({
          found: true, data_age_hours: ageHours, days_returned: docs.length,
          macro: docs.map(d => ({
            date: d.date, fear_greed: d.fear_greed,
            btc_etf: { total_flow_usd: d.btc_etf?.total_flow_usd, net_assets_usd: d.btc_etf?.net_assets_usd, top_flows: (d.btc_etf?.flows_by_ticker ?? []).slice(0, 5) },
            eth_etf: { total_flow_usd: d.eth_etf?.total_flow_usd, net_assets_usd: d.eth_etf?.net_assets_usd, top_flows: (d.eth_etf?.flows_by_ticker ?? []).slice(0, 5) },
            coinbase_premium: d.coinbase_premium,
            stablecoin_mcap: d.stablecoin_mcap,
          })),
        });
      }
      case 'get_funding_rate_history': {
        await connectDB();
        const db = mongoose.connection.db!;
        const { symbol, hours = 24 } = input;
        const since = new Date(Date.now() - hours * 60 * 60 * 1000);
        const records = await db.collection('binance_funding_1h')
          .find(
            { symbol: symbol.toUpperCase(), timestamp: { $gte: since } },
            { sort: { timestamp: 1 }, projection: { _id: 0, timestamp: 1, funding_rate: 1, annualized_rate: 1 } }
          )
          .toArray();
        if (records.length === 0) {
          return JSON.stringify({ found: false, symbol: symbol.toUpperCase(), message: `No funding rate history for ${symbol.toUpperCase()} in the last ${hours}h. Symbol may not trade on Binance Futures.` });
        }
        const rates = records.map((r: any) => r.funding_rate);
        const latest = records[records.length - 1] as any;
        const computeAvg = (nums: number[]) => nums.length ? nums.reduce((s, n) => s + n, 0) / nums.length : null;
        const third = Math.floor(rates.length / 3);
        const avgFirst = computeAvg(rates.slice(0, third));
        const avgLast  = computeAvg(rates.slice(-third));
        const trend = avgFirst && avgLast
          ? (avgLast > avgFirst * 1.1 ? 'rising' : avgLast < avgFirst * 0.9 ? 'falling' : 'flat')
          : 'flat';
        return JSON.stringify({
          found: true, symbol: symbol.toUpperCase(), hours_requested: hours, records_found: records.length,
          history: records,
          stats: {
            current: latest.funding_rate,
            current_annualized_pct: latest.annualized_rate,
            avg_24h: computeAvg(records.slice(-24).map((r: any) => r.funding_rate)),
            avg_period: computeAvg(rates),
            avg_7d: rates.length >= 168 ? computeAvg(records.slice(-168).map((r: any) => r.funding_rate)) : computeAvg(rates),
            min_period: Math.min(...rates),
            max_period: Math.max(...rates),
            trend,
          },
        });
      }
      case 'get_derivatives_history': {
        await connectDB();
        const db = mongoose.connection.db!;
        const { symbol, hours = 24, include = ['oi', 'ls_global', 'ls_top_accounts', 'ls_top_positions'] } = input;
        const since = new Date(Date.now() - hours * 60 * 60 * 1000);
        const includeSet = new Set(include as string[]);
        const projection: Record<string, 1 | 0> = { _id: 0, timestamp: 1 };
        if (includeSet.has('oi'))               projection.open_interest_usdt = 1;
        if (includeSet.has('ls_global'))        projection.long_short_global = 1;
        if (includeSet.has('ls_top_accounts'))  projection.long_short_top_accounts = 1;
        if (includeSet.has('ls_top_positions')) projection.long_short_top_positions = 1;
        const records = await db.collection('binance_derivatives_15m')
          .find(
            { symbol: symbol.toUpperCase(), timestamp: { $gte: since } },
            { sort: { timestamp: 1 }, projection }
          )
          .toArray();
        if (records.length === 0) {
          return JSON.stringify({ found: false, symbol: symbol.toUpperCase(), message: `No derivatives history for ${symbol.toUpperCase()} in the last ${hours}h.` });
        }
        const latest = records[records.length - 1] as any;
        const lsStats = (field: string) => {
          const vals = records.map((r: any) => r[field]).filter((v: any) => v?.long_pct != null);
          if (!vals.length) return null;
          const lv = vals[vals.length - 1] as any;
          return {
            current: { long_pct: lv.long_pct, short_pct: lv.short_pct, ratio: lv.ratio },
            avg_long_pct:  vals.reduce((s: number, v: any) => s + v.long_pct, 0) / vals.length,
            avg_short_pct: vals.reduce((s: number, v: any) => s + v.short_pct, 0) / vals.length,
            bias: lv.long_pct > 55 ? 'longs_dominant' : lv.short_pct > 55 ? 'shorts_dominant' : 'balanced',
          };
        };
        let oiStats = null;
        if (includeSet.has('oi')) {
          const oiVals = records.map((r: any) => r.open_interest_usdt).filter((v: any) => v != null) as number[];
          if (oiVals.length) {
            const prev4h  = records[Math.max(0, records.length - 17)] as any;
            const prev24h = records[Math.max(0, records.length - 97)] as any;
            const cur = latest.open_interest_usdt ?? null;
            oiStats = {
              current_usdt: cur,
              change_4h_pct:  cur && prev4h?.open_interest_usdt ? ((cur - prev4h.open_interest_usdt) / prev4h.open_interest_usdt * 100) : null,
              change_24h_pct: cur && prev24h?.open_interest_usdt ? ((cur - prev24h.open_interest_usdt) / prev24h.open_interest_usdt * 100) : null,
              min_usdt: Math.min(...oiVals), max_usdt: Math.max(...oiVals),
            };
          }
        }
        return JSON.stringify({
          found: true, symbol: symbol.toUpperCase(), hours_requested: hours,
          records_found: records.length, interval: '15m',
          history: records,
          latest: {
            timestamp: latest.timestamp,
            open_interest_usdt: latest.open_interest_usdt ?? null,
            long_short_global: latest.long_short_global ?? null,
            long_short_top_accounts: latest.long_short_top_accounts ?? null,
            long_short_top_positions: latest.long_short_top_positions ?? null,
          },
          stats: {
            ...(oiStats ? { open_interest: oiStats } : {}),
            ...(includeSet.has('ls_global')        ? { long_short_global: lsStats('long_short_global') } : {}),
            ...(includeSet.has('ls_top_accounts')  ? { long_short_top_accounts: lsStats('long_short_top_accounts') } : {}),
            ...(includeSet.has('ls_top_positions') ? { long_short_top_positions: lsStats('long_short_top_positions') } : {}),
          },
        });
      }
      case 'get_news_headlines': {
        const articles = await fetchNews({
          topics: input.topics,
          sourceTypes: input.sourceTypes ?? 'all',
          limitPerFeed: Math.min(input.limitPerFeed ?? 3, 5),
          maxAgeMinutes: input.maxAgeMinutes ?? 1440,
        });
        return formatArticlesForLLM(articles);
      }

      case 'manage_monitoring': {
        if (!wallet) return JSON.stringify({ error: 'No wallet in session — cannot manage monitors' });
        await connectDB();
        const db2 = mongoose.connection.db!;
        const tasksCol = db2.collection('monitoring_tasks');
        const { action, taskId, task, monitorInstruction, tools: monTools, intervalSeconds, updates } = input;

        if (action === 'list') {
          const docs = await tasksCol
            .find({ userId: wallet.toLowerCase() }, { projection: { cycleHistory: 0 } })
            .sort({ createdAt: -1 })
            .toArray();
          return JSON.stringify({
            count: docs.length,
            tasks: docs.map(d => ({
              taskId: d._id.toString(),
              agentId: d.agentId,
              agentName: d.agentName,
              task: d.task,
              status: d.status,
              intervalSeconds: d.intervalSeconds,
              nextRunAt: d.nextRunAt,
              lastRunAt: d.lastRunAt,
              cycleCount: d.cycleCount,
              alertCount: d.alertCount,
              lastError: d.lastError,
            })),
          });
        }

        if (action === 'get') {
          if (!taskId) return JSON.stringify({ error: 'taskId required for get' });
          const { ObjectId } = await import('mongodb');
          const doc = await tasksCol.findOne({ _id: new ObjectId(taskId), userId: wallet.toLowerCase() });
          if (!doc) return JSON.stringify({ error: 'Task not found' });
          return JSON.stringify({ ...doc, _id: doc._id.toString(), taskId: doc._id.toString() });
        }

        if (action === 'pause') {
          if (!taskId) return JSON.stringify({ error: 'taskId required for pause' });
          const { ObjectId } = await import('mongodb');
          await tasksCol.updateOne(
            { _id: new ObjectId(taskId), userId: wallet.toLowerCase() },
            { $set: { status: 'paused', updatedAt: new Date() } }
          );
          return JSON.stringify({ ok: true, taskId, status: 'paused' });
        }

        if (action === 'resume') {
          if (!taskId) return JSON.stringify({ error: 'taskId required for resume' });
          const { ObjectId } = await import('mongodb');
          const doc = await tasksCol.findOne({ _id: new ObjectId(taskId), userId: wallet.toLowerCase() });
          if (!doc) return JSON.stringify({ error: 'Task not found' });
          const nextRunAt = new Date(Date.now() + (doc.intervalSeconds || 3600) * 1000);
          await tasksCol.updateOne(
            { _id: new ObjectId(taskId) },
            { $set: { status: 'active', nextRunAt, updatedAt: new Date() } }
          );
          return JSON.stringify({ ok: true, taskId, status: 'active', nextRunAt });
        }

        if (action === 'delete') {
          if (!taskId) return JSON.stringify({ error: 'taskId required for delete' });
          const { ObjectId } = await import('mongodb');
          const delResult = await tasksCol.deleteOne({ _id: new ObjectId(taskId), userId: wallet.toLowerCase() });
          if (delResult.deletedCount === 0) return JSON.stringify({ error: 'Monitor not found or not owned by you' });
          return JSON.stringify({ ok: true, taskId, deleted: true });
        }

        if (action === 'update') {
          if (!taskId) return JSON.stringify({ error: 'taskId required for update' });
          const { ObjectId } = await import('mongodb');
          const allowed = ['task', 'monitorInstruction', 'tools', 'intervalSeconds', 'status'];
          const patch: Record<string, any> = { updatedAt: new Date() };
          for (const k of allowed) {
            if (updates?.[k] !== undefined) patch[k] = updates[k];
          }
          if (patch.intervalSeconds) {
            patch.nextRunAt = new Date(Date.now() + patch.intervalSeconds * 1000);
          }
          await tasksCol.updateOne({ _id: new ObjectId(taskId), userId: wallet.toLowerCase() }, { $set: patch });
          return JSON.stringify({ ok: true, taskId, updated: Object.keys(patch) });
        }

        if (action === 'create') {
          if (!task || !monitorInstruction || !monTools || !intervalSeconds) {
            return JSON.stringify({ error: 'task, monitorInstruction, tools, and intervalSeconds are required for create' });
          }
          if (intervalSeconds < 300) {
            return JSON.stringify({ error: 'intervalSeconds must be at least 300 (5 minutes)' });
          }
          if (monTools.length > 5) {
            return JSON.stringify({ error: 'Maximum 5 tools per monitor' });
          }

          // Check active monitor limit
          const activeCount = await tasksCol.countDocuments({ userId: wallet.toLowerCase(), status: 'active' });
          if (activeCount >= 10) {
            return JSON.stringify({ error: 'Maximum 10 active monitors reached. Pause or delete an existing monitor first.' });
          }

          // Look up agent for agentId and agentName
          const agent = await Agent.findOne({ ownerWallet: wallet.toLowerCase() });
          const agentId = agent?.agentId || `agent-${wallet.slice(2, 8).toLowerCase()}`;
          const agentName = agent?.name || 'Yieldr Agent';

          const now = new Date();
          const doc = {
            userId:             wallet.toLowerCase(),
            agentId,
            agentName,
            task,
            monitorInstruction,
            tools:              monTools,
            intervalSeconds,
            status:             'active' as const,
            nextRunAt:          new Date(Date.now() + intervalSeconds * 1000),
            lastRunAt:          null,
            lastAlertAt:        null,
            alertCount:         0,
            cycleCount:         0,
            errorCount:         0,
            lastError:          null,
            cycleHistory:       [],
            createdAt:          now,
            updatedAt:          now,
          };

          const result = await tasksCol.insertOne(doc);
          return JSON.stringify({
            ok: true,
            taskId: result.insertedId.toString(),
            agentId,
            agentName,
            task,
            status: 'active',
            nextRunAt: doc.nextRunAt,
            intervalSeconds,
            message: `Monitor created. First cycle runs in ${Math.round(intervalSeconds / 60)} minutes. First cycle records baseline only — alerts start from cycle 2.`,
          });
        }

        return JSON.stringify({ error: `Unknown action: ${action}` });
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
• get_market_snapshot — Latest TAAPI + CoinGlass snapshot for any coin (technicals + derivatives incl. funding rate, OI, L/S ratios) — PRIMARY tool for all market data including funding rates
• fetch_live_indicator — Real-time TAAPI indicators when snapshot is stale
• get_macro_snapshot — Daily macro: ETF flows, Fear & Greed, Coinbase premium
• get_funding_rate_history — Settled 8h Binance funding rate time-series (use only for multi-day trend history; may return no data if binance-fetcher is down — always fall back to get_market_snapshot)
• get_derivatives_history — 15m OI + long/short ratio history from Binance (up to 7 days)
• get_news_headlines — Live RSS headlines from BBC, Al Jazeera, Sky News, NPR, CoinTelegraph with clickable links. Filter by topics (e.g. "iran,oil") or sourceTypes (geo/crypto/all). Use for macro context, market-moving events, or when news could impact a position.
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

## 🔔 Monitoring

You can create persistent monitoring tasks that run on a schedule. When a user asks to monitor something, follow this flow:

### Step 1: Understand What to Monitor
Ask clarifying questions. Don't assume. Examples:
• "Which indicator matters most — RSI, funding rate, OI change, or something else?"
• "What threshold should trigger the alert?"
• "How often should I check — every hour, every 4 hours?"

### Step 2: Call the Relevant Tool(s) to See the Data
ALWAYS call the relevant tool(s) first to verify exact field paths before structuring the task.
This lets you confirm dot-paths for extractFields and show the user current values.

### Step 3: Structure the Task
Based on the conversation and tool response, build:
• task: short title
• monitorInstruction: specific, number-anchored instruction for the evaluator. Be explicit about thresholds and severity. The evaluator ONLY sees the extracted fields + last 5 cycles + user positions.
• tools: which tools to call each cycle (max 5), with toolName, toolParams, and extractFields (dot-paths, keep minimal)
• intervalSeconds: minimum 300

### Step 4: Confirm with the User
Show: what's monitored, which fields, what triggers alerts, interval, current values.

### Step 5: Create
Call manage_monitoring with action "create" after user confirms.

### Correct Field Paths by Tool

**get_market_snapshot** (symbol, fields: "indicators"|"derivatives"|"all") — USE THIS for funding rate, OI, and all standard monitoring tasks:
• indicators.rsi_14 / macd / bbands / ema_8 / ema_21 / ema_50 / adx / stoch_rsi / atr_14
• derivatives.funding_rate.current / annualized — ← USE THIS for funding rate queries
• derivatives.open_interest.total_usd / change_4h_pct / change_24h_pct
• derivatives.long_short_ratio.global_accounts / top_accounts / top_positions
• computed.trend_score / momentum_score / volatility_regime

**get_derivatives_history** (symbol, hours, include?) — use when user needs OI/L/S trend over hours/days:
• stats.open_interest.current_usdt / change_4h_pct / change_24h_pct
• stats.long_short_global.current.long_pct / .short_pct / .ratio / avg_long_pct / bias
• stats.long_short_top_accounts.* (same structure)
• stats.long_short_top_positions.* (same structure)
• latest.open_interest_usdt / long_short_global / long_short_top_accounts / long_short_top_positions

**get_funding_rate_history** (symbol, hours) — SECONDARY: only for multi-day funding history; may return found:false if binance-fetcher has no data — fall back to get_market_snapshot:
• stats.latest_predicted_rate / stats.latest_predicted_annualized_pct
• stats.avg_24h / stats.avg_7d / stats.trend / stats.min_period / stats.max_period

**get_top_perp_traders** (protocol, sortBy, limit):
• traders[*].wallet / pnl.month / winRate / openPositions / accountValue

**get_hl_live_positions_batch** (walletAddresses: [], limit):
• wallets[*].wallet / wallets[*].positions[*].coin / .side / .size / .unrealizedPnl / .leverage
• Note: set walletAddresses: [] for tool chaining — scheduler fills it from the previous tool's output

### Constraints
• Minimum interval: 300 seconds (5 minutes)
• Max 5 tools per task
• Max 10 active monitors per user
• Keep extractFields minimal — each field adds per-cycle token cost
• First cycle always records baseline, never alerts

### When You Can't Monitor Something
If the user asks for news, web data, or non-indexed data: be honest ("I don't have a tool for that yet"), suggest the closest achievable monitor, and explain we'll update tooling soon.

---

## 🚧 Features NOT Available in Demo — NEVER OFFER

These features do NOT exist yet. NEVER offer or suggest them:
• Telegram or Discord notifications
• Automated trading or trade execution
• Portfolio rebalancing
• SMS or email notifications
• Any form of automated action

If a user asks about these, say: "That's coming in V1! For now, I can monitor market conditions and alert you in the chat."

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

8. Keep responses concise. Target 200-350 words unless the user explicitly asks for detailed analysis. Use tables for data, not paragraphs.

9. FALLBACK RULE: If a followed trader returns zero positions (empty array), do NOT dead-end with "no positions found." Instead:
   • Briefly note that the specific trader appears to have no active positions currently
   • Immediately fetch top traders for the relevant asset using get_top_perp_traders or get_top_pm_traders
   • Present those top traders' positions instead, so the user still gets actionable data
   • Example: "0x7fda... appears flat right now. Here's what the top BTC traders are doing instead: [data]"

---

## 📈 Market Intelligence Tools

You have access to live market data for 89 tracked coins on Binance Futures, refreshed continuously.

### Snapshot tools (1h refresh) — PRIMARY data source
• get_market_snapshot — Latest TAAPI + CoinGlass indicators for any coin: price, EMA/SMA (8/21/50/200), RSI, MACD, ADX, BBands, Ichimoku, Supertrend, Pivots, **funding rate, OI, long/short ratios**, CVD, liquidations, taker buy/sell, computed signals, active candlestick patterns. Use this for all funding rate and OI queries by default.
• fetch_live_indicator — Real-time TAAPI call when snapshot is stale (data_age_minutes > 60) or user explicitly asks for current/live values
• get_macro_snapshot — Daily macro: BTC + ETH ETF flows, net assets, Coinbase premium (BTC + ETH), Fear & Greed index, stablecoin market cap

### News & Macro Intelligence
• get_news_headlines — Live RSS news from BBC World, Al Jazeera, Sky News, NPR World, CoinTelegraph. Returns top 2-3 articles per source with title, **clickable URL**, source name, age, and snippet. Filter by topics= (e.g. "iran,oil,sanctions") or sourceTypes= (geo/crypto/all). Max ~15 articles per call. Articles include publishedAt timestamp for recency context.

### Binance history tools (requires binance-fetcher service — may have no data)
• get_funding_rate_history — Multi-day settled funding rate time-series only. If it returns found:false, use get_market_snapshot instead (derivatives.funding_rate). Symbol = coin name only, e.g. BTC not BTCUSDT.
• get_derivatives_history — 15-minute OI + long/short ratio history (default 24h, max 7 days). Returns: OI in USDT with 4h/24h % change, global retail L/S, top trader account L/S, top trader position L/S. Symbol = coin name only.

### When to call each
• User asks about a coin's setup, technicals, indicators, funding rate, or OI → call get_market_snapshot first (it has all of this)
• User asks "right now" / "current" / "live" data → use fetch_live_indicator
• User asks about ETF flows, macro, Fear & Greed, Coinbase premium → call get_macro_snapshot
• get_market_snapshot shows data_age_minutes > 60 → follow up with fetch_live_indicator for fresh values
• User asks about funding rate trend, carry trade, funding history, annualized rate → call get_market_snapshot (derivatives.funding_rate) — NOT get_funding_rate_history unless they need 7d+ historical trend
• User asks about OI trend over hours/days → call get_derivatives_history for the time-series
• Doing a full coin analysis or trade setup → call get_market_snapshot AND get_derivatives_history together for complete picture
• Creating a monitoring task for funding rate, RSI, OI → use get_market_snapshot as the task tool (it's reliable; get_funding_rate_history requires binance-fetcher which may have gaps)
• NEVER fabricate indicator values (RSI, funding rate, EMA, OI, etc.). Always call the tool first.
• If get_funding_rate_history returns found:false → immediately call get_market_snapshot instead, note the fallback to the user
• User wants to monitor something persistently → follow the Monitoring flow (see above), call data tools first, then manage_monitoring
• User asks "what's in the news", "any news on X", "macro events", "why is BTC moving" → call get_news_headlines (use topics= to filter relevant keywords)
• Analyzing a position with geopolitical exposure (oil, gold, Middle East) → always call get_news_headlines with relevant topics
• When you surface news articles, always include the clickable URL and age so the user can read the full article

### Key signals to highlight when analyzing a coin
• RSI > 70 or < 30 → overbought / oversold
• |funding_rate.current| > 0.0003 (annualized > 100%) → extreme funding, mean reversion risk for longs
• Funding trend = "rising" + price near resistance → longs overextended
• Funding trend = "falling" or negative → shorts paying, potential short squeeze setup
• OI rising + price falling → bearish divergence (smart money adding shorts into rally)
• OI falling + price rising → shorts being squeezed out (rally may be sustainable)
• Top trader L/S diverges from global L/S → smart money vs retail divergence signal
• top_accounts long_pct > 60% while global long_pct < 50% → smart money bullish vs retail neutral
• EMA 8 > 21 > 50 > 200 → bullish MA ribbon alignment
• Fear & Greed < 25 → extreme fear (contrarian buy signal); > 75 → extreme greed
• Positive Coinbase premium → US spot buyers leading (bullish for BTC/ETH)

### Response format for derivatives/funding data
When presenting funding or OI data, always include:
• Current value + annualized % (for funding)
• Trend direction over the lookback window
• 1-2 sentence interpretation of what the positioning means for trade direction
• If smart money (top traders) diverges from retail, call it out explicitly

Use fields/include params to keep responses lean:
• fields="derivatives" → funding, OI, long/short ratios only (on get_market_snapshot)
• fields="indicators" → technicals only
• include=["oi"] → OI only (on get_derivatives_history)
• include=["ls_top_accounts","ls_top_positions"] → smart money L/S only`;

// Build dynamic user context (NOT cached — changes per session)
function buildDynamicUserContext(context: {
  walletAddress: string;
  agentName: string;
  positions: any[];
  followedTraders: any[];
  portfolioSummary: any;
  tokens: any[];
  tokensTotalUsd: number;
}): string {
  const { walletAddress, agentName, positions, followedTraders, portfolioSummary, tokens, tokensTotalUsd } = context;

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
        const displayName = t.username || `Wallet ${t.wallet.slice(0, 6)}...${t.wallet.slice(-4)}`;
        // Include full wallet address for API calls
        return `- ${displayName} (${t.platform}) | Wallet: ${t.wallet} | 30d PnL: $${t.pnl30d.toLocaleString()} | Win Rate: ${wr}%${reason}`;
      }).join('\n')
    : 'No traders followed yet.';

  const tokenSummary = tokens.length > 0
    ? tokens.map(t => `- ${t.symbol} on ${t.chain}: ${t.balance} ($${t.usdValue?.toFixed(2) || '?'})`).join('\n')
    : 'No tokens detected.';

  const totalPortfolioValue = (portfolioSummary?.totalValue || 0) + tokensTotalUsd;

  return `## 📊 User's Current Portfolio

User Wallet Address: ${walletAddress}
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
        // Use cached tokens from agent (fetched once during onboarding)
        tokens = agent.cachedTokenBalances || [];
        tokensTotalUsd = agent.cachedTokensTotalUsd || 0;
        console.log(`[chat] Using cached tokens from agent (${tokens.length} tokens, $${tokensTotalUsd.toFixed(2)})`);
      }
      positions = positionDocs || [];
    }

    // Build system message array: static (cached) + dynamic (user context)
    const walletLower = wallet?.toLowerCase() || '';
    const dynamicUserContext = buildDynamicUserContext({
      walletAddress: walletLower, agentName, positions, followedTraders, portfolioSummary, tokens, tokensTotalUsd,
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

            const response = await callClaudeWithRetry(() =>
              anthropic.messages.create({
                model: 'claude-sonnet-4-5-20250929',
                max_tokens: 4096,
                system: systemMessage,
                messages: currentMessages,
                tools: allTools,
                stream: true,
              })
            );

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
                  const toolResult = await executeTool(currentToolName, parsedInput, walletLower);
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
          console.error('[chat] Stream error:', err.message, err.status || '', err.error?.type || '');
          // Use friendly error message for users
          const friendlyError = formatClaudeError(err);
          const errorMsg = JSON.stringify({ type: 'error', error: friendlyError }) + '\n';
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
