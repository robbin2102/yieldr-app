# Yieldr Data Services API

FastAPI service for token scanning, trader indexing, PnL computation, and market data on Base blockchain.

## Part 1: Core Setup + Spot Scan ✅

Part 1 implementation is complete with the following features:

### Features Implemented
- ✅ FastAPI application with lifespan management
- ✅ MongoDB connection with Motor (async driver)
- ✅ QuickNode client (Token API v2)
- ✅ GeckoTerminal client (token prices)
- ✅ Moralis client (wallet profitability)
- ✅ API key authentication
- ✅ `/health` endpoint
- ✅ `/api/v1/spot/scan/{wallet}` endpoint

### Endpoints

#### `GET /health`
Health check endpoint (no authentication required).

**Response:**
```json
{
  "status": "healthy",
  "service": "Yieldr Data Services",
  "version": "1.0.0"
}
```

#### `GET /api/v1/spot/scan/{wallet}`
Scan a wallet's ERC-20 token holdings on Base with profitability metrics.

**Headers:**
- `X-API-Key`: Your API key (required)

**Path Parameters:**
- `wallet`: Ethereum wallet address

**Response:**
```json
{
  "wallet": "0x...",
  "totalTokens": 5,
  "totalValueUSD": 1234.56,
  "tokens": [
    {
      "address": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      "symbol": "USDC",
      "balance": "1000000000",
      "decimals": 6,
      "balanceFormatted": 1000.0,
      "priceUSD": 1.0,
      "valueUSD": 1000.0,
      "profitability": {
        "avg_buy_price_usd": 0.98,
        "avg_sell_price_usd": 1.02,
        "realized_profit_usd": 40.0,
        "realized_profit_percentage": 4.08,
        "total_usd_invested": 980.0,
        "count_of_trades": 5
      }
    }
  ]
}
```

## Setup Instructions

### 1. Install Dependencies

```bash
cd yieldr-data-api
pip install -r requirements.txt
```

### 2. Configure Environment Variables

The API uses the **shared `.env.local` file in the project root** (not in yieldr-data-api/).

Add these variables to your existing `yieldr-app/.env.local` file:

```bash
# === SHARED (Frontend + Backend) ===
MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/yieldr
QUICKNODE_BASE_RPC_URL=https://your-quicknode-endpoint.quiknode.pro/xxx/

# === BACKEND (Yieldr Data Services API) ===
MORALIS_API_KEY=your-moralis-api-key
API_KEY=your-api-key-for-auth

# === OPTIONAL (Part 4 & 6) ===
# TAAPI_API_KEY=your-taapi-key
# QUICKNODE_STREAM_SECRET=your-webhook-secret
```

You can also copy from `.env.example` in the project root.

**Where to get these:**
- **MongoDB**: Create a free cluster at [MongoDB Atlas](https://www.mongodb.com/cloud/atlas)
- **QuickNode**: Sign up at [QuickNode](https://www.quicknode.com/) and create a Base endpoint with Token API v2 addon
- **Moralis**: Get API key at [Moralis](https://moralis.io/)
- **API_KEY**: Create your own secure string (e.g., `openssl rand -hex 32`)

### 3. Run the Server

```bash
cd yieldr-data-api
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

**Test wallet scan (replace with your API key and wallet):**
```bash
curl -H "X-API-Key: your-api-key-here" \
  http://localhost:8000/api/v1/spot/scan/0x742d35Cc6634C0532925a3b844Bc454e4438f44e
```

**View interactive docs:**
Open `http://localhost:8000/docs` in your browser for Swagger UI documentation.

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
│   ├── quicknode.py           # QuickNode API client
│   ├── geckoterminal.py       # GeckoTerminal API client
│   └── moralis.py             # Moralis API client
├── config.py                  # Configuration management
├── main.py                    # FastAPI application
├── requirements.txt           # Python dependencies
└── .env.example               # Environment variables template
```

## What's Next?

Part 2 will implement:
- Indexing script for trending tokens (GeckoTerminal)
- Top profitable traders discovery (Moralis)
- `/api/v1/trader/top` endpoint
- MongoDB storage for indexed data

## Notes

- All token addresses are normalized to lowercase for consistency
- Profitability data is fetched from Moralis for each token (may be null if unavailable)
- Tokens are sorted by USD value (highest first)
- The API uses async/await throughout for optimal performance
