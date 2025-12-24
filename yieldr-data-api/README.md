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
│   └── spot/
│       ├── router.py          # Spot endpoints router
│       └── scan.py            # Wallet scanning endpoint
├── core/
│   └── utils.py               # Utility functions
├── db/
│   └── mongodb.py             # MongoDB connection management
├── services/
│   ├── alchemy.py             # Alchemy API client (token balances)
│   ├── defillama.py           # DeFiLlama API client (token prices)
│   ├── geckoterminal.py       # GeckoTerminal (Part 2: trending pools)
│   ├── quicknode.py           # QuickNode (Part 2: eth_getLogs)
│   └── moralis.py             # Moralis (Part 2: top traders)
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

## What's Next?

**Part 2** will implement:
- Indexing script for trending tokens (GeckoTerminal)
- Top profitable traders discovery (Moralis)
- Token transfer event indexing (QuickNode `eth_getLogs`)
- `/api/v1/trader/top` endpoint
- MongoDB storage for indexed data

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
