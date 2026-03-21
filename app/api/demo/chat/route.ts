import { NextRequest } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import connectDB from '@/lib/mongoose';
import mongoose from 'mongoose';
import Agent from '@/models/Agent';
import Position from '@/models/Position';
import ChatSession from '@/models/ChatSession';
import { trackUsage, TokenUsageData } from '@/lib/tokenTracking';
import { fetchNews, formatArticlesForLLM } from '@/lib/rss';
import {
  classifyToolResult,
  detectPostResponseHallucination,
  EXECUTION_TOOLS,
  type ClassifiedResult,
} from '@/lib/toolResultInterpreter';
// Note: validateBalanceForTrade removed — Bankr handles balance/allowance checks internally.

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || '',
});

// Ensure service URLs always carry a protocol (handles Railway/Render URLs without https://)
function normalizeUrl(url: string): string {
  if (!url.startsWith('http://') && !url.startsWith('https://')) return `https://${url}`;
  return url;
}

const HYPERLIQUID_API_URL = 'https://api.hyperliquid.xyz/info';
const POLYMARKET_API_BASE = 'https://data-api.polymarket.com';
const AVANTIS_API_URL = 'https://yieldr-app-production.up.railway.app/fetch-positions';
const BASE_RPC_URL = process.env.QUICKNODE_BASE_RPC_URL || process.env.BASE_RPC_URL || 'https://mainnet.base.org';

// ─── Bankr API (replaces CDP wallet + Railway Python execution layer) ─────────
// MIGRATION NOTE (2026-03-16): All trade execution now routes through Bankr API.
// The old CDP wallet address was 0xe7b76A90d2fA937a380176F360EcDB2F17087452.
// The old Railway Python service handled ERC20 approval + on-chain tx signing.
// Bankr handles all of this internally — no allowance checks, no gas management needed.
// To REVERT: restore CDP/Railway handlers in executeTool() and re-add trade tools to EXECUTION_TOOLS.
const BANKR_API_BASE = 'https://api.bankr.bot';
const BANKR_WALLET_ADDRESS = '0xcdc44ffda057aca49bb9c8b7d54de212742729c7';

// ─── API-Football Helper ──────────────────────────────────────────────────────
const API_FOOTBALL_BASE = process.env.API_FOOTBALL_BASE_URL || 'https://v3.football.api-sports.io';
const API_FOOTBALL_TIMEOUT = 15_000;

async function apiFootballGet(endpoint: string, params: Record<string, string | number | undefined> = {}): Promise<{ ok: boolean; data: any; errors?: string[] }> {
  const apiKey = process.env.API_FOOTBALL_KEY;
  if (!apiKey) return { ok: false, data: null, errors: ['API_FOOTBALL_KEY not configured'] };
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  }
  const url = `${API_FOOTBALL_BASE}/${endpoint}?${qs.toString()}`;
  console.log(`[api-football] GET ${endpoint}?${qs.toString()}`);
  try {
    const res = await fetch(url, {
      headers: { 'x-apisports-key': apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(API_FOOTBALL_TIMEOUT),
    });
    if (!res.ok) return { ok: false, data: null, errors: [`HTTP ${res.status}`] };
    const json = await res.json();
    if (json.errors && Object.keys(json.errors).length > 0) {
      return { ok: false, data: null, errors: Object.values(json.errors) as string[] };
    }
    return { ok: true, data: json.response ?? json };
  } catch (err: any) {
    return { ok: false, data: null, errors: [err.message] };
  }
}
const USDC_BASE_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BANKR_API_KEY = process.env.BANKR_API_KEY ?? '';

