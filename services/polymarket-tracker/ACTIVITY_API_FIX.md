# Activity API Fix - Trade Fetching Issue

## Problem
The Polymarket service was fetching 0 trade activities despite the wallet being actively traded, even though the Polymarket UI showed significant activity.

## Root Cause
The activity API was being called with `type=TRADE,REDEEM` (comma-separated), which was not returning any results. Testing revealed that:

1. `type=TRADE` alone works correctly and captures all buy/sell activity
2. `type=REDEEM` only captures closed positions that are redeemed by winners
3. Combining types with comma separation was not functioning as expected

## Solution
Changed both activity API functions to use **only** `ACTIVITY_TYPES.TRADE`:

### Files Modified
- `services/polymarket-tracker/api/activity.ts`

### Changes Made

#### fetchHistoricalActivity() - Line 30
```typescript
// Before:
type: `${ACTIVITY_TYPES.TRADE},${ACTIVITY_TYPES.REDEEM}`,

// After:
type: ACTIVITY_TYPES.TRADE, // Only TRADE - captures all buy/sell activity
```

#### fetchNewActivity() - Line 66
```typescript
// Before:
type: `${ACTIVITY_TYPES.TRADE},${ACTIVITY_TYPES.REDEEM}`,

// After:
type: ACTIVITY_TYPES.TRADE, // Only TRADE - captures all buy/sell activity
```

## Why This Works
According to Polymarket API behavior:
- **TRADE** type captures ALL trading activity (both BUY and SELL sides)
- Each trade activity includes a `side` field ('BUY' or 'SELL')
- REDEEM is unnecessary for tracking trading activity since it only captures position redemptions, not trades

## Testing

### API Test (User Verified)
```bash
# This works and returns trade data:
curl "https://data-api.polymarket.com/activity?user=0xecd55daa7c6900683b804d1d4db935fbfabe43f4&type=TRADE&limit=5"
```

### Expected Results After Fix
When running the service:
1. Historical fetch should capture all trades from last 30 days
2. Poller should detect new trades in real-time (60s interval)
3. Trades saved to `polymarket-trades` collection with:
   - `activityType`: 'TRADE'
   - `side`: 'BUY' or 'SELL'
   - `size`, `price`, `usdcSize`, `timestamp`, `transactionHash`

## Verification Steps

1. Pull latest changes:
```bash
git pull origin claude/review-polymarket-service-012DftPc5hN9x9YksieiKJFA
```

2. Restart the service:
```bash
npm run polymarket:start
```

3. Check logs for activity fetching:
```
✅ Fetched N TRADE activities
```

4. Verify in MongoDB:
```bash
mongosh "YOUR_MONGODB_URI"
use yieldr
db['polymarket-trades'].find({ walletAddress: '0xecd55daa7c6900683b804d1d4db935fbfabe43f4' }).count()
```

## Commit
```
fix: Use only TRADE type for activity API to capture all trading activity

- Remove REDEEM type from activity API calls
- TRADE type captures all buy/sell activity with side field
- REDEEM only captures position redemptions, not trades
- Fixes 0 activities fetched despite active trading
```

## Date
2025-12-05
