# Yieldr Data Services API

FastAPI service for token scanning, trader indexing, PnL computation, and market data on Base blockchain.

## Part 1: Core Setup + Spot Scan ✅

Part 1 implementation uses **Alchemy (free tier)** for token balances and **DeFiLlama (free)** for prices with automatic spam filtering.

### Features Implemented
- ✅ FastAPI application with lifespan management
- ✅ MongoDB connection with Motor (async driver)
- ✅ **Alchemy client** - Token balances (300M CUs/month free)
- ✅ **DeFiLlama client** - Token prices (500 req/min, no API key)
- ✅ **Auto spam filtering** - DeFiLlama only prices real tokens
- ✅ API key authentication
- ✅ `/health` endpoint
- ✅ `/api/v1/spot/scan/{wallet}` endpoint with query params

### Why Alchemy + DeFiLlama?

| Service | Purpose | Cost | Spam Filtering |
|---------|---------|------|----------------|
| **Alchemy** | Token balances | Free (300M CUs/month) | Manual (balance > 1) |
| **DeFiLlama** | Token prices | Free (500/min) | ✅ Automatic (no price = spam) |
| QuickNode | ❌ Removed (paid) | Paid | Manual |
| GeckoTerminal | Kept for Part 2 trending | Free (30/min) | N/A |

**Result:** Zero API costs for Part 1, automatic spam filtering!

---

## Endpoints

### `GET /health`
Health check endpoint (no authentication required).

**Response:**
```json
{
  "status": "healthy",
  "service": "Yieldr Data Services",
  "version": "1.0.0"
}
```

### `GET /api/v1/spot/scan/{wallet}`
Scan a wallet's ERC-20 token holdings on Base with automatic spam filtering.

**Headers:**
- `X-API-Key`: Your API key (required)

**Path Parameters:**
- `wallet`: Ethereum wallet address

**Query Parameters:**
- `min_value` (optional): Minimum USD value to include (default: $10)
- `limit` (optional): Max tokens to return (default: 50, max: 100)

**Example Request:**
```bash
curl -H "X-API-Key: your-key" \
  "http://localhost:8000/api/v1/spot/scan/0x742d35Cc6634C0532925a3b844Bc454e4438f44e?min_value=5&limit=20"
```

**Response:**
```json
{
  "wallet": "0x742d35cc6634c0532925a3b844bc454e4438f44e",
  "totalTokens": 3,
  "totalValueUSD": 1234.56,
  "tokens": [
    {
      "tokenAddress": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      "symbol": "USDC",
      "decimals": 6,
      "balance": 1000.0,
      "price_usd": 1.0,
      "value_usd": 1000.0
    }
  ]
}
```

**Spam Filtering (Automatic):**
- ✅ Filters dust balances (balance <= 1, often NFT spam)
- ✅ Only includes tokens with DeFiLlama prices (real liquidity)
- ✅ Filters low confidence prices (< 0.5)
- ✅ Applies minimum USD value filter
- ✅ Sorted by value (highest first)

---

## Setup Instructions

### 1. Install Dependencies

```bash
cd yieldr-data-api

# Create virtual environment (recommended)
python3.11 -m venv venv
source venv/bin/activate  # On Mac/Linux

# Install packages
pip install -r requirements.txt
```

### 2. Configure Environment Variables

The API uses the **shared `.env.local` file in the project root** (not in yieldr-data-api/).

Add these variables to your existing `yieldr-app/.env.local` file:

```bash
# === REQUIRED (Part 1) ===
MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/yieldr
ALCHEMY_BASE_URL=https://base-mainnet.g.alchemy.com/v2/YOUR-API-KEY
MORALIS_API_KEY=your-moralis-api-key
API_KEY=your-secure-api-key

# === OPTIONAL (Server Port) ===
API_PORT=8000

# === OPTIONAL (Part 2+) ===
# QUICKNODE_BASE_RPC_URL=https://xxx.base-mainnet.quiknode.pro/xxx/
# TAAPI_API_KEY=your-taapi-key
# QUICKNODE_STREAM_SECRET=your-webhook-secret
```

**Where to get these:**