/** Submit a natural-language prompt to Bankr and poll until complete (max 60 × 2 s = 2 min). */
async function submitBankrPrompt(prompt: string, emitToStream?: (event: any) => void): Promise<{ success: boolean; response?: string; status: string }> {
  if (!BANKR_API_KEY) throw new Error('Bankr authentication issue (BANKR_API_KEY is not configured)');
  console.log(`[bankr] Using API key: ${BANKR_API_KEY.slice(0, 6)}...${BANKR_API_KEY.slice(-4)} (len=${BANKR_API_KEY.length})`);
  const apiKey = BANKR_API_KEY;

  emitToStream?.({ type: 'agent_activity', message: 'Submitting trade to execution engine...' });

  const submitRes = await fetch(`${BANKR_API_BASE}/agent/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
    body: JSON.stringify({ prompt }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!submitRes.ok) {
    const body = await submitRes.text().catch(() => '');
    throw new Error(`Bankr prompt submit failed: HTTP ${submitRes.status}${body ? ` — ${body}` : ''}`);
  }
  const { jobId } = await submitRes.json();

  // Activity messages shown to user during execution (no Bankr/wallet references)
  const activitySteps = [
    { at: 2, msg: 'Checking token allowances...' },
    { at: 5, msg: 'Preparing on-chain transaction...' },
    { at: 10, msg: 'Signing and broadcasting transaction...' },
    { at: 18, msg: 'Waiting for block confirmation...' },
    { at: 30, msg: 'Transaction pending — confirming on Base network...' },
    { at: 45, msg: 'Still waiting for confirmation (this can take a moment)...' },
  ];

  // Poll
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 2000));

    // Emit activity step if it matches this iteration
    const step = activitySteps.find(s => s.at === i);
    if (step) emitToStream?.({ type: 'agent_activity', message: step.msg });

    const pollRes = await fetch(`${BANKR_API_BASE}/agent/job/${jobId}`, {
      headers: { 'X-API-Key': apiKey },
      signal: AbortSignal.timeout(10_000),
    });
    const job = await pollRes.json();
    if (job.status !== 'pending' && job.status !== 'processing') {
      emitToStream?.({ type: 'agent_activity', message: job.status === 'completed' ? 'Transaction confirmed!' : 'Execution finished.' });
      return { success: job.status === 'completed', response: job.response, status: job.status };
    }
  }
  return { success: false, response: 'Trade execution timed out after 2 minutes.', status: 'timeout' };
}

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
    name: 'get_pm_market',
    description: 'Fetch Polymarket market data including outcomes, current odds/probabilities, volume, and liquidity. PREFERRED: pass the full Polymarket URL and the slug is extracted automatically. Also accepts slug, conditionId, or keyword search.',
    input_schema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'Full Polymarket URL (e.g. "https://polymarket.com/event/arsenal-v-liverpool"). Slug is extracted automatically.' },
        slug: { type: 'string', description: 'Market slug (e.g. "will-israel-attack-iran-in-2025")' },
        conditionId: { type: 'string', description: 'Market condition ID (0x hex string)' },
        keyword: { type: 'string', description: 'Search keyword to find markets by title (e.g. "bitcoin", "trump", "Arsenal Liverpool")' },
        limit: { type: 'number', description: 'Number of markets to return for keyword search (default: 5, max: 20)' },
        activeOnly: { type: 'boolean', description: 'Only return active/open markets (default: true)' },
      },
    },
  },
  {
    name: 'get_pm_user_activity',
    description: 'Fetch recent trade activity (buys, sells, redeems) for a Polymarket wallet. Filter by market, side, or days back. Useful for tracking what a wallet is actively trading.',
    input_schema: {
      type: 'object' as const,
      properties: {
        walletAddress: { type: 'string', description: 'Ethereum wallet address (0x...)' },
        market: { type: 'string', description: 'Filter by condition ID to see activity in one market' },
        side: { type: 'string', enum: ['BUY', 'SELL'], description: 'Filter by trade side' },
        type: { type: 'string', enum: ['TRADE', 'REDEEM', 'MERGE'], description: 'Filter by activity type' },
        afterDays: { type: 'number', description: 'Only return activity from the last N days (default: 7)' },
        limit: { type: 'number', description: 'Number of activity records (default: 20, max: 100)' },
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

// ─── Agent Trading Execution Tools ───────────────────────────────────────────
toolDefinitions.push({
  name: 'get_agent_wallet_balance',
  description:
    'Check the Bankr agent wallet ETH and USDC balance. Call this BEFORE executing any trade or generating deposit cards. ' +
    'Bankr handles gas internally, but USDC is needed as trade collateral. ' +
    'After checking: if USDC < required collateral call fund_agent. ' +
    'Both cards can be emitted in the same response — call both tools without waiting for user approval.',
  input_schema: {
    type: 'object' as const,
    properties: {},
  },
});

toolDefinitions.push({
  name: 'open_trade',
  description:
    'Execute a perpetual trade on Avantis (Base). ONLY call this after receiving a TRADE_APPROVED: message from the user — ' +
    'calling without approval will be REJECTED. You must call propose_trade first to show an approval card. ' +
    'Minimum position size: collateral × leverage >= $100 USDC. ' +
    'Pair indices: 1=BTC/USD, 2=ETH/USD, 3=SOL/USD, 4=LINK/USD, 5=ARB/USD. ' +
    'For MARKET orders open_price is not needed. For LIMIT orders open_price is required. ' +
    'Returns a natural-language confirmation with entry price, leverage, TP/SL, and tx hash.',
  input_schema: {
    type: 'object' as const,
    properties: {
      pair:       { type: 'string',  description: 'Trading pair, e.g. "BTC/USD" or "ETH/USD"' },
      pair_index: { type: 'number',  description: 'On-chain pair index: 1=BTC/USD, 2=ETH/USD, 3=SOL/USD' },
      direction:  { type: 'string',  enum: ['LONG', 'SHORT'], description: 'Trade direction' },
      collateral: { type: 'number',  description: 'Collateral in USDC (e.g. 10 for $10 USDC)' },
      leverage:   { type: 'number',  description: 'Leverage multiplier (e.g. 10 for 10×). collateral × leverage must be ≥ $100' },
      tp_pct:     { type: 'number',  description: 'Take-profit % above/below entry (e.g. 4 for 4%)' },
      sl_pct:     { type: 'number',  description: 'Stop-loss % against entry (e.g. 2.5 for 2.5%)' },
      order_type: { type: 'string',  enum: ['MARKET', 'LIMIT'], description: 'MARKET executes immediately; LIMIT queues at open_price. Default: MARKET' },
      open_price: { type: 'number',  description: 'Fill price — required for LIMIT orders only' },
    },
    required: ['pair', 'pair_index', 'direction', 'collateral', 'leverage', 'tp_pct', 'sl_pct'],
  },
});

toolDefinitions.push({
  name: 'close_trade',
  description:
    'Close an open perpetual position on Avantis. ' +
    'Call get_avantis_live_positions first to get pair_index and trade_index. ' +
    'Returns tx_hash, exit_price, pnl.',
  input_schema: {
    type: 'object' as const,
    properties: {
      pair_index:          { type: 'number', description: 'On-chain pair index (e.g. 1 for BTC/USD)' },
      trade_index:         { type: 'number', description: 'On-chain trade index (from get_avantis_live_positions)' },
      collateral_to_close: { type: 'number', description: 'USDC collateral amount to close. Use the full open_collateral value to close the entire position.' },
    },
    required: ['pair_index', 'trade_index', 'collateral_to_close'],
  },
});

toolDefinitions.push({
  name: 'cancel_limit_order',
  description:
    'Cancel a pending limit order on Avantis. ' +
    'Call get_avantis_live_positions first to get pair_index and trade_index from pending_orders. ' +
    'Returns tx_hash on success.',
  input_schema: {
    type: 'object' as const,
    properties: {
      pair_index:  { type: 'number', description: 'On-chain pair index' },
      trade_index: { type: 'number', description: 'On-chain trade/order index (from pending_orders in get_avantis_live_positions)' },
    },
    required: ['pair_index', 'trade_index'],
  },
});

toolDefinitions.push({
  name: 'withdraw_funds',
  description:
    'Withdraw ETH or USDC from the Bankr agent wallet to a destination address. ' +
    'Bankr signs and sends autonomously — no user signature needed. ' +
    'Call get_agent_wallet_balance first to confirm available balance. ' +
    'Use when the user asks to withdraw, send back, or transfer funds out of the agent wallet. ' +
    'Default to_address is the user\'s connected wallet unless they specify otherwise.',
  input_schema: {
    type: 'object' as const,
    properties: {
      amount:     { type: 'number', description: 'Amount to withdraw (e.g. 0.005 for 0.005 ETH or 10 for $10 USDC)' },
      asset:      { type: 'string', enum: ['ETH', 'USDC'], description: 'Asset to withdraw: ETH (native gas token on Base) or USDC' },
      to_address: { type: 'string', description: 'Destination wallet address. Use the user\'s connected wallet address unless they specify a different one.' },
    },
    required: ['amount', 'asset', 'to_address'],
  },
});

toolDefinitions.push({
  name: 'fund_agent',
  description:
    'Deposit USDC from the user\'s connected wallet into the Bankr agent wallet. ' +
    'Call this when the agent wallet needs USDC for trading collateral. ' +
    'Emits a deposit approval card — the user must click Approve and sign in their wallet. ' +
    'Call get_agent_wallet_balance first to confirm how much USDC is needed.',
  input_schema: {
    type: 'object' as const,
    properties: {
      amount: { type: 'number', description: 'Amount of USDC to deposit (e.g. 10 for $10 USDC)' },
    },
    required: ['amount'],
  },
});

toolDefinitions.push({
  name: 'fund_agent_eth',
  description:
    'Deposit ETH from the user\'s connected wallet into the Bankr agent wallet. ' +
    'Bankr manages gas internally, but a small ETH reserve is useful as a buffer. ' +
    'Emits an ETH deposit approval card — the user must click Approve and sign in their wallet. ' +
    'Default deposit: 0.001 ETH.',
  input_schema: {
    type: 'object' as const,
    properties: {
      amount_eth: { type: 'number', description: 'Amount of ETH to deposit (e.g. 0.001 for 0.001 ETH)' },
    },
    required: ['amount_eth'],
  },
});

toolDefinitions.push({
  name: 'propose_trade',
  description:
    'Propose a perpetual trade for user confirmation BEFORE executing. ' +
    'ALWAYS call this INSTEAD OF open_trade when presenting a trade to the user. ' +
    'Shows a trade confirmation card in the UI with entry/exit conditions and execution details. ' +
    'After the user clicks Approve, THEN call open_trade with the SAME parameters. ' +
    'Do NOT call open_trade without calling propose_trade first (except when re-executing after user approval).',
  input_schema: {
    type: 'object' as const,
    properties: {
      pair:             { type: 'string',  description: 'Trading pair, e.g. "BTC/USD" or "ETH/USD"' },
      pair_index:       { type: 'number',  description: 'On-chain pair index: 1=BTC/USD, 2=ETH/USD, 3=SOL/USD' },
      direction:        { type: 'string',  enum: ['LONG', 'SHORT'], description: 'Trade direction' },
      collateral:       { type: 'number',  description: 'Collateral in USDC' },
      leverage:         { type: 'number',  description: 'Leverage multiplier' },
      tp_pct:           { type: 'number',  description: 'Take-profit percentage' },
      sl_pct:           { type: 'number',  description: 'Stop-loss percentage' },
      order_type:       { type: 'string',  enum: ['MARKET', 'LIMIT'], description: 'Order type. Default: MARKET' },
      open_price:       { type: 'number',  description: 'Fill price for LIMIT orders only' },
      rationale:        { type: 'string',  description: 'Brief reason for this trade shown on the confirmation card' },
      entry_conditions: { type: 'array', items: { type: 'string' }, description: 'List of entry signal conditions (e.g. ["RSI < 35", "Stoch RSI < 25", "Price below EMA-21"])' },
      exit_conditions:  { type: 'array', items: { type: 'string' }, description: 'List of exit/TP/SL conditions (e.g. ["TP: +3.5% → EMA-21 resistance", "SL: -2% → below swing low"])' },
    },
    required: ['pair', 'pair_index', 'direction', 'collateral', 'leverage', 'tp_pct', 'sl_pct'],
  },
});

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

// ─── Football / Soccer Live API Tools (API-Football) ─────────────────────────
toolDefinitions.push({
  name: 'search_football_fixtures',
  description:
    'Search for football/soccer fixtures by team name, date, league, or live status. ' +
    'Resolves fuzzy team names automatically (e.g. "Man Utd" → "Manchester United"). ' +
    'Use to find fixture_id and team IDs for other football tools. ' +
    'Common league IDs: 39=Premier League, 140=La Liga, 135=Serie A, 78=Bundesliga, 61=Ligue 1, 2=UCL.',
  input_schema: {
    type: 'object' as const,
    properties: {
      team: { type: 'string', description: 'Team name to search (e.g. "Arsenal", "Man United")' },
      date: { type: 'string', description: 'Date in YYYY-MM-DD format' },
      league: { type: 'number', description: 'League ID (39=PL, 140=La Liga, 135=Serie A, 78=Bundesliga, 61=Ligue 1, 2=UCL)' },
      season: { type: 'number', description: 'Season year (e.g. 2025)' },
      live: { type: 'boolean', description: 'If true, only return live matches' },
      next: { type: 'number', description: 'Return next N upcoming fixtures for a team (max 10)' },
      last: { type: 'number', description: 'Return last N completed fixtures for a team (max 10)' },
    },
  },
});

toolDefinitions.push({
  name: 'get_fixture_details',
  description:
    'Get full details for a football fixture: score, status, referee, venue, lineups, match statistics ' +
    '(shots, possession, passes, corners, fouls, cards), and events (goals, cards, substitutions). ' +
    'Works for upcoming, live, and completed matches. Requires fixture_id from search_football_fixtures.',
  input_schema: {
    type: 'object' as const,
    properties: {
      fixture_id: { type: 'number', description: 'Fixture ID from search_football_fixtures' },
      include: {
        type: 'array', items: { type: 'string', enum: ['stats', 'events', 'lineups'] },
        description: 'Which extra data to include. Default: all. Use ["stats"] to save API calls.',
      },
    },
    required: ['fixture_id'],
  },
});

toolDefinitions.push({
  name: 'get_football_h2h',
  description:
    'Get head-to-head history between two football teams. Returns last N meetings with scores, ' +
    'plus summary: wins/draws/losses, total goals, BTTS%, over 2.5%. Requires team IDs from search_football_fixtures.',
  input_schema: {
    type: 'object' as const,
    properties: {
      team_a: { type: 'number', description: 'First team ID' },
      team_b: { type: 'number', description: 'Second team ID' },
      last: { type: 'number', description: 'Number of H2H meetings (default: 10, max: 20)' },
    },
    required: ['team_a', 'team_b'],
  },
});

toolDefinitions.push({
  name: 'get_football_standings',
  description:
    'Get full league standings/table: rank, points, W/D/L, GF/GA, GD, form, home/away splits. ' +
    'League IDs: 39=Premier League, 140=La Liga, 135=Serie A, 78=Bundesliga, 61=Ligue 1, 2=UCL.',
  input_schema: {
    type: 'object' as const,
    properties: {
      league: { type: 'number', description: 'League ID' },
      season: { type: 'number', description: 'Season year (default: current year)' },
    },
    required: ['league'],
  },
});

toolDefinitions.push({
  name: 'get_team_form',
  description:
    'Get team form (recent results) and season statistics. Returns last N fixtures, computed betting stats ' +
    '(BTTS%, O2.5%, clean sheet%), momentum grade, fixture congestion, and full season stats. ' +
    'Requires team_id from search_football_fixtures.',
  input_schema: {
    type: 'object' as const,
    properties: {
      team_id: { type: 'number', description: 'Team ID from search_football_fixtures' },
      league: { type: 'number', description: 'League ID for season stats (e.g. 39=PL)' },
      season: { type: 'number', description: 'Season year (default: current year)' },
      last: { type: 'number', description: 'Number of recent fixtures (default: 10, max: 15)' },
    },
    required: ['team_id'],
  },
});

toolDefinitions.push({
  name: 'get_match_odds',
  description:
    'Get bookmaker odds and AI predictions for a fixture. Returns 1X2, O/U 2.5, BTTS, implied probabilities, ' +
    'AI prediction (winner, advice), and team comparison. Compare implied_probability with Polymarket prices to find edges.',
  input_schema: {
    type: 'object' as const,
    properties: {
      fixture_id: { type: 'number', description: 'Fixture ID from search_football_fixtures' },
      include_predictions: { type: 'boolean', description: 'Also fetch AI predictions (default: true)' },
    },
    required: ['fixture_id'],
  },
});

toolDefinitions.push({
  name: 'get_football_injuries',
  description:
    'Get injury and suspension list for a football fixture or team. Returns players grouped by team with injury type and reason.',
  input_schema: {
    type: 'object' as const,
    properties: {
      fixture_id: { type: 'number', description: 'Fixture ID for both teams in a match' },
      team_id: { type: 'number', description: 'Team ID for a specific team' },
      season: { type: 'number', description: 'Season year (required with team_id)' },
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
    case 'get_pm_market':
      return input.keyword
        ? `Searching Polymarket for "${input.keyword}" markets...`
        : `Fetching Polymarket market data...`;
    case 'get_pm_user_activity':
      return `Fetching Polymarket activity for ${input.walletAddress?.slice(0, 10)}...`;
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
    // Football / Soccer tools
    case 'search_football_fixtures':
      return input.team
        ? `Searching for "${input.team}" fixtures...`
        : input.date
        ? `Fetching fixtures for ${input.date}...`
        : input.live
        ? `Fetching live football matches...`
        : `Searching football fixtures...`;
    case 'get_fixture_details':
      return `Loading match details for fixture #${input.fixture_id}...`;
    case 'get_football_h2h':
      return `Fetching head-to-head history...`;
    case 'get_football_standings':
      return `Loading league standings...`;
    case 'get_team_form':
      return `Analyzing team form and stats...`;
    case 'get_match_odds':
      return `Fetching bookmaker odds and predictions...`;
    case 'get_football_injuries':
      return `Checking injury reports...`;
    case 'get_agent_wallet_balance':
      return `Checking agent wallet balance...`;
    case 'open_trade':
      return `Executing ${input.direction || ''} ${input.pair || ''} ${input.order_type || 'MARKET'} order...`.trim();
    case 'close_trade':
      return `Closing ${input.pair_index ? (['', 'BTC', 'ETH', 'SOL', 'LINK', 'ARB'][input.pair_index] || '') + ' ' : ''}position...`.trim();
    case 'cancel_limit_order':
      return `Cancelling limit order (pair_index=${input.pair_index}, trade_index=${input.trade_index})...`;
    case 'withdraw_funds':
      return `Withdrawing ${input.amount} ${input.asset} from agent wallet...`;
    case 'fund_agent':
      return `Preparing $${input.amount} USDC deposit transaction...`;
    case 'propose_trade':
      return `Preparing ${input.direction || ''} ${input.pair || ''} trade proposal...`.trim();
    case 'web_search':
      return `Searching the web...`;
    default:
      return `Running ${name}...`;
  }
}

