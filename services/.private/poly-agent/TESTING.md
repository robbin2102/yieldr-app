# Testing Orderbook Data

This guide helps you verify that the orderbook WebSocket feed is working correctly and matches what you see on the Polymarket UI.

## Why Test Orderbook?

If you see discrepancies between:
- **Bot's orderbook data** (e.g., "bid: $0.01")
- **Polymarket UI** (e.g., showing buyers at $0.20)

This means either:
1. Wrong token ID being subscribed to
2. Stale/incorrect orderbook data
3. WebSocket subscription format issue
4. Market is closed/expired

## Step 1: Find Token IDs for a Market

Run this script with a Polymarket market URL:

```bash
npx ts-node get-token-ids.ts "https://polymarket.com/event/btc-updown-15m-1765292400"
```

**Output:**
```
✅ Market found!

═══════════════════════════════════════════════════════════
📊 Bitcoin Up or Down - December 9, 9:30AM-9:45AM ET
═══════════════════════════════════════════════════════════

📈 Markets (1):

1. Will Bitcoin price be Up or Down?
   ─────────────────────────────────────────────────
   Condition ID: 0x123abc...
   Active: YES ✅

   📍 Token IDs (use these for orderbook):
   • Up: 21888242871839275222246405745257275088548364400416034343698204186575808495617
   • Down: 48331043336612883890938759509493159234755048973500640148014422747788308358299
```

## Step 2: Test Orderbook Feed

Copy a token ID from above and run:

```bash
npx ts-node test-orderbook.ts 21888242871839275222246405745257275088548364400416034343698204186575808495617
```

**This will:**
1. Connect to Polymarket WebSocket Market Channel
2. Subscribe to that token's orderbook
3. Show ALL raw WebSocket messages
4. Display orderbook in readable format
5. Compare to Polymarket UI

**Expected Output:**
```
═══════════════════════════════════════════════════════════
MESSAGE #1 (2025-12-09T14:30:15.123Z)
═══════════════════════════════════════════════════════════

📦 RAW MESSAGE:
{
  "event_type": "book",
  "asset_id": "21888242871839275222...",
  "market": "0x123abc...",
  "bids": [
    { "price": "0.2150", "size": "1000.50" },
    { "price": "0.2100", "size": "500.25" },
    ...
  ],
  "asks": [
    { "price": "0.2200", "size": "750.00" },
    { "price": "0.2250", "size": "300.10" },
    ...
  ]
}

📊 ORDERBOOK SNAPSHOT:

🔴 BIDS (Buy Orders - sorted high to low):
Price      | Size       | Total Value
---------------------------------------------
$0.2150    | 1000.50    | $215.11
$0.2100    | 500.25     | $105.05
...

✅ BEST BID (highest buy price): $0.2150

🟢 ASKS (Sell Orders - sorted low to high):
Price      | Size       | Total Value
---------------------------------------------
$0.2200    | 750.00     | $165.00
$0.2250    | 300.10     | $67.52
...

✅ BEST ASK (lowest sell price): $0.2200

📏 SPREAD: $0.0050 (2.33%)

💡 WHAT TO CHECK:
1. Compare BEST BID to "Buy" price on Polymarket UI
2. Compare BEST ASK to "Sell" price on Polymarket UI
3. Check if sizes match liquidity shown on UI
4. Verify asset_id matches the outcome token you're viewing
```

## Step 3: Compare to UI

Open Polymarket market page and compare:

| Data Point | UI Shows | Script Shows | Match? |
|------------|----------|--------------|--------|
| Best Buy Price (Bid) | $0.2150 | $0.2150 | ✅ |
| Best Sell Price (Ask) | $0.2200 | $0.2200 | ✅ |
| Liquidity (Size) | 1000 shares | 1000.50 shares | ✅ |

## Troubleshooting

### Issue: No orderbook data received

**Possible causes:**
1. Token ID is wrong (check with get-token-ids.ts)
2. Market is closed/expired
3. No liquidity in the market
4. WebSocket subscription format incorrect

**Fix:** Verify token ID is correct and market is active

### Issue: Orderbook shows different prices than UI

**Possible causes:**
1. Subscribing to wrong outcome token (Up vs Down, Yes vs No)
2. Stale data (WebSocket disconnected)
3. UI showing different market/event

**Fix:**
- Verify you're comparing the SAME outcome token
- Check asset_id in raw message matches URL
- Refresh UI and check timestamps

### Issue: Bid is very low (e.g., $0.01) when UI shows higher

**Possible causes:**
1. Wrong token ID - subscribed to opposite outcome
   - If UI shows "Up" at $0.20, you might be subscribed to "Down" token
   - "Down" would be priced at ~$0.80 (complements add to $1.00)
2. Market expired and only has residual liquidity
3. Looking at wrong market entirely

**Fix:**
- Use get-token-ids.ts to find CORRECT token for the outcome you want
- Verify market is active (not closed/expired)
- Check timestamps match

## Understanding Orderbook Cache

The orderbook cache in `orderbookCache.ts` works like this:

```typescript
// 1. Subscribe to token's orderbook
orderbookCache.subscribe(tokenId);

// 2. WebSocket sends "book" event (full snapshot)
{
  event_type: "book",
  asset_id: "123...",
  bids: [...],  // All buy orders
  asks: [...],  // All sell orders
}

// 3. Cache stores it in memory
books.set(tokenId, {
  bids: [...],  // Sorted high to low
  asks: [...],  // Sorted low to high
  lastUpdate: Date.now()
});

// 4. Later updates come as "price_change" events
{
  event_type: "price_change",
  asset_id: "123...",
  price_changes: [
    { side: "BUY", price: "0.21", size: "0" }  // size=0 means removed
  ]
}

// 5. Cache applies incremental changes
// Updates happen in real-time as market moves
```

**For BUY orders (taking liquidity from sellers):**
- We need the **ask side** (lowest sell price)
- `getBestPrice(tokenId, 'BUY')` returns `asks[0].price`

**For SELL orders (taking liquidity from buyers):**
- We need the **bid side** (highest buy price)
- `getBestPrice(tokenId, 'SELL')` returns `bids[0].price`

## Testing Your Live Agent

If orderbook test looks good but agent still has issues:

1. **Check which token agent subscribes to:**
   ```bash
   # In agent logs, look for:
   [OrderbookCache] Subscribing to 7600586494941538...
   ```

2. **Verify token ID is correct:**
   ```bash
   npx ts-node get-token-ids.ts "<market_url>"
   # Compare to agent's logs
   ```

3. **Test that specific token:**
   ```bash
   npx ts-node test-orderbook.ts 7600586494941538
   # Should show same prices as UI
   ```

4. **Check cache logic:**
   - For SELL trade: needs `bid` side (buyers)
   - For BUY trade: needs `ask` side (sellers)
   - Verify `getBestPrice()` returns correct side

## Real-Time Requirement

The cache IS real-time:
- WebSocket pushes updates as market moves
- Initial "book" snapshot has full orderbook
- "price_change" events update specific levels
- No polling needed - push-based updates
- Sub-second latency for price changes

The issue is NOT with real-time updates, but with:
1. Subscribing to wrong token ID
2. Parsing data incorrectly
3. Getting initial snapshot that's stale

Use these test scripts to verify data flow is correct!