#### MongoDB (Required)
- Sign up at [MongoDB Atlas](https://www.mongodb.com/cloud/atlas)
- Create a free cluster (M0 tier)
- Get connection string from "Connect" → "Connect your application"

#### Alchemy (Required - FREE)
- Sign up at [Alchemy](https://www.alchemy.com/)
- Create a new app → Select "Base" chain
- Copy the HTTPS endpoint URL
- Free tier: **300M compute units/month** (plenty for Part 1)

#### Moralis (Required for Part 2)
- Sign up at [Moralis](https://moralis.io/)
- Get API key from dashboard
- Not used in Part 1 scan, but needed for Part 2

#### API_KEY (Required)
- Generate a secure random string:
```bash
openssl rand -hex 32
```

### 3. Run the Server

```bash
cd yieldr-data-api
source venv/bin/activate  # If using venv
python main.py
```

Or use uvicorn directly:

```bash
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

The API will be available at `http://localhost:8000`

### 4. Test the Endpoints

**Test health endpoint:**
```bash
curl http://localhost:8000/health
```

**Test wallet scan (replace with your API key):**
```bash
curl -H "X-API-Key: your-api-key-here" \
  "http://localhost:8000/api/v1/spot/scan/0x742d35Cc6634C0532925a3b844Bc454e4438f44e"
```

**With query parameters:**
```bash
curl -H "X-API-Key: your-api-key-here" \
  "http://localhost:8000/api/v1/spot/scan/0x742d35Cc6634C0532925a3b844Bc454e4438f44e?min_value=5&limit=20"
```

**View interactive docs:**
Open `http://localhost:8000/docs` in your browser for Swagger UI documentation.

---

## Project Structure

```
yieldr-data-api/
├── api/
│   ├── dependencies.py       # API key authentication
│   ├── spot/
│   │   ├── router.py          # Spot endpoints router
│   │   └── scan.py            # Wallet scanning endpoint
│   ├── trending/
│   │   └── tokens.py          # Trending tokens endpoints
│   └── trader/
│       └── top.py             # Top traders endpoints
├── db/
│   └── mongodb.py             # MongoDB connection management
├── jobs/                      # Background jobs (cron scripts)
│   ├── index_trending_traders.py  # 12h: Index trending tokens + traders
│   ├── monitor_swaps.py           # 15min: Monitor trader swaps
│   └── compute_performance.py     # 1h: Compute trader metrics
├── models/
│   └── schemas.py             # MongoDB collection schemas
├── services/
│   ├── alchemy.py             # Alchemy API client (token balances)
│   ├── defillama.py           # DeFiLlama API client (token prices)
│   ├── geckoterminal.py       # GeckoTerminal (trending pools)
│   ├── quicknode.py           # QuickNode (eth_getLogs for swaps)
│   └── moralis.py             # Moralis (top traders discovery)
├── utils/
│   └── performance.py         # Performance metrics computation
├── config.py                  # Configuration management
├── main.py                    # FastAPI application
├── requirements.txt           # Python dependencies
└── README.md                  # This file
```

---

## API Costs (Part 1)

| Service | Endpoint | Cost per Call | Monthly Free Tier | Part 1 Usage |
|---------|----------|---------------|-------------------|--------------|
| **Alchemy** | `alchemy_getTokenBalances` | 20 CUs | 300M CUs | ✅ ~15k scans/month |
| **DeFiLlama** | `/prices/current` | Free | 500/min | ✅ Unlimited |
| **MongoDB** | Database | Free | 512MB | ✅ Plenty |

**Total monthly cost for Part 1: $0** 🎉

---

## Part 2: Trader Discovery & Indexing ✅

Part 2 implements automated trader discovery, swap monitoring, and performance computation using **GeckoTerminal** (trending tokens), **Moralis** (top traders), and **QuickNode** (swap events).

### Features Implemented
- ✅ **12h cron job** - Index top 100 trending tokens + discover top traders
- ✅ **15min cron job** - Monitor swaps for ~2K tracked traders (query by TOKEN strategy)
- ✅ **Performance computation** - PnL, ROI, win rate, risk metrics from swap history
- ✅ **API endpoints** - Trending tokens, top traders, trader profiles, swap history
- ✅ **MongoDB collections** - `trending_tokens`, `top_traders`, `trader_swaps`

### Trader Discovery Strategy

**Every 12 hours:**
1. Fetch top 100 trending tokens from GeckoTerminal (Base only)
2. For each trending token:
   - Fetch top 10 profitable traders (30-day PnL from Moralis)
   - Fetch top 10 whale holders (from Moralis)
   - Merge and deduplicate → ~20 unique traders per token
3. Total tracked traders: **~2,000 unique wallets**

### Swap Monitoring Strategy

**Every 15 minutes** (optimized for API efficiency):
- ✅ **Query by TOKEN** (100 calls), not by wallet (2K calls)
- Fetch Transfer events for each trending token via `eth_getLogs`
- Filter transfers by tracked wallets **in-memory** (free!)
- Store buy/sell swaps in MongoDB

**Cost efficiency:**
- 100 tokens × 96 polls/day × 50 credits = **480K credits/day**
- **14.4M credits/month** (18% of 80M QuickNode free tier) ✅

---

## New Endpoints (Part 2)

### `GET /api/v1/trending/tokens`
Get current trending tokens on Base.

**Headers:** `X-API-Key`

**Query Parameters:**
- `limit` (optional): Max tokens (default: 100, max: 100)
- `min_volume` (optional): Min 24h volume in USD (default: 0)

**Example:**
```bash
curl -H "X-API-Key: your-key" \
  "http://localhost:8000/api/v1/trending/tokens?limit=50"
```

**Response:**
```json
{
  "chain": "base",
  "totalTokens": 50,
  "tokens": [
    {
      "tokenAddress": "0x...",
      "symbol": "TOKEN",
      "name": "Token Name",
      "priceUSD": 1.23,
      "volume24hUSD": 1000000,
      "priceChange24hPct": 15.5,
      "poolAddress": "0x...",
      "dex": "aerodrome",
      "rank": 1,
      "traderCount": 18,
      "indexedAt": "2025-12-24T10:00:00Z"
    }
  ]
}
```

---

### `GET /api/v1/trending/tokens/{token_address}`
Get details for a specific trending token.

**Headers:** `X-API-Key`

**Example:**
```bash
curl -H "X-API-Key: your-key" \
  "http://localhost:8000/api/v1/trending/tokens/0x..."
```

---

### `GET /api/v1/trader/top`
Get top traders leaderboard.

**Headers:** `X-API-Key`

**Query Parameters:**
- `token_address` (optional): Filter by specific token
- `limit` (optional): Max traders (default: 20, max: 100)
- `min_pnl` (optional): Min 30d PnL in USD (default: 0)

**Example:**
```bash
curl -H "X-API-Key: your-key" \
  "http://localhost:8000/api/v1/trader/top?limit=10"
```

**Response:**
```json
{
  "totalTraders": 10,
  "token": null,
  "traders": [
    {
      "walletAddress": "0x...",
      "chain": "base",
      "tokens": [
        {
          "tokenAddress": "0x...",
          "symbol": "TOKEN",
          "isProfitable": true,
          "isWhale": true,
          "pnlUSD": 50000,
          "avgBuyPriceUSD": 0.50,
          "avgSellPriceUSD": 0.75
        }
      ],
      "performance": {
        "totalAUMUSD": 2400000,
        "totalPositions": 47,
        "roi30dPct": 5.92,
        "pnl30dUSD": 142190,
        "winRatePct": 68,
        "totalTrades": 247,
        "avgWinUSD": 2800,
        "avgLossUSD": 1100,
        "sharpeRatio": 1.85,
        "maxDrawdownPct": 8.5
      }
    }
  ]
}
```

---

### `GET /api/v1/trader/{wallet}/profile`
Get detailed profile for a specific trader.

**Headers:** `X-API-Key`

**Example:**
```bash
curl -H "X-API-Key: your-key" \
  "http://localhost:8000/api/v1/trader/0x.../profile"
```

---

### `GET /api/v1/trader/{wallet}/swaps`
Get recent swap history for a trader.

**Headers:** `X-API-Key`

**Query Parameters:**
- `days` (optional): Days to look back (default: 7, max: 30)
- `limit` (optional): Max swaps (default: 50, max: 100)

**Example:**
```bash
curl -H "X-API-Key: your-key" \
  "http://localhost:8000/api/v1/trader/0x.../swaps?days=30"
```

**Response:**
```json
{
  "wallet": "0x...",
  "totalSwaps": 50,
  "days": 30,
  "swaps": [
    {
      "tokenAddress": "0x...",
      "tokenSymbol": "TOKEN",
      "type": "buy",
      "amount": 1000.0,
      "valueUSD": 5000.0,
      "dex": "uniswap_v3",
      "txHash": "0x...",
      "blockNumber": 12345,
      "timestamp": "2025-12-24T10:30:00Z"
    }
  ]
}
```

---

## Background Jobs (Part 2)

### 1. Trending Tokens + Traders Discovery (12h interval)
```bash
python jobs/index_trending_traders.py
```

**What it does:**
- Fetches top 100 trending tokens from GeckoTerminal
- For each token, finds top 10 profitable + top 10 whale traders
- Stores in MongoDB (`trending_tokens`, `top_traders`)

**Cron schedule:**
```cron
0 */12 * * * cd /path/to/yieldr-data-api && python jobs/index_trending_traders.py >> logs/trending.log 2>&1
```

---

### 2. Swap Monitoring (15min interval)
```bash
python jobs/monitor_swaps.py
```

**What it does:**
- Loads ~2K tracked trader wallets from MongoDB
- Queries Transfer events for each trending token (last 15 min)
- Filters by tracked wallets in-memory
- Stores buy/sell swaps in MongoDB (`trader_swaps`)
- Cleans up swaps older than 30 days

**Cron schedule:**
```cron
*/15 * * * * cd /path/to/yieldr-data-api && python jobs/monitor_swaps.py >> logs/swaps.log 2>&1
```

---

### 3. Performance Computation (1h interval)
```bash
python jobs/compute_performance.py
```

**What it does:**
- Loads all active traders from MongoDB
- Fetches swap history (last 30 days) for each trader
- Computes performance metrics (PnL, ROI, win rate, risk metrics)
- Updates `top_traders` collection with computed metrics

**Cron schedule:**
```cron
0 * * * * cd /path/to/yieldr-data-api && python jobs/compute_performance.py >> logs/performance.log 2>&1
```

---

## MongoDB Collections (Part 2)

### `trending_tokens`
Stores top 100 trending tokens from GeckoTerminal.

**Fields:**
- `token_address`, `chain`, `symbol`, `name`
- `price_usd`, `volume_24h_usd`, `price_change_24h_pct`
- `pool_address`, `dex`, `rank`
- `trader_count` (number of tracked traders for this token)
- `indexed_at`

---

### `top_traders`
Stores tracked traders with their tokens and performance metrics.

**Fields:**
- `wallet_address`, `chain`, `status`
- `tokens[]` - Array of token metadata (address, symbol, pnl, holdings, etc.)
- `performance{}` - Computed metrics (PnL, ROI, win rate, Sharpe ratio, etc.)
- `asset_performance[]` - Performance breakdown by asset
- `indexed_at`, `last_swap_indexed`, `backfill_status`

---

### `trader_swaps`
Stores swap transactions for tracked traders (30-day rolling window).

**Fields:**
- `wallet_address`, `chain`
- `token_address`, `token_symbol`, `type` (buy/sell)
- `amount`, `value_usd`
- `from_address`, `to_address`, `dex`
- `tx_hash`, `block_number`, `log_index`
- `timestamp`, `indexed_at`, `processed`

---

## Performance Metrics Explained

The system computes the following metrics for each trader:

### Total AUM & Positions
- `totalAUMUSD`: Total value of all current holdings
- `totalPositions`: Number of unique token positions

### ROI & PnL
- `roi1dPct`, `roi7dPct`, `roi30dPct`: Return on investment percentages
- `pnl1dUSD`, `pnl7dUSD`, `pnl30dUSD`: Profit/loss in USD

### Win Rate
- `winRatePct`: Percentage of profitable trades
- `totalTrades`: Total completed trades
- `totalWins`, `totalLosses`: Win/loss counts

### Average Performance
- `avgWinUSD`, `avgLossUSD`: Average profit/loss per trade
- `bestTradeUSD`, `worstTradeUSD`: Best and worst trades

### Risk Metrics
- `sharpeRatio`: Risk-adjusted returns (higher is better)
- `maxDrawdownPct`: Maximum peak-to-trough decline

---

## API Costs (Part 2)

| Service | Purpose | Cost per Call | Monthly Free Tier | Part 2 Usage |
|---------|---------|---------------|-------------------|--------------|
| **GeckoTerminal** | Trending tokens | Free | 30/min | ✅ ~60 calls/month |
| **Moralis** | Top traders | 2 CU | 40M CU/month | ✅ ~12K CU/month |
| **QuickNode** | Swap events | ~50 credits | 80M credits/month | ✅ ~14.4M credits/month |
| **DeFiLlama** | Token prices | Free | 500/min | ✅ Unlimited |

**Total monthly cost for Part 2: $0** (within free tiers) 🎉

---

## Troubleshooting

### "ALCHEMY_BASE_URL field required"
Make sure you've added `ALCHEMY_BASE_URL` to your `.env.local` file in the project root.

### "Failed to scan wallet"
- Check your Alchemy API key is correct
- Verify the wallet address is valid
- Check server logs for detailed error

### "Invalid API key"
Make sure you're passing the correct `X-API-Key` header that matches `API_KEY` in `.env.local`.

### Port already in use
If port 8000 is taken, change `API_PORT` in `.env.local` or run:
```bash
uvicorn main:app --reload --port 8001
```