// ─── Tool Execution ────────────────────────────────────────────────────────

async function executeTool(name: string, input: any, wallet?: string, agentCtxId?: string, agentCtxWallet?: string, emitToStream?: (event: any) => void, tradeApproved?: boolean): Promise<string> {
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
        // Use Railway fetch-positions API for ALL wallets (including Bankr agent wallet).
        // Bankr prompt API is reserved ONLY for trade execution (open/close) to conserve
        // the 100 msg/day free-tier limit. Position fetching uses QuickNode RPC via Python service.
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
      case 'get_pm_market': {
        let { slug, conditionId, keyword, limit: mktLimit = 5, activeOnly = true } = input;
        // Auto-extract slug from pasted Polymarket URL
        if (input.url && !slug && !conditionId) {
          const urlMatch = input.url.match(/polymarket\.com\/(?:event|market)\/([^/?#]+)/);
          if (urlMatch) slug = urlMatch[1];
        }
        if (!slug && !conditionId && !keyword) return JSON.stringify({ error: 'Provide url, slug, conditionId, or keyword' });
        const GAMMA_API = 'https://gamma-api.polymarket.com';
        let pmMarkets: any[] = [];
        if (conditionId) {
          const res = await fetch(`${GAMMA_API}/markets?condition_id=${encodeURIComponent(conditionId)}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
          if (!res.ok) return JSON.stringify({ error: `Gamma API error: ${res.status}` });
          const raw = await res.json();
          pmMarkets = Array.isArray(raw) ? raw : [raw];
        } else if (slug) {
          // Try /markets first, then fallback to /events (Polymarket uses event-level slugs)
          const mRes = await fetch(`${GAMMA_API}/markets?slug=${encodeURIComponent(slug)}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
          if (mRes.ok) {
            const mData = await mRes.json();
            pmMarkets = (Array.isArray(mData) ? mData : []).filter((m: any) => m.conditionId || m.condition_id);
          }
          if (pmMarkets.length === 0) {
            const eRes = await fetch(`${GAMMA_API}/events?slug=${encodeURIComponent(slug)}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
            if (eRes.ok) {
              const eData = await eRes.json();
              const events = Array.isArray(eData) ? eData : [eData];
              const childMarkets = events.flatMap((e: any) => { const ms = e.markets ?? e.series ?? []; return Array.isArray(ms) ? ms : []; });
              pmMarkets = childMarkets.length > 0 ? childMarkets : events;
            }
          }
        } else {
          const p = new URLSearchParams({ _q: keyword, limit: String(Math.min(mktLimit, 20)), order: 'volume', ascending: 'false', ...(activeOnly ? { active: 'true', closed: 'false' } : {}) });
          const res = await fetch(`${GAMMA_API}/markets?${p.toString()}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
          if (!res.ok) return JSON.stringify({ error: `Gamma API error: ${res.status}` });
          const raw = await res.json();
          pmMarkets = Array.isArray(raw) ? raw : [];
        }
        const markets = pmMarkets.map((m: any) => {
          let outcomes: Array<{ name: string; probability: number }> = [];
          try {
            const names = typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : (m.outcomes ?? []);
            const prices = typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : (m.outcomePrices ?? []);
            outcomes = names.map((n: string, i: number) => ({ name: n, probability: Math.round((prices[i] ?? 0) * 100) }));
          } catch {}
          return { conditionId: m.conditionId, slug: m.slug, title: m.question ?? m.title, category: m.category, endDate: m.endDate, active: m.active, volume: parseFloat(m.volume ?? '0'), liquidity: parseFloat(m.liquidity ?? '0'), outcomes, url: m.slug ? `https://polymarket.com/event/${m.slug}` : '' };
        });
        return JSON.stringify({ totalFound: markets.length, markets });
      }
      case 'get_pm_user_activity': {
        const { walletAddress, market, side, type: actType, afterDays = 7, limit: actLimit = 20 } = input;
        const afterTs = Math.floor(Date.now() / 1000) - (afterDays * 86400);
        const p = new URLSearchParams({ user: walletAddress, limit: String(Math.min(actLimit, 100)), after: String(afterTs) });
        if (market) p.set('market', market);
        if (side) p.set('side', side);
        if (actType) p.set('type', actType);
        const res = await fetch(`${POLYMARKET_API_BASE}/activity?${p.toString()}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
        if (!res.ok) return JSON.stringify({ wallet: walletAddress, totalActivity: 0, activity: [] });
        const raw = await res.json();
        const records: any[] = Array.isArray(raw) ? raw : (raw?.data ?? raw?.activity ?? []);
        const activity = records.map((r: any) => ({ type: r.type ?? 'TRADE', side: r.side, conditionId: r.conditionId ?? r.market, marketTitle: r.title ?? r.question ?? 'Unknown', outcome: r.outcome, size: parseFloat(r.size ?? r.shares ?? '0'), price: parseFloat(r.price ?? '0'), value: parseFloat(r.usdcSize ?? r.value ?? '0'), timestamp: r.timestamp, transactionHash: r.transactionHash }));
        const buys = activity.filter((a: any) => a.side === 'BUY').length;
        const sells = activity.filter((a: any) => a.side === 'SELL').length;
        return JSON.stringify({ wallet: walletAddress, totalActivity: activity.length, summary: { buys, sells, totalVolumeUsd: activity.reduce((s: number, a: any) => s + a.value, 0), uniqueMarkets: new Set(activity.map((a: any) => a.conditionId).filter(Boolean)).size }, activity });
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

      // ─── Football / Soccer Live API Tools ─────────────────────────────────────
      case 'search_football_fixtures': {
        const { team, date, league, season, live, next, last: lastN } = input;
        // Resolve team name → ID
        let teamId: number | undefined;
        let resolvedTeamName: string | undefined;
        if (team) {
          const teamRes = await apiFootballGet('teams', { search: team });
          if (!teamRes.ok || !teamRes.data?.length) {
            return JSON.stringify({ found: false, message: `Could not find team matching "${team}".` });
          }
          const t = teamRes.data[0]?.team;
          teamId = t?.id;
          resolvedTeamName = t?.name;
        }
        const fParams: Record<string, string | number | undefined> = {};
        if (live) { fParams.live = 'all'; }
        else if (teamId && next) { fParams.team = teamId; fParams.next = Math.min(next, 10); }
        else if (teamId && lastN) { fParams.team = teamId; fParams.last = Math.min(lastN, 10); }
        else {
          if (teamId) fParams.team = teamId;
          if (date) fParams.date = date;
          if (league) fParams.league = league;
          if (season) fParams.season = season;
          if (league && !season && !date) fParams.season = new Date().getFullYear();
        }
        const fRes = await apiFootballGet('fixtures', fParams);
        if (!fRes.ok) return JSON.stringify({ found: false, errors: fRes.errors });
        const fixtures = (fRes.data || []).slice(0, 20).map((f: any) => ({
          fixture_id: f.fixture?.id, date: f.fixture?.date, referee: f.fixture?.referee,
          venue: f.fixture?.venue?.name,
          status: { long: f.fixture?.status?.long, short: f.fixture?.status?.short, elapsed: f.fixture?.status?.elapsed },
          league: { id: f.league?.id, name: f.league?.name, country: f.league?.country, round: f.league?.round, season: f.league?.season },
          home: { id: f.teams?.home?.id, name: f.teams?.home?.name, winner: f.teams?.home?.winner },
          away: { id: f.teams?.away?.id, name: f.teams?.away?.name, winner: f.teams?.away?.winner },
          score: { home: f.goals?.home, away: f.goals?.away, halftime: f.score?.halftime, fulltime: f.score?.fulltime },
        }));
        return JSON.stringify({
          found: true,
          ...(resolvedTeamName ? { resolved_team: resolvedTeamName, team_id: teamId } : {}),
          total: fixtures.length, fixtures,
        });
      }

      case 'get_fixture_details': {
        const { fixture_id, include } = input;
        const incSet = new Set(include ?? ['stats', 'events', 'lineups']);
        const fdRes = await apiFootballGet('fixtures', { id: fixture_id });
        if (!fdRes.ok || !fdRes.data?.length) return JSON.stringify({ found: false, fixture_id, errors: fdRes.errors || ['Not found'] });
        const fd = fdRes.data[0];
        const fdResult: Record<string, any> = {
          found: true, fixture_id, date: fd.fixture?.date, referee: fd.fixture?.referee, venue: fd.fixture?.venue?.name,
          status: { long: fd.fixture?.status?.long, short: fd.fixture?.status?.short, elapsed: fd.fixture?.status?.elapsed },
          league: { id: fd.league?.id, name: fd.league?.name, round: fd.league?.round },
          home: { id: fd.teams?.home?.id, name: fd.teams?.home?.name },
          away: { id: fd.teams?.away?.id, name: fd.teams?.away?.name },
          score: { home: fd.goals?.home, away: fd.goals?.away, halftime: fd.score?.halftime, fulltime: fd.score?.fulltime },
          events: fd.events ?? [],
        };
        const fdPromises: Promise<void>[] = [];
        if (incSet.has('stats')) {
          fdPromises.push(apiFootballGet('fixtures/statistics', { fixture: fixture_id }).then(r => {
            if (r.ok && r.data?.length) {
              fdResult.statistics = r.data.map((ts: any) => ({
                team: ts.team?.name, team_id: ts.team?.id,
                stats: Object.fromEntries((ts.statistics || []).map((s: any) => [s.type?.toLowerCase().replace(/\s+/g, '_'), s.value])),
              }));
            }
          }));
        }
        if (incSet.has('lineups')) {
          fdPromises.push(apiFootballGet('fixtures/lineups', { fixture: fixture_id }).then(r => {
            if (r.ok && r.data?.length) {
              fdResult.lineups = r.data.map((l: any) => ({
                team: l.team?.name, formation: l.formation,
                starting_xi: (l.startXI || []).map((p: any) => ({ name: p.player?.name, number: p.player?.number, pos: p.player?.pos })),
                substitutes: (l.substitutes || []).slice(0, 7).map((p: any) => ({ name: p.player?.name, number: p.player?.number, pos: p.player?.pos })),
                coach: l.coach?.name,
              }));
            }
          }));
        }
        await Promise.all(fdPromises);
        return JSON.stringify(fdResult);
      }

      case 'get_football_h2h': {
        const { team_a, team_b, last: h2hLast = 10 } = input;
        const h2hRes = await apiFootballGet('fixtures/headtohead', { h2h: `${team_a}-${team_b}`, last: Math.min(h2hLast, 20) });
        if (!h2hRes.ok || !h2hRes.data?.length) return JSON.stringify({ found: false, team_a, team_b, errors: h2hRes.errors || ['No H2H data'] });
        const h2hMatches = h2hRes.data;
        let aW = 0, bW = 0, dr = 0, aG = 0, bG = 0, btts = 0, o25 = 0;
        const h2hHistory = h2hMatches.map((f: any) => {
          const hId = f.teams?.home?.id; const hG = f.goals?.home ?? 0; const awG = f.goals?.away ?? 0;
          const aIsH = hId === team_a;
          const tAG = aIsH ? hG : awG; const tBG = aIsH ? awG : hG;
          aG += tAG; bG += tBG;
          if (tAG > tBG) aW++; else if (tBG > tAG) bW++; else dr++;
          if (hG > 0 && awG > 0) btts++;
          if (hG + awG > 2) o25++;
          return { date: f.fixture?.date?.slice(0, 10), home: f.teams?.home?.name, away: f.teams?.away?.name, score: `${hG}-${awG}`, result_for_team_a: tAG > tBG ? 'W' : tBG > tAG ? 'L' : 'D' };
        });
        const tot = h2hMatches.length;
        return JSON.stringify({
          found: true,
          team_a: { id: team_a, name: h2hMatches[0]?.teams?.[h2hMatches[0]?.teams?.home?.id === team_a ? 'home' : 'away']?.name },
          team_b: { id: team_b, name: h2hMatches[0]?.teams?.[h2hMatches[0]?.teams?.home?.id === team_b ? 'home' : 'away']?.name },
          summary: { total_matches: tot, team_a_wins: aW, team_b_wins: bW, draws: dr, team_a_goals: aG, team_b_goals: bG, avg_total_goals: +((aG + bG) / tot).toFixed(2), btts_pct: +((btts / tot * 100).toFixed(1)), over_25_pct: +((o25 / tot * 100).toFixed(1)) },
          matches: h2hHistory,
        });
      }

      case 'get_football_standings': {
        const { league: stLeague, season: stSeason = new Date().getFullYear() } = input;
        const stRes = await apiFootballGet('standings', { league: stLeague, season: stSeason });
        if (!stRes.ok || !stRes.data?.length) return JSON.stringify({ found: false, league: stLeague, season: stSeason, errors: stRes.errors || ['No standings'] });
        const stData = stRes.data[0]?.league;
        if (!stData?.standings?.length) return JSON.stringify({ found: false, message: 'Standings not available' });
        const groups = stData.standings.map((group: any[]) => group.map((e: any) => ({
          rank: e.rank, team: e.team?.name, team_id: e.team?.id, points: e.points,
          played: e.all?.played, won: e.all?.win, draw: e.all?.draw, lost: e.all?.lose,
          gf: e.all?.goals?.for, ga: e.all?.goals?.against, gd: e.goalsDiff, form: e.form,
          home: { p: e.home?.played, w: e.home?.win, d: e.home?.draw, l: e.home?.lose, gf: e.home?.goals?.for, ga: e.home?.goals?.against },
          away: { p: e.away?.played, w: e.away?.win, d: e.away?.draw, l: e.away?.lose, gf: e.away?.goals?.for, ga: e.away?.goals?.against },
          description: e.description,
        })));
        return JSON.stringify({
          found: true, league: { id: stData.id, name: stData.name, country: stData.country, season: stData.season },
          standings: groups.length === 1 ? groups[0] : groups,
        });
      }

      case 'get_team_form': {
        const { team_id: tfTeamId, league: tfLeague, season: tfSeason = new Date().getFullYear(), last: tfLast = 10 } = input;
        const [tfFixRes, tfSeasonRes] = await Promise.all([
          apiFootballGet('fixtures', { team: tfTeamId, last: Math.min(tfLast, 15) }),
          tfLeague ? apiFootballGet('teams/statistics', { team: tfTeamId, league: tfLeague, season: tfSeason }) : Promise.resolve({ ok: false, data: null }),
        ]);
        const tfResult: Record<string, any> = { found: true, team_id: tfTeamId };
        if (tfFixRes.ok && tfFixRes.data?.length) {
          let tw = 0, td = 0, tl = 0, tgf = 0, tga = 0, tbtts = 0, to25 = 0, tcs = 0, tfts = 0;
          const recentForm = tfFixRes.data.map((f: any) => {
            const isH = f.teams?.home?.id === tfTeamId;
            const gf = isH ? (f.goals?.home ?? 0) : (f.goals?.away ?? 0);
            const ga = isH ? (f.goals?.away ?? 0) : (f.goals?.home ?? 0);
            const r = gf > ga ? 'W' : ga > gf ? 'L' : 'D';
            if (r === 'W') tw++; else if (r === 'D') td++; else tl++;
            tgf += gf; tga += ga;
            if (gf > 0 && ga > 0) tbtts++; if (gf + ga > 2) to25++;
            if (ga === 0) tcs++; if (gf === 0) tfts++;
            return { date: f.fixture?.date?.slice(0, 10), opponent: isH ? f.teams?.away?.name : f.teams?.home?.name, venue: isH ? 'home' : 'away', score: `${gf}-${ga}`, result: r, league: f.league?.name };
          });
          const n = recentForm.length; const pts = tw * 3 + td;
          const l5 = recentForm.slice(0, 5);
          const l5pts = l5.reduce((s: number, r: any) => s + (r.result === 'W' ? 3 : r.result === 'D' ? 1 : 0), 0);
          const momentum = l5pts >= 12 ? 'strong' : l5pts >= 8 ? 'steady' : l5pts >= 4 ? 'declining' : 'poor';
          tfResult.form = {
            results: recentForm, form_string: recentForm.map((r: any) => r.result).join(''), momentum,
            stats: { played: n, won: tw, drawn: td, lost: tl, points: pts, goals_for: tgf, goals_against: tga, avg_goals_scored: +(tgf / n).toFixed(2), avg_goals_conceded: +(tga / n).toFixed(2) },
            betting_stats: { btts_pct: +((tbtts / n * 100).toFixed(1)), over_25_pct: +((to25 / n * 100).toFixed(1)), clean_sheet_pct: +((tcs / n * 100).toFixed(1)), failed_to_score_pct: +((tfts / n * 100).toFixed(1)), avg_total_goals: +(((tgf + tga) / n).toFixed(2)) },
          };
          if (recentForm.length >= 2) {
            const dates = recentForm.map((r: any) => new Date(r.date).getTime());
            const daysSince = Math.round((Date.now() - dates[0]) / 86400000);
            const twoWAgo = Date.now() - 14 * 86400000;
            const m14d = dates.filter((d: number) => d >= twoWAgo).length;
            tfResult.context = { days_since_last_match: daysSince, matches_last_14_days: m14d, is_congested: m14d >= 4 };
          }
        }
        if (tfSeasonRes.ok && tfSeasonRes.data) {
          const s = tfSeasonRes.data;
          tfResult.team_name = s.team?.name;
          tfResult.season_stats = {
            league: s.league?.name, season: s.league?.season,
            fixtures: { played: s.fixtures?.played?.total, wins: s.fixtures?.wins?.total, draws: s.fixtures?.draws?.total, losses: s.fixtures?.loses?.total },
            goals: { for_total: s.goals?.for?.total?.total, for_avg: s.goals?.for?.average?.total, against_total: s.goals?.against?.total?.total, against_avg: s.goals?.against?.average?.total },
            clean_sheets: s.clean_sheet?.total, failed_to_score: s.failed_to_score?.total, form: s.form,
          };
        }
        return JSON.stringify(tfResult);
      }

      case 'get_match_odds': {
        const { fixture_id: moFixId, include_predictions: moPred = true } = input;
        const [moOddsRes, moPredRes] = await Promise.all([
          apiFootballGet('odds', { fixture: moFixId }),
          moPred ? apiFootballGet('predictions', { fixture: moFixId }) : Promise.resolve({ ok: false, data: null }),
        ]);
        const moResult: Record<string, any> = { found: true, fixture_id: moFixId };
        if (moOddsRes.ok && moOddsRes.data?.length) {
          const bk = moOddsRes.data[0]?.bookmakers?.[0];
          if (bk) {
            moResult.bookmaker = bk.name;
            const odds: Record<string, any> = {};
            for (const bet of (bk.bets || [])) {
              const vals = (bet.values || []) as Array<{ value: string; odd: string }>;
              if (bet.name === 'Match Winner') {
                odds.match_winner = { home: parseFloat(vals.find((v: any) => v.value === 'Home')?.odd ?? '0'), draw: parseFloat(vals.find((v: any) => v.value === 'Draw')?.odd ?? '0'), away: parseFloat(vals.find((v: any) => v.value === 'Away')?.odd ?? '0') };
              } else if (bet.name === 'Goals Over/Under' || bet.name === 'Over/Under 2.5') {
                const ov = vals.find((v: any) => v.value === 'Over 2.5'); const un = vals.find((v: any) => v.value === 'Under 2.5');
                if (ov || un) odds.over_under_25 = { over: parseFloat(ov?.odd ?? '0'), under: parseFloat(un?.odd ?? '0') };
              } else if (bet.name === 'Both Teams Score') {
                odds.btts = { yes: parseFloat(vals.find((v: any) => v.value === 'Yes')?.odd ?? '0'), no: parseFloat(vals.find((v: any) => v.value === 'No')?.odd ?? '0') };
              }
            }
            moResult.odds = odds;
            const mw = odds.match_winner;
            if (mw?.home && mw?.draw && mw?.away) {
              const ti = 1 / mw.home + 1 / mw.draw + 1 / mw.away;
              moResult.implied_probability = { home: +((1 / mw.home / ti * 100).toFixed(1)), draw: +((1 / mw.draw / ti * 100).toFixed(1)), away: +((1 / mw.away / ti * 100).toFixed(1)), overround_pct: +(((ti - 1) * 100).toFixed(1)) };
            }
          }
        } else {
          moResult.odds = null; moResult.odds_note = 'Odds not yet available (usually 1-3 days before kickoff)';
        }
        if (moPredRes.ok && moPredRes.data?.length) {
          const pred = moPredRes.data[0];
          moResult.predictions = { winner: pred.predictions?.winner?.name, advice: pred.predictions?.advice, percent: pred.predictions?.percent, goals: pred.predictions?.goals };
          if (pred.comparison) moResult.comparison = { form: pred.comparison.form, attack: pred.comparison.att, defense: pred.comparison.def, total: pred.comparison.total };
          if (pred.teams) {
            const mp = (t: any) => ({ name: t.name, form: t.league?.form, attack_avg: t.league?.goals?.for?.average?.total, defense_avg: t.league?.goals?.against?.average?.total });
            moResult.team_overview = { home: pred.teams.home ? mp(pred.teams.home) : null, away: pred.teams.away ? mp(pred.teams.away) : null };
          }
        }
        return JSON.stringify(moResult);
      }

      case 'get_football_injuries': {
        const { fixture_id: injFixId, team_id: injTeamId, season: injSeason = new Date().getFullYear() } = input;
        if (!injFixId && !injTeamId) return JSON.stringify({ found: false, error: 'Provide fixture_id or team_id' });
        const injParams: Record<string, string | number | undefined> = {};
        if (injFixId) injParams.fixture = injFixId;
        if (injTeamId) { injParams.team = injTeamId; injParams.season = injSeason; }
        const injRes = await apiFootballGet('injuries', injParams);
        if (!injRes.ok) return JSON.stringify({ found: false, errors: injRes.errors });
        if (!injRes.data?.length) return JSON.stringify({ found: true, total: 0, message: 'No injuries reported', injuries: [] });
        const byTeam = new Map<number, { name: string; injuries: any[] }>();
        for (const inj of injRes.data) {
          const tid = inj.team?.id; if (!tid) continue;
          if (!byTeam.has(tid)) byTeam.set(tid, { name: inj.team.name, injuries: [] });
          byTeam.get(tid)!.injuries.push({ player: inj.player?.name, type: inj.player?.type, reason: inj.player?.reason });
        }
        return JSON.stringify({
          found: true, ...(injFixId ? { fixture_id: injFixId } : { team_id: injTeamId }), total: injRes.data.length,
          teams: Array.from(byTeam.entries()).map(([id, d]) => ({ team_id: id, team: d.name, total: d.injuries.length, players: d.injuries })),
        });
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

      // ── Agent Trading Execution Tools (Bankr API) ──────────────────────────
      // MIGRATION NOTE (2026-03-16): These tools now route through Bankr API instead of
      // the CDP wallet + Railway Python service. Bankr handles gas, allowances, and signing
      // internally. The static Bankr wallet address is BANKR_WALLET_ADDRESS.
      // REVERT POINT: restore CDP/Railway code from git history (commit 0a9f445 / 418a27e).
      case 'get_agent_wallet_balance': {
        // Use Bankr REST API to get balances for the Bankr agent wallet
        if (!BANKR_API_KEY) throw new Error('Bankr API key not configured (set BANKR_API_KEY in .env.local)');
        console.log(`[balance] Fetching Bankr wallet balances from ${BANKR_API_BASE}/agent/balances?chains=base`);
        const res = await fetch(`${BANKR_API_BASE}/agent/balances?chains=base`, {
          headers: { 'X-API-Key': BANKR_API_KEY },
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) {
          let detail = `HTTP ${res.status}`;
          try { const e = await res.json(); detail = e.error || detail; } catch {}
          throw new Error(`Bankr balance API failed: ${detail}`);
        }
        const data = await res.json();
        const baseBalances = data.balances?.base;
        const ethBalance = parseFloat(baseBalances?.nativeBalance || '0');
        const usdcToken = (baseBalances?.tokenBalances || []).find(
          (t: any) => t.address?.toLowerCase() === USDC_BASE_ADDRESS.toLowerCase()
        );
        const usdcBalance = parseFloat(usdcToken?.token?.balance || '0');
        console.log(`[balance] Bankr wallet: ${ethBalance.toFixed(6)} ETH, ${usdcBalance.toFixed(2)} USDC`);
        return JSON.stringify({
          agent_wallet:           BANKR_WALLET_ADDRESS,
          eth_balance:            ethBalance,
          usdc_balance:           usdcBalance,
          eth_sufficient_for_gas: true, // Bankr manages gas internally
          status:   `✓ Bankr wallet: ${ethBalance.toFixed(6)} ETH, ${usdcBalance.toFixed(2)} USDC`,
          usdc_note: usdcBalance === 0
            ? `Agent wallet has no USDC. Fund it before placing trades.`
            : `${usdcBalance.toFixed(2)} USDC available for trading.`,
        });
      }

      case 'open_trade': {
        // GUARD: Reject execution unless user explicitly approved via TRADE_APPROVED message
        if (!tradeApproved) {
          console.log(`[open_trade] BLOCKED — no TRADE_APPROVED in user message. Must call propose_trade first.`);
          return JSON.stringify({
            error: 'TRADE NOT APPROVED. You must call propose_trade first to show the user a confirmation card. Only call open_trade after the user clicks Approve (TRADE_APPROVED message).',
            action_required: 'Call propose_trade with the trade parameters to show the approval card.',
          });
        }
        // BANKR MIGRATION: Trade execution via Bankr natural-language prompt API.
        // Bankr handles USDC approval, gas, and on-chain tx signing internally.
        const { pair, pair_index, direction, collateral, leverage, tp_pct, sl_pct, order_type = 'MARKET', open_price } = input;
        const action = direction === 'SHORT' ? 'short' : 'buy';
        let prompt = `${action} $${collateral} of ${pair} with ${leverage}x leverage, ${sl_pct}% stop loss, and ${tp_pct}% take profit on avantis`;
        if (order_type === 'LIMIT' && open_price != null) {
          prompt += ` at limit price $${open_price}`;
        }
        console.log(`[open_trade] Bankr prompt: "${prompt}"`);
        emitToStream?.({ type: 'agent_activity', message: `Executing ${direction || 'LONG'} ${pair || 'BTC/USD'} on Avantis...` });
        const job = await submitBankrPrompt(prompt, emitToStream);
        console.log(`[open_trade] Bankr job status=${job.status} response="${(job.response || '').slice(0, 200)}"`);

        // Save position to MongoDB if trade succeeded (response contains tx hash)
        const bankrResponse = job.response || '';
        const txMatch = bankrResponse.match(/0x[a-fA-F0-9]{64}/);
        // Try multiple price patterns from Bankr response
        const pricePatterns = [
          /entry[:\s]*\$?([\d,]+\.?\d*)/i,                    // "entry: $73,499"
          /(?:price|at)[:\s]*\$?([\d,]+\.?\d*)/i,             // "price: $73,499" or "at $73,499"
          /opened?\s+(?:at\s+)?\$?([\d,]+\.?\d*)/i,           // "opened at $73,499"
          /\$?([\d,]+\.?\d{2,})\s*(?:per|\/)/i,               // "$73,499.73 per" or "/BTC"
        ];
        let entryPrice: number | undefined;
        for (const pat of pricePatterns) {
          const m = bankrResponse.match(pat);
          if (m) {
            const parsed = parseFloat(m[1].replace(/,/g, ''));
            if (parsed > 0) { entryPrice = parsed; break; }
          }
        }
        if (job.success && txMatch) {
          try {
            await connectDB();
            await Position.create({
              walletAddress: (wallet || '').toLowerCase(),
              agentWallet: BANKR_WALLET_ADDRESS.toLowerCase(),
              type: 'PERP',
              platform: 'Avantis',
              positionId: `bankr-${txMatch[0].slice(0, 16)}`,
              status: 'active',
              pair: pair?.replace('/USD', '') || 'BTC',
              direction: direction || 'LONG',
              leverage: leverage || 1,
              positionSize: (collateral || 0) * (leverage || 1),
              margin: collateral || 0,
              entryPrice,
              currentPrice: entryPrice, // Mark = Entry at open time
              pnl: 0,
              roi: 0,
              txHash: txMatch[0],
            });
            console.log(`[open_trade] Position saved to MongoDB for wallet=${wallet}, pair=${pair}`);
            // Emit position_opened event so frontend can start 30s polling
            emitToStream?.({ type: 'position_opened', pair, direction, pair_index, agentWallet: BANKR_WALLET_ADDRESS });
          } catch (saveErr: any) {
            console.error(`[open_trade] Failed to save position: ${saveErr.message}`);
          }
        }

        // Append monitoring reminder so agent creates a monitor for this trade
        const monitorReminder = job.success && txMatch
          ? '\n\n[SYSTEM: Trade opened successfully. You MUST now call manage_monitoring to create a monitoring task for this position. Use the strategy signals (RSI, funding rate, etc.) from the trade setup as monitor conditions. Set intervalSeconds to 300. Do NOT skip this step.]'
          : '';
        return (bankrResponse || JSON.stringify({ success: false, error: `Bankr trade failed (status: ${job.status})` })) + monitorReminder;
      }

      case 'close_trade': {
        // BANKR MIGRATION: Close via Bankr natural-language prompt — no pair_index/trade_index needed.
        const { pair_index } = input;
        const pairMap: Record<number, string> = { 1: 'BTC', 2: 'ETH', 3: 'SOL', 4: 'LINK', 5: 'ARB' };
        const pairName = pairMap[pair_index] || 'my';
        const prompt = `close my ${pairName} position on Avantis`;
        console.log(`[close_trade] Bankr prompt: "${prompt}"`);
        emitToStream?.({ type: 'agent_activity', message: `Closing ${pairName} position on Avantis...` });
        const job = await submitBankrPrompt(prompt, emitToStream);
        console.log(`[close_trade] Bankr job status=${job.status} response="${(job.response || '').slice(0, 200)}"`);

        // Mark position as closed in MongoDB + pause related monitors
        const closeResponse = job.response || '';
        const closeTxMatch = closeResponse.match(/0x[a-fA-F0-9]{64}/);
        if (job.success && closeTxMatch) {
          try {
            await connectDB();
            // Extract exit price from close response
            const exitPricePatterns = [
              /(?:exit|close[d]?|price)[:\s]*\$?([\d,]+\.?\d*)/i,
              /at\s+\$?([\d,]+\.?\d{2,})/i,
              /\$?([\d,]+\.?\d{2,})\s*(?:per|\/)/i,
            ];
            let exitPrice: number | undefined;
            for (const pat of exitPricePatterns) {
              const m = closeResponse.match(pat);
              if (m) {
                const parsed = parseFloat(m[1].replace(/,/g, ''));
                if (parsed > 0) { exitPrice = parsed; break; }
              }
            }
            await Position.updateMany(
              {
                agentWallet: BANKR_WALLET_ADDRESS.toLowerCase(),
                platform: 'Avantis',
                status: 'active',
                ...(pairName !== 'my' ? { pair: pairName } : {}),
              },
              { $set: {
                status: 'closed',
                updatedAt: new Date(),
                ...(exitPrice ? { currentPrice: exitPrice } : {}),
              } }
            );
            console.log(`[close_trade] Position marked closed in MongoDB for pair=${pairName}`);

            // Auto-pause any active monitoring tasks related to this pair
            const db = mongoose.connection.db!;
            const tasksCol = db.collection('monitoring_tasks');
            const monitorFilter: any = {
              userId: (wallet || '').toLowerCase(),
              status: 'active',
            };
            // If we know the specific pair, only pause monitors for that pair
            if (pairName !== 'my') {
              monitorFilter.task = { $regex: new RegExp(pairName, 'i') };
            }
            const pauseResult = await tasksCol.updateMany(monitorFilter, {
              $set: { status: 'paused', updatedAt: new Date() },
            });
            if (pauseResult.modifiedCount > 0) {
              console.log(`[close_trade] Auto-paused ${pauseResult.modifiedCount} monitor(s) for pair=${pairName}`);
              emitToStream?.({ type: 'agent_activity', message: `Paused ${pauseResult.modifiedCount} monitor${pauseResult.modifiedCount > 1 ? 's' : ''} — position closed.` });
            }

            emitToStream?.({ type: 'position_closed', pair: pairName, pair_index });
          } catch (closeErr: any) {
            console.error(`[close_trade] Failed to update position: ${closeErr.message}`);
          }
        }

        return closeResponse || JSON.stringify({ success: false, error: `Bankr close failed (status: ${job.status})` });
      }

      case 'cancel_limit_order': {
        // BANKR MIGRATION: Cancel via Bankr natural-language prompt.
        const { pair_index } = input;
        const pairMap: Record<number, string> = { 1: 'BTC', 2: 'ETH', 3: 'SOL', 4: 'LINK', 5: 'ARB' };
        const pairName = pairMap[pair_index] || 'my';
        const prompt = `cancel my ${pairName} limit order on Avantis`;
        console.log(`[cancel_limit_order] Bankr prompt: "${prompt}"`);
        emitToStream?.({ type: 'agent_activity', message: `Cancelling ${pairName} limit order...` });
        const job = await submitBankrPrompt(prompt, emitToStream);
        console.log(`[cancel_limit_order] Bankr job status=${job.status} response="${(job.response || '').slice(0, 200)}"`);
        return job.response || JSON.stringify({ success: false, error: `Bankr cancel failed (status: ${job.status})` });
      }

      case 'withdraw_funds': {
        // BANKR MIGRATION: Withdraw via Bankr /agent/submit REST endpoint (synchronous, returns tx hash).
        // ETH: native transfer. USDC: ERC20 transfer(address,uint256) calldata.
        if (!BANKR_API_KEY) throw new Error('Bankr API key not configured (set BANKR_API_KEY in .env.local)');
        const { amount, asset, to_address } = input;
        let transaction: Record<string, any>;

        if (asset === 'ETH') {
          const weiHex = `0x${BigInt(Math.round(amount * 1e18)).toString(16)}`;
          transaction = { to: to_address, chainId: 8453, value: weiHex };
        } else {
          // USDC ERC20 transfer(address,uint256) — selector 0xa9059cbb
          const usdcUnits = BigInt(Math.round(amount * 1e6));
          const paddedAddr   = to_address.replace('0x', '').toLowerCase().padStart(64, '0');
          const paddedAmount = usdcUnits.toString(16).padStart(64, '0');
          transaction = {
            to: USDC_BASE_ADDRESS,
            chainId: 8453,
            value: '0',
            data: `0xa9059cbb${paddedAddr}${paddedAmount}`,
          };
        }

        console.log(`[withdraw_funds] Bankr submit: ${amount} ${asset} → ${to_address}`);
        const res = await fetch(`${BANKR_API_BASE}/agent/submit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-API-Key': BANKR_API_KEY },
          body: JSON.stringify({
            transaction,
            description: `Withdraw ${amount} ${asset} to ${to_address}`,
            waitForConfirmation: true,
          }),
          signal: AbortSignal.timeout(60_000),
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
          console.error(`[withdraw_funds] Bankr submit failed: ${JSON.stringify(data).slice(0, 300)}`);
          return JSON.stringify({ success: false, error: data.error || `Withdraw failed: HTTP ${res.status}` });
        }
        console.log(`[withdraw_funds] Bankr submit SUCCESS: tx=${data.transactionHash}`);
        return JSON.stringify({
          success: true,
          tx_hash: data.transactionHash,
          status: data.status,
          message: `Withdrew ${amount} ${asset} to ${to_address}. Transaction: ${data.transactionHash}`,
        });
      }

      case 'fund_agent': {
        // BANKR MIGRATION: Deposit targets the Bankr agent wallet directly.
        // Constructs ERC20 transfer calldata inline — no external API call needed.
        if (!agentCtxId) return JSON.stringify({ success: false, error: 'No agent ID in context.' });
        const userWallet = wallet || '';
        if (!userWallet) return JSON.stringify({ success: false, error: 'No user wallet in context.' });
        const { amount } = input;
        // USDC ERC20 transfer(address,uint256) calldata to Bankr wallet
        const usdcUnits = BigInt(Math.round(amount * 1e6));
        const paddedAddr   = BANKR_WALLET_ADDRESS.replace('0x', '').toLowerCase().padStart(64, '0');
        const paddedAmount = usdcUnits.toString(16).padStart(64, '0');
        emitToStream?.({
          type: 'deposit_request',
          amount,
          agent_wallet: BANKR_WALLET_ADDRESS,
          unsigned_tx: {
            to: USDC_BASE_ADDRESS,
            data: `0xa9059cbb${paddedAddr}${paddedAmount}`,
            value: '0x0',
            chainId: 8453,
          },
        });
        return JSON.stringify({
          success: true,
          status: 'awaiting_user_approval',
          message: `A deposit approval card for ${amount} USDC has been shown. The user must click Approve and sign in their wallet.`,
          agent_wallet: BANKR_WALLET_ADDRESS,
        });
      }

      case 'fund_agent_eth': {
        // BANKR MIGRATION: ETH deposit targets the Bankr agent wallet.
        const { amount_eth } = input;
        const weiAmount = BigInt(Math.round(amount_eth * 1e18));
        emitToStream?.({
          type: 'deposit_eth_request',
          amount_eth,
          agent_wallet: BANKR_WALLET_ADDRESS,
          unsigned_tx: {
            to: BANKR_WALLET_ADDRESS,
            data: '0x',
            value: `0x${weiAmount.toString(16)}`,
            chainId: 8453,
          },
        });
        return JSON.stringify({
          success: true,
          status: 'awaiting_user_approval',
          message: `An ETH gas deposit card for ${amount_eth} ETH has been shown. The user must click Approve and sign in their wallet to send ETH to the agent.`,
          agent_wallet: BANKR_WALLET_ADDRESS,
        });
      }

      case 'propose_trade': {
        const { pair, pair_index, direction, collateral, leverage, tp_pct, sl_pct, order_type = 'MARKET', open_price, rationale, entry_conditions, exit_conditions } = input;
        const position_size = collateral * leverage;
        const tradeParams = { pair, pair_index, direction, collateral, leverage, tp_pct, sl_pct, order_type, ...(open_price != null ? { open_price } : {}) };
        // Emit trade_approval event to frontend
        emitToStream?.({
          type: 'trade_approval',
          params: tradeParams,
          rationale: rationale || '',
          position_size,
          entry_conditions: entry_conditions || [],
          exit_conditions: exit_conditions || [],
        });
        return JSON.stringify({
          status: 'pending_approval',
          message: `Trade proposal displayed to user: ${direction} ${pair} — ${collateral} USDC × ${leverage}x = $${position_size} position, TP: ${tp_pct}%, SL: ${sl_pct}%, order: ${order_type}. Waiting for user to click Approve or Cancel.`,
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
const STATIC_SYSTEM_PROMPT = `You are an AI trading agent on Yieldr. You analyze markets (Quant Analyst) and execute trades on Avantis via Bankr wallet (Senior Trader). Discovery → Analysis → Execution is one continuous workflow.

## Core Rules
• NEVER say "I cannot execute trades" or "trading agents launch in beta" — execution is LIVE
• NEVER use "copy", "mirror", "replicate", "follow trades" — frame as "based on my analysis..."
• NEVER fabricate data, tx hashes, or position details — always call tools first
• Use tools proactively. NEVER say you can't fetch data.
• Keep responses 150-250 words default. Use tables for 3+ items.
• Frame as analysis, not financial advice.
• Use emoji icons (🎯 ⚠️ 📊 💼 ⚡) for hierarchy. Use • for bullets. Bold only for tickers ($BTC) and amounts ($1,500).

## Tool Usage
• Top traders → get_top_perp_traders / get_top_pm_traders (with filters: minWinRate, minPnl, category, etc.)
• Positions → get_hl_live_positions / get_pm_live_positions / get_avantis_live_positions
• Batch HL positions → get_hl_live_positions_batch (use for 2+ wallets)
• Market data → get_market_snapshot (PRIMARY — has indicators, funding rate, OI, L/S ratios)
• Live indicators → fetch_live_indicator (when snapshot data_age_minutes > 60)
• Macro → get_macro_snapshot (ETF flows, Fear & Greed, Coinbase premium)
• Funding/OI history → get_derivatives_history (15m, up to 7d); get_funding_rate_history (8h settled, fallback to get_market_snapshot)
• News → get_news_headlines (topics=, sourceTypes=geo/crypto/all)
• Polymarket → get_pm_market (odds/volume), get_pm_user_activity (recent trades)
• Football/Soccer → search_football_fixtures (find matches by team/date/league), get_fixture_details (score/stats/lineups/events), get_football_h2h (H2H history), get_football_standings (league table), get_team_form (recent form + betting stats), get_match_odds (bookmaker odds + AI predictions), get_football_injuries (injury list)
• Web → web_search (expensive ~$0.03, max 2/response, use sparingly)
• Reuse data fetched earlier in conversation when recent.

## Trading Execution — LIVE (Bankr Agent Wallet on Avantis/Base)

### CRITICAL: NEVER call open_trade without user approval
open_trade will REJECT execution unless the user has clicked Approve (TRADE_APPROVED message). You MUST always call propose_trade first. There are NO exceptions.

When a user asks to "design", "set up", or "execute" any trade strategy:
1. Call get_market_snapshot and analyze signals
2. Call propose_trade to show the approval card — ALWAYS, even if user says "execute now"
3. STOP and wait for user to click Approve
4. Only when you receive TRADE_APPROVED: message → call open_trade

### Pre-Trade Workflow (MANDATORY — never skip steps)

1. Call get_market_snapshot to validate entry signals — you MUST identify at least 3 leading indicators (e.g. RSI, funding rate, OI, Stoch RSI, EMA alignment) and state concrete values + thresholds for each
2. Call get_agent_wallet_balance — confirm USDC balance
3. EXPLAIN the strategy to the user in text: describe the setup, why these signals support the trade, entry/exit logic, risk assessment, and key levels. This explanation is IMPORTANT — the user needs to understand the reasoning BEFORE seeing the approval card.
4. Call propose_trade — shows a confirmation card in the UI with all trade params, entry_conditions, and exit_conditions populated from your analysis. ALWAYS call this — NEVER skip to open_trade directly.
5. Wait for user to approve (they click Approve or say "execute"/"yes")
6. Call open_trade with the SAME params from step 4
7. After open_trade succeeds: IMMEDIATELY call manage_monitoring to create a monitoring task using the strategy signals as exit conditions

**Example flow when user says "mean reversion on BTC 10 USDC 10x" and wallet is funded:**
1. Call get_market_snapshot → analyze signals
2. Call get_agent_wallet_balance → confirm USDC ≥ 10 (Bankr manages gas)
3. Call propose_trade → trade confirmation card appears in UI
User approves → call open_trade → report tx_hash from tool result

**TRADE_APPROVED message:** User already approved. Call open_trade IMMEDIATELY with the JSON params — emit NO text before the tool call. Do NOT call propose_trade or get_agent_wallet_balance again.

**If open_trade fails:** Check balance, report error. If INSUFFICIENT_FUNDS: call fund_agent. Do NOT retry without user action.

### Silent Execution Rule
When user signals a transaction: call the tool IMMEDIATELY — zero text before the tool call. Any text before the tool is a hallucination and will be discarded.

### Anti-Hallucination Rules
• NEVER report success unless tool result confirms it (contains tx hash from Bankr)
• NEVER fabricate tx hashes, entry prices, or trade details — only use values from tool results
• NEVER retry same failed operation without user action in between
• NEVER write "executing..." / "placing order..." without actually calling the tool
• A tx hash (0x + 64 hex) MUST NEVER appear in your text unless it came from a Bankr tool result

### Auto-Monitoring After Trade Open — MANDATORY
After every successful open_trade, IMMEDIATELY call manage_monitoring:
• action: "create", intervalSeconds: 300
• task: "[PAIR] [DIRECTION] monitor — [strategy name]"
• tools: [{ toolName: "get_market_snapshot", toolParams: { symbol: "[COIN]", fields: "all" }, extractFields: [strategy signal fields] }]
• monitorInstruction: specific exit conditions with thresholds from the trade strategy
• signals: exit signals with field paths, operators, thresholds
NEVER skip this step.

### Other Rules
• Min position: collateral × leverage ≥ $100 USDC
• ALWAYS check get_agent_wallet_balance before proposing — never assume USDC is available
• propose_trade MUST include entry_conditions + exit_conditions arrays with signal values
• Withdraw: check balance → confirm with user → call withdraw_funds → report only if tx_hash confirmed
• Notifications (Telegram/Discord/SMS): not available yet — say "Coming in V1! Alerts in chat for now."

## Monitoring Tasks
Create persistent monitors via manage_monitoring. Flow: understand what to monitor → call data tools to verify field paths → structure task → confirm with user → create.

### Field Paths Reference
**get_market_snapshot**: indicators.rsi_14 / macd / bbands / ema_8/21/50 / adx / stoch_rsi | derivatives.funding_rate.current/annualized | derivatives.open_interest.total_usd/change_4h_pct/change_24h_pct | derivatives.long_short_ratio.global_accounts/top_accounts | computed.trend_score/momentum_score
**get_derivatives_history**: stats.open_interest.current_usdt/change_4h_pct | stats.long_short_global.current.long_pct/ratio | stats.long_short_top_accounts.*
**get_funding_rate_history**: stats.latest_predicted_rate/avg_24h/avg_7d/trend (SECONDARY — fallback to get_market_snapshot)
Constraints: min 300s interval, max 5 tools, max 10 monitors/user, first cycle = baseline only.
Delete: list → get taskId → delete → confirm { ok: true, deleted: true }.

## Bankr Tool Results
Bankr tools return natural-language text. If it contains a tx hash → success. If it describes failure → report verbatim.
Deposit tools (fund_agent/fund_agent_eth) return [TOOL_RESULT_CLASSIFIED] blocks — follow embedded instructions.

## Key Signals
• RSI > 70 / < 30 → overbought/oversold
• |funding_rate| > 0.0003 (100%+ annualized) → extreme, mean reversion risk
• OI rising + price falling → bearish divergence; OI falling + price rising → short squeeze
• Top trader L/S diverging from retail → smart money signal
• Fear & Greed < 25 → extreme fear (contrarian buy); > 75 → extreme greed
• Positive Coinbase premium → US spot buyers leading (bullish)

## Football / Soccer Match Analysis (Polymarket Sports Betting)
When analyzing a football match on Polymarket, follow this workflow:
1. search_football_fixtures(team="...") → get fixture_id + team IDs
2. get_pm_market(keyword="Team A Team B") → Polymarket odds/prices
3. get_fixture_details(fixture_id=X) → match stats if live/completed
4. get_team_form(team_id=X, league=Y) → recent form, betting stats, momentum
5. get_football_h2h(team_a=X, team_b=Y) → H2H history, BTTS%, O2.5%
6. get_match_odds(fixture_id=X) → bookmaker odds + implied probabilities
7. get_football_injuries(fixture_id=X) → injury impact
8. get_football_standings(league=Y) → league position context
Compare bookmaker implied_probability with Polymarket prices — delta > 3% = potential edge.
Common league IDs: 39=Premier League, 140=La Liga, 135=Serie A, 78=Bundesliga, 61=Ligue 1, 2=UCL, 3=Europa League.
API-Football free tier: ~100 calls/day — full analysis costs ~7-8 calls, so be efficient. Reuse data.

## Data & Positions
• Always call tools before presenting data — never fabricate
• Reuse recent data from conversation when possible
• Filter noise: skip positions < $1, PnL < -80%, max 10 per trader
• Batch HL positions: use get_hl_live_positions_batch for 2+ wallets
• Fallback: if trader has 0 positions → fetch top traders for that asset instead
• ROI projections need: win rate + sample size + profit factor + time period

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
  agentId: string;
  agentWalletAddress: string;
  positions: any[];
  followedTraders: any[];
  portfolioSummary: any;
  tokens: any[];
  tokensTotalUsd: number;
}): string {
  const { walletAddress, agentName, agentId, agentWalletAddress, positions, followedTraders, portfolioSummary, tokens, tokensTotalUsd } = context;

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
Agent ID: ${agentId || 'N/A'}
Agent Wallet (CDP — signup only): ${agentWalletAddress || 'Not configured — wallet not yet created'}
Trade Execution Wallet (Bankr): ${BANKR_WALLET_ADDRESS}
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
    let agentId = '';
    let agentWalletAddress = '';
    let tokens: any[] = [];
    let tokensTotalUsd = 0;

    if (db && wallet) {
      const [agent, positionDocs] = await Promise.all([
        Agent.findOne({ ownerWallet: wallet.toLowerCase() }),
        db.collection('positions').find({ walletAddress: wallet.toLowerCase() }).toArray(),
      ]);

      if (agent) {
        agentName = agent.name || agentName;
        agentId = agent.agentId || '';
        agentWalletAddress = agent.agentWalletAddress || '';
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
      walletAddress: walletLower, agentName, agentId, agentWalletAddress, positions, followedTraders, portfolioSummary, tokens, tokensTotalUsd,
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

    // Convert messages to Anthropic format — keep only last 10 messages to limit token growth.
    // Older messages are summarized into a single context line.
    const MAX_HISTORY_MESSAGES = 10;
    let trimmedMessages = messages;
    let historyPreamble = '';
    if (messages.length > MAX_HISTORY_MESSAGES) {
      const oldMessages = messages.slice(0, messages.length - MAX_HISTORY_MESSAGES);
      trimmedMessages = messages.slice(messages.length - MAX_HISTORY_MESSAGES);
      // Create a brief summary of older messages for context continuity
      const oldTopics = oldMessages
        .filter((m: any) => m.role === 'user')
        .map((m: any) => (m.content || '').slice(0, 80))
        .join('; ');
      historyPreamble = `[Earlier in this conversation the user discussed: ${oldTopics.slice(0, 300)}. Refer to recent messages for current context.]`;
      console.log(`[chat] Trimmed conversation: ${messages.length} → ${trimmedMessages.length} messages (dropped ${oldMessages.length} old)`);
    }

    const anthropicMessages: Anthropic.MessageParam[] = [
      // Inject history summary if messages were trimmed
      ...(historyPreamble ? [{ role: 'user' as const, content: historyPreamble }, { role: 'assistant' as const, content: 'Understood, I have context from our earlier discussion.' }] : []),
      ...trimmedMessages.map((m: { role: string; content: string }) => ({
        role: m.role === 'agent' ? 'assistant' as const : 'user' as const,
        content: m.content,
      })),
    ];

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
        // Tracks classified results for all execution tools called this request
        const allClassifiedResults: ClassifiedResult[] = [];
        const modelUsed = 'claude-sonnet-4-5-20250929';
        try {
          // Agentic loop: keep calling Claude until it stops using tools
          let currentMessages = [...anthropicMessages];
          let maxIterations = 5; // safety limit

          // Detect execution-intent messages and force tool use from the very first iteration.
          // This prevents the LLM from generating a text-only "narration" response before
          // calling the tool (which causes the fake-text hallucination the user sees).
          // Without this, forceToolUse only activates in iteration 2 (after the hallucination
          // detector fires), by which point the fake text was already streamed.
          const lastMsgText = typeof lastUserMessage?.content === 'string'
            ? lastUserMessage.content
            : Array.isArray(lastUserMessage?.content)
              ? lastUserMessage.content.map((b: any) => (b.text ?? '')).join(' ')
              : '';
          // Any message matching these patterns means the user wants an on-chain action right now.
          // Patterns are intentionally NOT ^-anchored so they catch phrasings like
          // "lets execute", "deposit confirmed, now execute", "close my position", etc.
          // Keep patterns specific enough to avoid false positives on informational questions.
          const EXECUTION_TRIGGER_PATTERNS = [
            // Trade card approval (always explicit)
            /TRADE_APPROVED:/i,

            // Retry / proceed / confirm execution
            /\btry\s+again\b/i,           // "try again", "let's try again"
            /\bretry\b/i,                 // "retry", "retry the trade"
            /\bgo\s+ahead\b/i,            // "go ahead"
            /\bproceed\b/i,               // "proceed", "proceed with the trade"
            /\bdo\s+it\b/i,               // "do it", "just do it"
            /\bgo\s+for\s+it\b/i,         // "go for it"
            /\byes[,!]?\s*(execute|proceed|open|close|trade|withdraw|deposit|go|do)/i,

            // Execute (the most common verb users type)
            /\bexecute\b/i,               // "execute", "let's execute", "please execute"

            // Trade open
            /\bplace\s+(the\s+|a\s+|my\s+)?order\b/i,
            /\bplace\s+(the\s+|a\s+)?trade\b/i,
            /\bopen\s+(the\s+|a\s+|my\s+)?(trade|position|order)\b/i,
            /\bstart\s+(the\s+)?(trade|position)\b/i,
            /\benter\s+(the\s+)?(trade|position|market)\b/i,
            /\b(let'?s?\s+)?trade\s+(now|it)\b/i,

            // Trade close
            /\bclose\s+(the\s+|my\s+|this\s+)?(trade|position|order)\b/i,
            /\bclose\s+(it|now|out)\b/i,
            /\bexit\s+(the\s+|my\s+|this\s+)?(trade|position)\b/i,
            /\bexit\s+(now|it)\b/i,

            // Cancel limit order
            /\bcancel\s+(the\s+|my\s+)?(limit\s+)?order\b/i,
            /\bcancel\s+(it|now)\b/i,

            // Withdraw / send funds out
            /\bwithdraw\b/i,              // "withdraw", "withdraw funds", "withdraw 10 usdc"
            /\bsend\s+back\b/i,           // "send back my funds"
            /\bsend\s+(my\s+)?(eth|usdc|funds|money)\b/i,
            /\btransfer\s+(back|funds|eth|usdc|out)\b/i,
            /\bpull\s+(out|funds|my\s+funds)\b/i,
            /\bget\s+my\s+(eth|usdc|funds|money)\s+back\b/i,
            /\breclaim\b/i,

            // Deposit / fund agent — user saying funds are sent and wants to continue
            /\bdeposit\s+(confirmed|done|complete|sent|successful|went\s+through)\b/i,
            /\b(i('?ve?)?|just)\s+deposited\b/i,
            /\bdeposit(ed|ing)?\s+(eth|usdc|funds)\b/i,
            /\bsent\s+(the\s+)?(eth|usdc|funds)\b/i,
            /\bfund(ed|ing)?\s+(the\s+)?(agent|wallet)\b/i,
            /\btransferred\s+(the\s+)?(eth|usdc|funds)\b/i,

            // Generic "now" + action shorthand after a setup
            /\bnow\s+(execute|trade|open|close|withdraw|deposit|proceed)\b/i,
            /\b(do|make|run)\s+(the\s+)?(trade|transaction|trx|tx|swap|withdrawal|deposit)\b/i,
          ];
          let forceToolUse = EXECUTION_TRIGGER_PATTERNS.some(p => p.test(lastMsgText.trim()));
          if (forceToolUse) {
            console.log(`[chat] Execution-intent message detected — starting with forceToolUse=true to prevent hallucination`);
          }

          // Track text accumulated only in the current iteration (for hallucination detection)
          let iterationText = '';

          while (maxIterations > 0) {
            maxIterations--;
            iterationText = '';

            const response = await callClaudeWithRetry(() =>
              anthropic.messages.create({
                model: 'claude-sonnet-4-5-20250929',
                max_tokens: 4096,
                system: systemMessage,
                messages: currentMessages,
                tools: allTools,
                // Force tool use when agent described actions without calling tools
                ...(forceToolUse ? { tool_choice: { type: 'any' as const } } : {}),
                stream: true,
              })
            );
            forceToolUse = false; // reset after use

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
                  iterationText += event.delta.text;
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
                  // Execute the tool (emitToStream lets tools push special events to the frontend)
                  const emitToStream = (event: any) => controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
                  const isTradeApproved = /TRADE_APPROVED:/i.test(lastMsgText);
                  const rawToolResult = await executeTool(currentToolName, parsedInput, walletLower, agentId, agentWalletAddress, emitToStream, isTradeApproved);

                  // Classify execution tool results — Claude receives the classified message,
                  // never the raw JSON. Non-execution tools pass through unchanged.
                  let toolResult: string;
                  if (EXECUTION_TOOLS.has(currentToolName)) {
                    const classified = classifyToolResult(currentToolName, rawToolResult);
                    allClassifiedResults.push(classified);
                    toolResult = classified.classifiedMessage;
                    console.log(`[toolResultInterpreter] ${currentToolName} → ${classified.status}`);
                  } else {
                    toolResult = rawToolResult;
                  }

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

            // If no tool calls, check if the agent described trading actions without calling tools
            if (!hasToolUse) {
              const textLower = iterationText.toLowerCase();
              // Keywords that indicate the agent NARRATED execution without calling tools
              // (NOT strategy explanation — only actual "I did X" narration)
              const executionKeywords = [
                // deposit/fund patterns
                'deposit card', 'funding card', 'fund_agent', 'eth deposit', 'usdc deposit',
                'generating deposit', 'full workflow', 'running the full workflow',
                'deposit approval', 'approve both', 'approve the deposit',
                // trade execution narration (agent describes calling tool without doing it)
                'executing now', 'executing trade', 'executing the trade', 'calling open_trade',
                'placing the trade', 'placing order', 'opening position', 'opening the position',
                'calling close_trade', 'closing position', 'closing the position',
                'calling withdraw', 'sending back funds', 'funds sent',
                'withdrawal complete', 'funds withdrawn', 'successfully withdrawn',
                'trade executed', 'position opened', 'order placed', 'order confirmed',
                'trade confirmed', 'successfully executed', 'successfully opened',
              ];
              const tradingToolNames = ['get_agent_wallet_balance', 'fund_agent_eth', 'fund_agent', 'propose_trade', 'open_trade', 'close_trade', 'withdraw_funds', 'cancel_limit_order'];
              const executionToolNames = ['open_trade', 'close_trade', 'withdraw_funds', 'cancel_limit_order'];
              const analysisToolNames = ['get_market_snapshot', 'fetch_live_indicator', 'get_macro_snapshot', 'get_funding_rate_history', 'get_derivatives_history', 'search_football_fixtures', 'get_fixture_details', 'get_football_h2h', 'get_football_standings', 'get_team_form', 'get_match_odds', 'get_football_injuries'];
              const describedExecution = executionKeywords.some(kw => textLower.includes(kw));
              const noTradingToolsCalled = !allToolCalls.some(t => tradingToolNames.includes(t.name));
              // Skip hallucination check if agent already called analysis tools — it's explaining the strategy before propose_trade
              const calledAnalysisTools = allToolCalls.some(t => analysisToolNames.includes(t.name));
              const calledProposeTrade = allToolCalls.some(t => t.name === 'propose_trade');
              // Also catch fabricated tx_hashes: if Claude put a 0x...64-char hash in text without calling an execution tool
              const TX_HASH_IN_TEXT = /0x[a-fA-F0-9]{64}/.test(iterationText);
              const noExecutionToolsCalled = !allToolCalls.some(t => executionToolNames.includes(t.name));
              const fabricatedHashInNarration = TX_HASH_IN_TEXT && noExecutionToolsCalled;

              // Don't trigger if agent is in the pre-trade workflow (analysis done, explaining before propose_trade)
              const isPreTradeExplanation = calledAnalysisTools && !calledProposeTrade;

              if (((describedExecution && noExecutionToolsCalled && !isPreTradeExplanation) || fabricatedHashInNarration) && maxIterations > 0) {
                // Agent hallucinated execution — narrated a trade/withdrawal or fabricated a tx_hash without calling the tool.
                // Use noExecutionToolsCalled (not noTradingToolsCalled) so this fires even if balance/propose were already called.
                console.log(`[chat] Hallucination detected: ${fabricatedHashInNarration ? 'fabricated tx_hash in text without calling execution tool' : 'agent described trading actions without calling execution tool'}. Forcing tool invocation.`);
                // Tell the frontend to wipe the fake text it already streamed — the real tool result will follow.
                controller.enqueue(encoder.encode(
                  JSON.stringify({ type: 'hallucination_correction' }) + '\n'
                ));
                // Reset fullResponse so the real content replaces the hallucinated text in DB
                fullResponse = '';
                currentMessages = [
                  ...currentMessages,
                  { role: 'assistant' as const, content: iterationText },
                  {
                    role: 'user' as const,
                    content: 'SYSTEM: You described a trading or withdrawal action in text but did not call any tools. This is a hallucination. You MUST call the actual tool now — do not generate more text. If you intended to call open_trade, call it. If you intended to call withdraw_funds, call it. If you intended to call close_trade, call it. Do not narrate what you are doing — just invoke the tool.',
                  },
                ];
                forceToolUse = true;
                continue;
              }
              break;
            }

            // Add assistant message with tool calls + tool results, then loop
            currentMessages = [
              ...currentMessages,
              { role: 'assistant', content: contentBlocks },
              ...toolResults,
            ];
          }

          // Post-response hallucination detection: log only — do NOT replace streamed content.
          // Replacing causes bad UX: user sees content appear then get swapped out.
          // Prevention is handled upstream via the classified message Claude receives and the system prompt rules.
          if (allClassifiedResults.length > 0 && fullResponse) {
            const hallucinationOverride = detectPostResponseHallucination(allClassifiedResults, fullResponse);
            if (hallucinationOverride) {
              console.warn('[chat] Post-response hallucination detected (logged only, not replacing streamed content)');
            }
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
