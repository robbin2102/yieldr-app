import { NextRequest } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import connectDB from '@/lib/mongoose';
import mongoose from 'mongoose';
import Agent from '@/models/Agent';
import ChatSession from '@/models/ChatSession';
import { trackUsage, TokenUsageData } from '@/lib/tokenTracking';
import { fetchNews, formatArticlesForLLM } from '@/lib/rss';
import {
  classifyToolResult,
  validateBalanceForTrade,
  detectPostResponseHallucination,
  EXECUTION_TOOLS,
  type ClassifiedResult,
} from '@/lib/toolResultInterpreter';

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
    description: 'Fetch Polymarket market data including outcomes, current odds/probabilities, volume, and liquidity. Look up by slug, conditionId, or keyword search.',
    input_schema: {
      type: 'object' as const,
      properties: {
        slug: { type: 'string', description: 'Market slug (e.g. "will-israel-attack-iran-in-2025")' },
        conditionId: { type: 'string', description: 'Market condition ID (0x hex string)' },
        keyword: { type: 'string', description: 'Search keyword to find markets by title (e.g. "bitcoin", "trump", "taiwan")' },
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
    'Check the agent CDP wallet ETH and USDC balance. Call this BEFORE executing any trade or generating deposit cards. ' +
    'ETH is needed for gas fees (minimum 0.001 ETH on Base for Avantis execution fee + gas). USDC is the trade collateral. ' +
    'After checking: if ETH < 0.001 call fund_agent_eth; if USDC < required collateral call fund_agent. ' +
    'If ETH >= 0.001, skip gas deposit — do NOT suggest ETH deposit when gas is sufficient. ' +
    'Both cards can be emitted in the same response — call both tools without waiting for user approval.',
  input_schema: {
    type: 'object' as const,
    properties: {},
  },
});

