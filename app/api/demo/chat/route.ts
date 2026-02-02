import { NextRequest } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import connectDB from '@/lib/mongoose';
import mongoose from 'mongoose';
import Agent from '@/models/Agent';
import ChatSession from '@/models/ChatSession';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || '',
});

const HYPERLIQUID_API_URL = 'https://api.hyperliquid.xyz/info';
const POLYMARKET_API_BASE = 'https://data-api.polymarket.com';
const AVANTIS_API_URL = 'https://yieldr-app-production.up.railway.app/fetch-positions';
const BASE_RPC_URL = process.env.BASE_RPC_URL || 'https://mainnet.base.org';

// ─── Tool Definitions (Anthropic format) ───────────────────────────────────

const toolDefinitions: Anthropic.Tool[] = [
  {
    name: 'get_top_perp_traders',
    description: 'Get top perpetual traders from Hyperliquid or Avantis. Returns traders sorted by PnL, win rate, or volume. Use when the user asks about top traders, best performers, or trader discovery for perps/leverage trading.',
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
    description: 'Get real-time open positions from Hyperliquid for any wallet. Returns current positions with PnL, leverage, liquidation prices. Use when user asks what a trader is currently doing, their open positions, or if they are LONG/SHORT.',
    input_schema: {
      type: 'object' as const,
      properties: {
        walletAddress: { type: 'string', description: 'Ethereum wallet address (0x...)' },
      },
      required: ['walletAddress'],
    },
  },
  {
    name: 'get_avantis_live_positions',
    description: 'Get real-time open positions from Avantis (Base chain) for any wallet. Returns positions with PnL, leverage, direction.',
    input_schema: {
      type: 'object' as const,
      properties: {
        walletAddress: { type: 'string', description: 'Ethereum wallet address (0x...)' },
      },
      required: ['walletAddress'],
    },
  },
  {
    name: 'get_pm_live_positions',
    description: 'Get real-time open positions from Polymarket for any wallet. Returns current prediction market positions with market titles, prices, PnL.',
    input_schema: {
      type: 'object' as const,
      properties: {
        walletAddress: { type: 'string', description: 'Ethereum wallet address (0x...)' },
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
    name: 'get_hl_portfolio',
    description: 'Get Hyperliquid portfolio overview with 30-day PnL history curve and account value for a wallet.',
    input_schema: {
      type: 'object' as const,
      properties: {
        walletAddress: { type: 'string', description: 'Ethereum wallet address (0x...)' },
      },
      required: ['walletAddress'],
    },
  },
];

// Claude native web search tool
const webSearchTool = {
  type: 'web_search_20250305' as const,
  name: 'web_search',
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
          // Avantis - query managers collection
          const filter: any = { 'metrics.totalPnL30d': { $exists: true } };
          if (asset) filter['metrics.tradedAssets'] = { $regex: new RegExp(asset, 'i') };
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
        const res = await fetch(HYPERLIQUID_API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'clearinghouseState', user: input.walletAddress }),
        });
        if (!res.ok) throw new Error(`HL API error: ${res.status}`);
        const data = await res.json();
        const positions = (data.assetPositions || []).map((ap: any) => {
          const pos = ap.position;
          const szi = parseFloat(pos.szi);
          return {
            coin: pos.coin, side: szi > 0 ? 'LONG' : 'SHORT',
            size: Math.abs(szi), entryPrice: parseFloat(pos.entryPx),
            leverage: pos.leverage?.value || 1,
            unrealizedPnl: parseFloat(pos.unrealizedPnl),
            marginUsed: parseFloat(pos.marginUsed),
          };
        });
        return JSON.stringify({
          wallet: input.walletAddress, totalPositions: positions.length, positions,
          accountValue: data.marginSummary?.accountValue,
        });
      }
      case 'get_avantis_live_positions': {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);
        try {
          const res = await fetch(AVANTIS_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ walletAddress: input.walletAddress, rpcUrl: BASE_RPC_URL }),
            signal: controller.signal,
          });
          clearTimeout(timeout);
          const data = await res.json();
          return JSON.stringify(data);
        } catch (e: any) {
          clearTimeout(timeout);
          return JSON.stringify({ error: e.message });
        }
      }
      case 'get_pm_live_positions': {
        const allPositions: any[] = [];
        let offset = 0;
        while (true) {
          const res = await fetch(`${POLYMARKET_API_BASE}/positions?user=${input.walletAddress}&limit=500&offset=${offset}`);
          if (!res.ok) throw new Error(`PM API error: ${res.status}`);
          const data = await res.json();
          if (!Array.isArray(data) || data.length === 0) break;
          allPositions.push(...data);
          if (data.length < 500) break;
          offset += 500;
        }
        const active = allPositions.filter(p => {
          const cp = parseFloat(p.curPrice || '0');
          return cp >= 0.001 && cp <= 0.999;
        });
        return JSON.stringify({
          wallet: input.walletAddress, totalPositions: active.length,
          positions: active.map(p => ({
            title: p.title, outcome: p.outcome,
            size: parseFloat(p.size || '0'), avgPrice: parseFloat(p.avgPrice || '0'),
            currentPrice: parseFloat(p.curPrice || '0'), currentValue: parseFloat(p.currentValue || '0'),
            pnl: parseFloat(p.cashPnl || '0'), pnlPercent: parseFloat(p.percentPnl || '0'),
          })),
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

function buildSystemPrompt(context: {
  agentName: string;
  positions: any[];
  followedTraders: any[];
  portfolioSummary: any;
  tokens: any[];
  tokensTotalUsd: number;
}) {
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

  return `You are ${agentName}, an AI trading and investment agent on the Yieldr platform.

You serve two roles:

1. TRADING ADVISOR — Help active traders analyze positions, compare with top performers, understand market context, and optimize entries/exits.

2. PORTFOLIO MANAGER — Help investors discover alpha by finding top traders across platforms, building allocation plans, constructing diversified portfolios, and suggesting execution paths.

---

## 📊 User's Current Portfolio

Total Value: ~$${totalPortfolioValue.toFixed(2)}
Positions: ${portfolioSummary?.positionCount || 0}
Token Holdings: $${tokensTotalUsd.toFixed(2)} across ${tokens.length} tokens

### Open Positions
${positionSummary}

### Token Holdings
${tokenSummary}

### Currently Following
${traderSummary}

---

## 🔧 Your Tools

You have access to powerful data tools. USE THEM proactively:

• get_top_perp_traders — Fetch top perpetual traders from Hyperliquid or Avantis
• get_top_pm_traders — Fetch top Polymarket traders filtered by category
• get_hl_live_positions — Get any trader's current Hyperliquid positions
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

## 📋 Allocation Plan Format

When building allocation plans, use this structure:

💼 PROPOSED ALLOCATION: $[budget]

[Trader Name/Wallet] | [Platform]
Allocation: $X,XXX (XX%)
Est. Monthly ROI: X-X%
Specialty: [category]
Rationale: [1 sentence]

📊 PORTFOLIO SUMMARY
Total Allocated: $X,XXX
Expected Monthly Return: $X,XXX - $X,XXX (X-X%)
Diversification: [High/Medium/Low]

⚡ EXECUTION OPTIONS
For perps → Execute on Avantis (Base) or Coinbase
For prediction markets → Execute on Limitless or Coinbase
Note: I have open positions of top traders and can help you start executing

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
• When data contradicts user's position, state it neutrally with evidence`;
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

      try {
        const tokenApiUrl = `${process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'}/api/demo/tokens?address=${wallet}`;
        const tokenRes = await fetch(tokenApiUrl);
        if (tokenRes.ok) {
          const tokenData = await tokenRes.json();
          if (tokenData.success && tokenData.data) {
            tokens = tokenData.data.tokens || [];
            tokensTotalUsd = tokenData.data.totalUsdValue || 0;
          }
        }
      } catch (e) {
        console.log('[chat] Token fetch failed:', (e as Error).message);
      }
      positions = positionDocs || [];
    }

    const systemPrompt = buildSystemPrompt({
      agentName, positions, followedTraders, portfolioSummary, tokens, tokensTotalUsd,
    });

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
        try {
          // Agentic loop: keep calling Claude until it stops using tools
          let currentMessages = [...anthropicMessages];
          let maxIterations = 5; // safety limit

          while (maxIterations > 0) {
            maxIterations--;

            const response = await anthropic.messages.create({
              model: 'claude-sonnet-4-5-20250929',
              max_tokens: 2048,
              system: systemPrompt,
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

                  // Execute the tool
                  const toolResult = await executeTool(currentToolName, parsedInput);
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