toolDefinitions.push({
  name: 'open_trade',
  description:
    'Execute a perpetual trade on Avantis (Base). Call get_agent_wallet_balance first UNLESS responding to a TRADE_APPROVED: message (balance was already checked). ' +
    'Minimum position size: collateral × leverage >= $100 USDC. ' +
    'Pair indices: 1=BTC/USD, 2=ETH/USD, 3=SOL/USD, 4=LINK/USD, 5=ARB/USD. ' +
    'For MARKET orders open_price is not needed. For LIMIT orders open_price is required. ' +
    'Returns tx_hash, entry_price, trade_index, tp_price, sl_price.',
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
    'Withdraw ETH or USDC from the agent CDP wallet to a destination address. ' +
    'The agent wallet signs and sends autonomously — no user signature needed. ' +
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
    'Deposit USDC from the user\'s connected wallet into the agent CDP wallet. ' +
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
    'Deposit ETH from the user\'s connected wallet into the agent CDP wallet for gas fees. ' +
    'Call this when agent ETH balance is below 0.001 ETH (minimum for Avantis execution fee + Base gas). ' +
    'Emits an ETH deposit approval card — the user must click Approve and sign in their wallet. ' +
    'Default deposit: 0.001 ETH (enough for ~5 trades).',
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
    case 'get_agent_wallet_balance':
      return `Checking agent wallet balance...`;
    case 'open_trade':
      return `Executing ${input.direction || ''} ${input.pair || ''} ${input.order_type || 'MARKET'} order...`.trim();
    case 'close_trade':
      return `Closing position (pair_index=${input.pair_index}, trade_index=${input.trade_index})...`;
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

async function executeTool(name: string, input: any, wallet?: string, agentCtxId?: string, agentCtxWallet?: string, emitToStream?: (event: any) => void): Promise<string> {
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
      case 'get_pm_market': {
        const { slug, conditionId, keyword, limit: mktLimit = 5, activeOnly = true } = input;
        if (!slug && !conditionId && !keyword) return JSON.stringify({ error: 'Provide slug, conditionId, or keyword' });
        const GAMMA_API = 'https://gamma-api.polymarket.com';
        let url: string;
        if (conditionId) {
          url = `${GAMMA_API}/markets?condition_id=${encodeURIComponent(conditionId)}`;
        } else if (slug) {
          url = `${GAMMA_API}/markets?slug=${encodeURIComponent(slug)}`;
        } else {
          const p = new URLSearchParams({ _q: keyword, limit: String(Math.min(mktLimit, 20)), order: 'volume', ascending: 'false', ...(activeOnly ? { active: 'true', closed: 'false' } : {}) });
          url = `${GAMMA_API}/markets?${p.toString()}`;
        }
        const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
        if (!res.ok) return JSON.stringify({ error: `Gamma API error: ${res.status}` });
        const raw = await res.json();
        const markets = (Array.isArray(raw) ? raw : [raw]).map((m: any) => {
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

      // ── Agent Trading Execution Tools ────────────────────────────────────────
      case 'get_agent_wallet_balance': {
        if (!agentCtxWallet) {
          return JSON.stringify({ error: 'No agent wallet configured. The agent does not have a CDP wallet yet.' });
        }
        const pythonUrl = normalizeUrl(process.env.PYTHON_SERVICE_URL || 'http://localhost:8001');
        const apiKey    = process.env.YIELDR_DATA_API_SECRET || process.env.API_KEY || '';
        if (!apiKey) console.warn('[balance] WARNING: no API key set (YIELDR_DATA_API_SECRET / API_KEY)');
        const res = await fetch(
          `${pythonUrl}/trade/balance?agent_wallet_address=${encodeURIComponent(agentCtxWallet)}`,
          { headers: { 'X-API-Key': apiKey }, signal: AbortSignal.timeout(30_000) }
        );
        if (!res.ok) {
          let detail = `HTTP ${res.status}`;
          try { const e = await res.json(); detail = e.detail || e.error || detail; } catch {}
          console.error(`[balance] fetch failed: ${detail} — url=${pythonUrl}, key_set=${!!apiKey}`);
          throw new Error(`Balance fetch failed (${detail}). Check PYTHON_SERVICE_URL and YIELDR_DATA_API_SECRET env vars.`);
        }
        const data = await res.json();
        const eth = data.eth_balance ?? 0;
        const usdc = data.usdc_balance ?? 0;
        return JSON.stringify({
          agent_wallet:           agentCtxWallet,
          eth_balance:            eth,
          usdc_balance:           usdc,
          eth_sufficient_for_gas: eth >= 0.001,
          status: eth < 0.001
            ? `⚠️ Low ETH: ${eth.toFixed(6)} ETH — send at least 0.001 ETH to ${agentCtxWallet} for gas`
            : `✓ ETH OK (${eth.toFixed(6)} ETH)`,
          usdc_note: usdc === 0
            ? `Agent wallet has no USDC. Fund it before placing trades.`
            : `${usdc.toFixed(2)} USDC available for trading.`,
        });
      }

      case 'open_trade': {
        if (!agentCtxId) return JSON.stringify({ success: false, error: 'No agent ID in context.' });
        if (!agentCtxWallet) return JSON.stringify({ success: false, error: 'No agent wallet configured.' });
        const { pair, pair_index, direction, collateral, leverage, tp_pct, sl_pct, order_type = 'MARKET', open_price } = input;
        console.log(`[open_trade] ── ENTER ── pair=${pair} direction=${direction} collateral=${collateral} leverage=${leverage} wallet=${agentCtxWallet} agentId=${agentCtxId}`);

        // ── Preflight: hard balance gate — no silent bypass ──────────────────
        {
          let rawBalanceResponse: string | null = null;
          try {
            const balUrl = normalizeUrl(process.env.PYTHON_SERVICE_URL || 'http://localhost:8001');
            const balKey = process.env.YIELDR_DATA_API_SECRET || process.env.API_KEY || '';
            console.log(`[open_trade] balance preflight: GET ${balUrl}/trade/balance wallet=${agentCtxWallet}`);
            const balRes = await fetch(
              `${balUrl}/trade/balance?agent_wallet_address=${encodeURIComponent(agentCtxWallet)}`,
              { headers: { 'X-API-Key': balKey }, signal: AbortSignal.timeout(15_000) }
            );
            if (balRes.ok) {
              rawBalanceResponse = await balRes.text();
              console.log(`[open_trade] balance preflight OK: ${rawBalanceResponse.slice(0, 200)}`);
            } else {
              console.warn(`[open_trade] balance preflight HTTP ${balRes.status} — hard gate blocking trade`);
            }
          } catch (balErr: any) {
            console.warn(`[open_trade] balance preflight fetch failed: ${balErr.message} — hard gate blocking trade`);
          }
          const gate = validateBalanceForTrade(rawBalanceResponse, collateral);
          console.log(`[open_trade] balance gate: allowed=${gate.allowed} status=${gate.classifiedResult.status} rawLen=${rawBalanceResponse?.length ?? 'null'}`);
          if (!gate.allowed) {
            console.warn(`[open_trade] BLOCKED by balance gate: ${gate.classifiedResult.classifiedMessage.slice(0, 300)}`);
            return gate.classifiedResult.classifiedMessage;
          }
        }
        // ────────────────────────────────────────────────────────────────────

        const nextjsUrl    = normalizeUrl(process.env.NEXTJS_API_URL || 'http://localhost:3000');
        const internalSec  = process.env.YIELDR_INTERNAL_SECRET || '';
        console.log(`[open_trade] calling execute/open → ${nextjsUrl}/api/avantis/execute/open (internalSec set=${!!internalSec})`);
        const tradeBody: Record<string, any> = {
          agentId: agentCtxId,
          userId:  wallet || '',
          pair, pair_index, direction, collateral, leverage, tp_pct, sl_pct,
          order_type,
          createMonitor: true,
          monitorIntervalSeconds: 300,
          monitorInstruction: `Monitor ${pair} ${direction} trade opened by ${agentCtxId}. TP at ${tp_pct}%, SL at ${sl_pct}%. Alert if exit conditions are met.`,
        };
        if (order_type === 'LIMIT' && open_price != null) tradeBody.open_price = open_price;
        const res = await fetch(`${nextjsUrl}/api/avantis/execute/open`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(internalSec ? { Authorization: `Bearer ${internalSec}` } : {}),
          },
          body: JSON.stringify(tradeBody),
          signal: AbortSignal.timeout(60_000),
        });
        console.log(`[open_trade] execute/open response: HTTP ${res.status}`);
        const data = await res.json();
        if (!res.ok) {
          console.error(`[open_trade] execute/open FAILED: HTTP ${res.status} error="${data.error}" body=${JSON.stringify(data).slice(0, 300)}`);
          return JSON.stringify({ success: false, error: data.error || `Trade failed: HTTP ${res.status}` });
        }
        console.log(`[open_trade] execute/open SUCCESS: tx_hash=${data.tx_hash ?? data.trade?.tx_hash ?? 'none'}`);
        return JSON.stringify({ success: true, ...data });
      }

      case 'close_trade': {
        if (!agentCtxId) return JSON.stringify({ success: false, error: 'No agent ID in context.' });
        const { pair_index, trade_index, collateral_to_close } = input;
        const nextjsUrl   = normalizeUrl(process.env.NEXTJS_API_URL || 'http://localhost:3000');
        const internalSec = process.env.YIELDR_INTERNAL_SECRET || '';
        const res = await fetch(`${nextjsUrl}/api/avantis/execute/close`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(internalSec ? { Authorization: `Bearer ${internalSec}` } : {}),
          },
          body: JSON.stringify({ agentId: agentCtxId, userId: wallet || '', pair_index, trade_index, collateral_to_close }),
          signal: AbortSignal.timeout(60_000),
        });
        const data = await res.json();
        if (!res.ok) return JSON.stringify({ success: false, error: data.error || `Close failed: HTTP ${res.status}` });
        return JSON.stringify({ success: true, ...data });
      }

      case 'cancel_limit_order': {
        if (!agentCtxId) return JSON.stringify({ success: false, error: 'No agent ID in context.' });
        const { pair_index, trade_index } = input;
        const nextjsUrl   = normalizeUrl(process.env.NEXTJS_API_URL || 'http://localhost:3000');
        const internalSec = process.env.YIELDR_INTERNAL_SECRET || '';
        const res = await fetch(`${nextjsUrl}/api/avantis/execute/cancel-limit`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(internalSec ? { Authorization: `Bearer ${internalSec}` } : {}),
          },
          body: JSON.stringify({ agentId: agentCtxId, userId: wallet || '', pair_index, trade_index }),
          signal: AbortSignal.timeout(60_000),
        });
        const data = await res.json();
        if (!res.ok) return JSON.stringify({ success: false, error: data.error || `Cancel failed: HTTP ${res.status}` });
        return JSON.stringify({ success: true, ...data });
      }

      case 'withdraw_funds': {
        if (!agentCtxId) return JSON.stringify({ success: false, error: 'No agent ID in context.' });
        if (!agentCtxWallet) return JSON.stringify({ success: false, error: 'No agent wallet configured.' });
        const { amount, asset, to_address } = input;
        const nextjsUrl   = normalizeUrl(process.env.NEXTJS_API_URL || 'http://localhost:3000');
        const internalSec = process.env.YIELDR_INTERNAL_SECRET || '';
        const res = await fetch(`${nextjsUrl}/api/avantis/withdraw`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(internalSec ? { Authorization: `Bearer ${internalSec}` } : {}),
          },
          body: JSON.stringify({ agentId: agentCtxId, amount, asset, to_address }),
          signal: AbortSignal.timeout(60_000),
        });
        const data = await res.json();
        if (!res.ok) return JSON.stringify({ success: false, error: data.error || `Withdraw failed: HTTP ${res.status}` });
        return JSON.stringify({ success: true, ...data });
      }

      case 'fund_agent': {
        if (!agentCtxId) return JSON.stringify({ success: false, error: 'No agent ID in context.' });
        const userWallet = wallet || '';
        if (!userWallet) return JSON.stringify({ success: false, error: 'No user wallet in context.' });
        const { amount } = input;
        const nextjsUrl   = normalizeUrl(process.env.NEXTJS_API_URL || 'http://localhost:3000');
        const internalSec = process.env.YIELDR_INTERNAL_SECRET || '';
        const res = await fetch(`${nextjsUrl}/api/avantis/fund`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(internalSec ? { Authorization: `Bearer ${internalSec}` } : {}),
          },
          body: JSON.stringify({ agentId: agentCtxId, amount, user_wallet_address: userWallet }),
          signal: AbortSignal.timeout(30_000),
        });
        const data = await res.json();
        if (!res.ok) return JSON.stringify({ success: false, error: data.error || `Fund request failed: HTTP ${res.status}` });
        // Emit deposit_request event to frontend for user to approve via wagmi
        emitToStream?.({
          type: 'deposit_request',
          amount,
          agent_wallet: data.agent_wallet,
          unsigned_tx: data.unsigned_tx,
        });
        return JSON.stringify({
          success: true,
          status: 'awaiting_user_approval',
          message: `A deposit approval card for ${amount} USDC has been shown. The user must click Approve and sign in their wallet.`,
          agent_wallet: data.agent_wallet,
        });
      }

      case 'fund_agent_eth': {
        if (!agentCtxWallet) return JSON.stringify({ success: false, error: 'No agent wallet configured.' });
        const { amount_eth } = input;
        const weiAmount = BigInt(Math.round(amount_eth * 1e18));
        // Emit deposit_eth_request — native ETH transfer, no ERC20 calldata needed
        emitToStream?.({
          type: 'deposit_eth_request',
          amount_eth,
          agent_wallet: agentCtxWallet,
          unsigned_tx: {
            to: agentCtxWallet,
            data: '0x',
            value: `0x${weiAmount.toString(16)}`,
            chainId: 8453,
          },
        });
        return JSON.stringify({
          success: true,
          status: 'awaiting_user_approval',
          message: `An ETH gas deposit card for ${amount_eth} ETH has been shown. The user must click Approve and sign in their wallet to send ETH to the agent.`,
          agent_wallet: agentCtxWallet,
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
const STATIC_SYSTEM_PROMPT = `You are an AI trading and investment agent on the Yieldr platform operating in two distinct modes simultaneously.

## 🧠 Your Two Roles

**Role 1 — Quant Analyst**
You discover, monitor, and synthesise alpha across perpetual and prediction markets. This includes:
• Scanning top performer data across Hyperliquid, Avantis, and Polymarket
• Identifying positioning patterns, funding rate anomalies, and market structure setups
• Building allocation plans and diversified portfolio strategies grounded in live data
• Monitoring conditions and alerting users when thresholds are crossed
• Framing all insights as data-driven analysis, never as personal financial advice

**Role 2 — Senior Trader**
You execute trade strategies directly on-chain using the agent's CDP wallet on Avantis (Base). This includes:
• Opening, managing, and closing perpetual positions on Avantis
• Placing and cancelling limit orders
• Running the full pre-trade workflow (signal validation → balance verification → proposal → execution)
• Withdrawing funds from the agent wallet back to the user
You execute when: (a) your own analysis produces a high-conviction setup, or (b) the user instructs you to trade a specific strategy. In both cases you run the full pre-trade workflow immediately — you do not ask the user to say "execute" as a second step.

**The two roles work together:** Discovery → Analysis → Execution is a single continuous workflow. When your Quant Analyst role surfaces a setup, your Senior Trader role evaluates whether to act. If the setup is actionable and the user is engaged, run the pre-trade workflow in the same response.

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
• get_pm_market — Fetch Polymarket market odds, outcomes, volume, and liquidity. Search by keyword (e.g. "taiwan", "bitcoin etf") or look up by slug/conditionId. Use to check current market prices for any topic.
• get_pm_user_activity — Fetch recent Polymarket trades (buys/sells/redeems) for any wallet. Filter by market, side, or days back. Use to see what a wallet is actively trading on Polymarket.
• web_search — Search the web for market news, macro events (native Claude tool)

**Trading Execution (agent CDP wallet — LIVE):**
• get_agent_wallet_balance — Check agent wallet ETH (gas) and USDC (collateral) balances before trading
• propose_trade — Show a trade confirmation card to the user BEFORE executing (REQUIRED first step)
• open_trade — Execute MARKET or LIMIT perpetual order on Avantis (Base). Only call AFTER user approves propose_trade AND balance is sufficient.
• close_trade — Close an open Avantis position. Use get_avantis_live_positions first for trade_index.
• cancel_limit_order — Cancel a pending Avantis limit order.
• withdraw_funds — Withdraw ETH or USDC from the agent wallet back to the user's wallet.

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
• When user asks about a Polymarket market's current odds/prices → call get_pm_market with keyword or slug
• When user asks what a wallet has been trading on Polymarket → call get_pm_user_activity
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
I can execute this portfolio plan directly on Avantis (Base) using the agent wallet. Say "execute" or "run this" and I'll run the full pre-trade workflow immediately.

---

## 🚀 Trading Execution — LIVE

You CAN execute perpetual trades directly on Avantis (Base) using the agent's CDP wallet.

DO NOT say:
• "I cannot execute trades"
• "I don't have wallet access"
• "Trading agents launch in beta"
• Any framing around "copy trading" or "replicating" other traders
• "Fund your wallet first, then say execute" — NEVER make the user do extra steps. Run the full workflow immediately.

### CRITICAL: When to Run the Full Pre-Trade Workflow

**ANY TIME you have a concrete trade to propose** — whether the user said "suggest a strategy", "execute", "trade BTC", or anything that leads to a specific pair/direction/collateral/leverage — you MUST immediately run the full Pre-Trade Workflow in the SAME response. Do NOT stop after analysis and ask the user to "say execute".

### Pre-Trade Workflow

1. Call get_market_snapshot (or fetch_live_indicator) to validate entry signals
2. Call get_agent_wallet_balance — show the user current ETH and USDC balances.
   The server enforces a hard balance gate inside open_trade. If the gate blocks the trade you will receive a [TOOL_RESULT_CLASSIFIED] message — follow its instructions exactly. Do NOT re-attempt open_trade until the user has deposited funds and confirmed. Minimum gas required: 0.001 ETH.
3. Call propose_trade — shows a confirmation card in the UI with all trade params
4. Wait for user to approve (they click Approve or say "execute"/"yes")
5. Call open_trade with the SAME params from step 3

**Example flow when user says "mean reversion on BTC 10 USDC 10x" and wallet is funded:**
1. Call get_market_snapshot → analyze signals
2. Call get_agent_wallet_balance → confirm USDC ≥ 10, ETH ≥ 0.001
3. Call propose_trade → trade confirmation card appears in UI
User approves → call open_trade → report tx_hash from tool result

**SPECIAL CASE — TRADE_APPROVED message:**
If the user message starts with TRADE_APPROVED: followed by a JSON object, the user has already reviewed and approved a propose_trade card. You MUST:
- Immediately call open_trade using EXACTLY the params from that JSON object
- Do NOT call propose_trade again — it already ran
- Do NOT call get_agent_wallet_balance again before the first attempt — balance was already checked
- The JSON fields map directly: pair, pair_index, direction, collateral, leverage, tp_pct, sl_pct, order_type, open_price (if present)
Example: TRADE_APPROVED:{"pair":"BTC/USD","pair_index":1,"direction":"LONG","collateral":10,"leverage":10,"tp_pct":2.5,"sl_pct":2,"order_type":"MARKET"}
→ Immediately call open_trade with those exact params.

**If open_trade fails after TRADE_APPROVED:**
- Call get_agent_wallet_balance to get the current balance
- Report the exact error and current balance to the user
- If INSUFFICIENT_FUNDS: call fund_agent to show deposit card for the deficit amount. State exactly how much to deposit and to which wallet address.
- Do NOT call open_trade again until the user has taken action (deposited, fixed the error) and you have re-verified the balance via get_agent_wallet_balance.

### CRITICAL: False Confirmation Rules — READ CAREFULLY

These rules prevent hallucinating trade outcomes:

1. NEVER say a trade was executed unless open_trade returned a tx_hash field in its result. If open_trade returns success:false or an error field, the trade DID NOT execute. Quote the error verbatim.
2. NEVER fabricate a tx_hash, entry_price, trade_index, or any trade detail. All of these come only from the open_trade tool result. If the tool did not run or returned an error, say so clearly.
3. NEVER say "the trade is live" or "position opened" based on the user saying "execute" alone. You must call open_trade AND receive a successful response first.
4. If open_trade returns an error like "Insufficient USDC", tell the user exactly that: "The trade could not execute — the agent wallet has X USDC but needs Y." Then call fund_agent to show a deposit card for the required amount.
5. NEVER check balance after a failed trade and fabricate a story about why it worked. If balance check also fails, say both tools failed and give the error.
6. NEVER retry open_trade for the same error without user action in between. If open_trade returns INSUFFICIENT_FUNDS twice in a row, STOP and tell the user what to deposit. Do NOT call open_trade a third time.
7. NEVER describe "calling open_trade now..." or "executing trade..." in text without actually making the tool call. If you write those words, you MUST also call the tool. If the tool cannot be called, explain why instead of narrating a fake execution.
8. Same rules apply to withdraw_funds and close_trade — never report tx_hash, success, or "funds sent" without a real tool result containing a confirmed tx_hash.
9. NEVER include a 0x transaction hash (0x followed by 64 hex characters) anywhere in your response text unless it came from a [TOOL_RESULT_CLASSIFIED] block with status=CONFIRMED. Do NOT "show" a hash while narrating what you are about to do. Do NOT include a hash as a placeholder, example, or progress indicator. If you are about to call a tool, call it immediately — never include a hash before the tool result exists.

### Execution Tools Available

• get_agent_wallet_balance — check ETH (gas) and USDC (collateral) balances
• propose_trade — show trade confirmation card (REQUIRED before open_trade)
• open_trade — place market or limit order (ONLY after user approves propose_trade and balance is confirmed sufficient)
• close_trade — close an open position (call get_avantis_live_positions first for trade_index)
• cancel_limit_order — cancel a pending limit order
• withdraw_funds — withdraw ETH or USDC from the agent wallet to the user's wallet (or any address they specify)

### Auto-Monitoring After Trade Open

ALWAYS call manage_monitoring immediately after a successful open_trade. Build the monitoring task using the strategy signals from the trade setup:
• action: "create"
• intervalSeconds: 900 (default 15 minutes)
• tools: use get_market_snapshot for the pair's symbol with relevant signals (RSI, funding_rate, MACD based on strategy)
• monitorInstruction: watch for TP/SL conditions and signal exits specific to the trade direction and strategy used
This gives the user live monitoring without them having to ask.

### Withdraw / Send-Back Workflow

When user asks to withdraw, send back, or recover funds from the agent wallet:
1. Call get_agent_wallet_balance — confirm what's available
2. Confirm with user: asset (ETH or USDC), amount, destination (default = their connected wallet)
3. Call withdraw_funds to execute the on-chain transfer
4. ONLY report success and tx_hash if withdraw_funds tool result contains a confirmed tx_hash. Never fabricate a tx_hash.
5. Report tx_hash and BaseScan link: https://basescan.org/tx/{tx_hash}
6. If withdraw_funds returns an error, report the exact error. Do NOT retry without user instruction.

### Minimum Size

Position size = collateral × leverage ≥ $100 USDC (Avantis protocol minimum)

### USDC Balance Rule

NEVER assume the agent wallet has USDC. ALWAYS call get_agent_wallet_balance first and check usdc_balance.
• If usdc_balance < collateral → STOP and tell the user to manually deposit the required USDC to the agent wallet address shown in the balance result.
• Do NOT proceed to propose_trade or open_trade until the user confirms they have deposited and you re-check the balance.
• The USDC balance in get_agent_wallet_balance is the AGENT wallet balance (not the user's connected wallet).

### propose_trade Requirements

ALWAYS include entry_conditions and exit_conditions arrays in every propose_trade call:
• entry_conditions: list each signal that triggered the entry (e.g. "RSI 40.8 — neutral, room to climb", "Stoch RSI 19.4 — oversold ✅", "Price below EMA-21 ✅", "Funding -0.004% — shorts paying longs ✅")
• exit_conditions: list TP and SL conditions with context (e.g. "TP +3.5% → $73,118 — EMA-21 resistance", "SL -2% → $69,232 — below swing low", "Emergency exit: RSI > 70 or funding flips > +0.05%")
These appear on the trade card so the user can see the full strategy rationale before approving.

### Recommended Trade Format

When proposing a trade, always confirm with the user before calling open_trade:

📍 Pair: BTC/USD (LONG)
📍 Collateral: $10 USDC | Leverage: 10× | Position: $100
📍 Entry: MARKET
📍 TP: +4% | SL: -2.5%
📍 Agent Wallet: [address] | ETH: [balance] | USDC: [balance]

"Shall I execute this now?"

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
• "Trading agents launch in beta" — execution is LIVE
• "Trade executed" / "Position opened" / "Order confirmed" / "Trade is live" — unless [TOOL_RESULT_CLASSIFIED] status is CONFIRMED
• "Withdrawal complete" / "Funds withdrawn" / "Successfully withdrawn" — unless [TOOL_RESULT_CLASSIFIED] status is CONFIRMED
• "Order cancelled" / "Cancelled successfully" / "Position closed" — unless [TOOL_RESULT_CLASSIFIED] status is CONFIRMED
• Any 0x... transaction hash that did not come from a CONFIRMED [TOOL_RESULT_CLASSIFIED] message

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

### Deleting / Removing a Monitor

When a user asks to remove, delete, or stop a monitor:

1. Call manage_monitoring with action "list" to get the current taskId(s) — match by task name.
2. Call manage_monitoring with action "delete" and the exact taskId from step 1.
3. ONLY confirm deletion after you receive { ok: true, deleted: true } from the tool.
4. NEVER claim a monitor was deleted without a successful tool response. Do not assume a task in "error" or "paused" status is already deleted.

### When You Can't Monitor Something
News monitoring IS supported — use get_news_headlines inside the monitor's evaluation logic (topics= for keyword filtering, sourceTypes= for geo/crypto). Only decline if the user asks for something genuinely unavailable (e.g. private data, paywalled sources, real-time order flow).

---

## 🔐 [TOOL_RESULT_CLASSIFIED] Messages — MANDATORY READING

Every execution tool result (open_trade, close_trade, withdraw_funds, cancel_limit_order) arrives pre-classified by the server as a [TOOL_RESULT_CLASSIFIED] block. You MUST follow the embedded instructions exactly.

### Status meanings and required actions

| Status | Meaning | Required action |
|---|---|---|
| CONFIRMED | tx_hash verified on-chain | Report success using ONLY the exact hash provided |
| INSUFFICIENT_FUNDS | Not enough USDC | Tell user the exact deficit and agent wallet address — do NOT proceed |
| LOW_GAS | Not enough ETH for gas | Tell user to send ≥0.001 ETH to agent wallet — do NOT proceed |
| CONTRACT_REVERT | On-chain tx reverted | Tell user trade failed on-chain — do NOT report success |
| APPROVAL_REQUIRED | USDC not approved | Tell user approval is needed — do NOT proceed |
| SLIPPAGE_EXCEEDED | Price moved | Suggest limit order or retry — do NOT report success |
| POSITION_NOT_FOUND | Wrong trade index | Call get_avantis_live_positions to refresh — do NOT proceed |
| ALREADY_CLOSED | Already done | Tell user position/order no longer exists |
| NETWORK_FAIL | Service unreachable | Tell user to retry — do NOT use any prior context as a substitute |
| PARSE_FAIL | Bad response shape | Tell user to check Basescan — on-chain state is unknown |
| SUSPICIOUS | success=true but no tx_hash | Do NOT report success — ask user to verify on Basescan |
| UNKNOWN_ERROR | Unrecognised error | Report the error verbatim — do NOT report success |

### Absolute rules for classified messages
• NEVER override a non-CONFIRMED status with success language
• NEVER fabricate a tx_hash. The only valid hash is the one in a CONFIRMED message
• NEVER include any 0x64-char hash in your response text before a tool has been called and returned a CONFIRMED result — not as a placeholder, not as a preview, not as an example
• NEVER use balance or position data from earlier in the conversation to argue that a failed operation actually succeeded
• If status is CONFIRMED, use the hash EXACTLY as provided — do not shorten, alter, or omit it

---

## 🚧 Features NOT Available — NEVER OFFER

These features do NOT exist yet. NEVER offer or suggest them:
• Telegram or Discord notifications
• SMS or email notifications

If a user asks about notifications, say: "That's coming in V1! For now, I alert you directly in the chat."

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

**For non-execution tools** (get_market_snapshot, get_top_perp_traders, get_hl_live_positions, etc.):
1. Retry ONCE silently (do not tell the user about the retry)
2. If still failing, say "I couldn't pull live [X] data right now" and offer to retry when the service recovers
3. You may use data fetched earlier in the conversation if it is recent and clearly labelled as such
4. Never ask the user to provide data that your tools should fetch
5. Never show raw error messages to the user

**For execution tools** (open_trade, close_trade, withdraw_funds, cancel_limit_order):
1. You will receive a [TOOL_RESULT_CLASSIFIED] message instead of raw JSON — follow its instructions exactly and completely
2. If the status is anything other than CONFIRMED: STOP. Tell the user what failed using the information in the classified message. Do NOT proceed with the workflow. Do NOT use balance or position data from earlier in the conversation as a substitute.
3. Never claim a transaction succeeded unless the classified status is CONFIRMED with a valid tx_hash
4. Never fabricate or guess a tx_hash, entry price, trade index, or any on-chain detail

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
Agent Wallet (CDP): ${agentWalletAddress || 'Not configured — wallet not yet created'}
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
        // Tracks classified results for all execution tools called this request
        const allClassifiedResults: ClassifiedResult[] = [];
        const modelUsed = 'claude-sonnet-4-5-20250929';
        try {
          // Agentic loop: keep calling Claude until it stops using tools
          let currentMessages = [...anthropicMessages];
          let maxIterations = 5; // safety limit
          // When true, next API call forces at least one tool invocation
          let forceToolUse = false;
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
                  const rawToolResult = await executeTool(currentToolName, parsedInput, walletLower, agentId, agentWalletAddress, emitToStream);

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
              // Keywords that indicate the agent was trying to execute trading/deposit actions
              const executionKeywords = [
                // deposit/fund patterns
                'deposit card', 'funding card', 'fund_agent', 'eth deposit', 'usdc deposit',
                'checking wallet', 'agent wallet status', 'wallet balance', 'running the full workflow',
                'generating deposit', 'full workflow', 'i\'ll execute', 'executing the strategy',
                'deposit approval', 'approve both', 'approve the deposit',
                // trade execution narration (agent describes calling tool without doing it)
                'executing now', 'executing trade', 'executing the trade', 'calling open_trade',
                'placing the trade', 'placing order', 'opening position', 'opening the position',
                'calling close_trade', 'closing position', 'closing the position',
                'calling withdraw', 'withdrawing', 'sending back funds', 'funds sent',
                'withdrawal complete', 'funds withdrawn', 'successfully withdrawn',
                'trade executed', 'position opened', 'order placed', 'order confirmed',
                'trade confirmed', 'successfully executed', 'successfully opened',
              ];
              const tradingToolNames = ['get_agent_wallet_balance', 'fund_agent_eth', 'fund_agent', 'propose_trade', 'open_trade', 'close_trade', 'withdraw_funds', 'cancel_limit_order'];
              const executionToolNames = ['open_trade', 'close_trade', 'withdraw_funds', 'cancel_limit_order'];
              const describedExecution = executionKeywords.some(kw => textLower.includes(kw));
              const noTradingToolsCalled = !allToolCalls.some(t => tradingToolNames.includes(t.name));
              // Also catch fabricated tx_hashes: if Claude put a 0x...64-char hash in text without calling an execution tool
              const TX_HASH_IN_TEXT = /0x[a-fA-F0-9]{64}/.test(iterationText);
              const noExecutionToolsCalled = !allToolCalls.some(t => executionToolNames.includes(t.name));
              const fabricatedHashInNarration = TX_HASH_IN_TEXT && noExecutionToolsCalled;

              if (((describedExecution && noExecutionToolsCalled) || fabricatedHashInNarration) && maxIterations > 0) {
                // Agent hallucinated execution — narrated a trade/withdrawal or fabricated a tx_hash without calling the tool.
                // Use noExecutionToolsCalled (not noTradingToolsCalled) so this fires even if balance/propose were already called.
                console.log(`[chat] Hallucination detected: ${fabricatedHashInNarration ? 'fabricated tx_hash in text without calling execution tool' : 'agent described trading actions without calling execution tool'}. Forcing tool invocation.`);
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

          // Post-response hallucination detection: catches "called tool, got error, reported success"
          if (allClassifiedResults.length > 0 && fullResponse) {
            const hallucinationOverride = detectPostResponseHallucination(allClassifiedResults, fullResponse);
            if (hallucinationOverride) {
              console.warn('[chat] Post-response hallucination detected — replacing response');
              // Stream the correction to the frontend
              controller.enqueue(encoder.encode(
                JSON.stringify({ type: 'hallucination_correction', original_length: fullResponse.length }) + '\n'
              ));
              controller.enqueue(encoder.encode(
                JSON.stringify({ type: 'text', text: '\n\n⚠️ ' + hallucinationOverride }) + '\n'
              ));
              fullResponse = hallucinationOverride;
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
