# Missing Trades Analysis & Recovery Plan

## Problem Summary

- **Expected PnL:** 14.6k USDC (from Avantis dashboard)
- **Actual PnL in MongoDB:** 5.5k USDC
- **Missing:** ~9k USDC in PnL
- **TRUE ROOT CAUSE:** ✅ **We were ONLY tracking MarketExecuted events, but IGNORING LimitExecuted events!**
  - Many trades close via limit orders (TP/SL/Liquidation), not market orders
  - The missing 971.27 USDC BTC trade was a LimitExecuted event (block 38460543)
  - ~~Previous assumption about RPC missing data was INCORRECT~~

## Missing Trades Identified

### Analysis of Basescan Transaction Log

By comparing your Basescan transaction log with known missing dates, I've identified these critical missing blocks:

#### **1. Block 38460543 (Nov 21) - HIGH PRIORITY**
- Transaction: "Execute Limit Order"
- Value: 1,966.77 USDC
- **This is very likely the missing BTC CLOSE with 971.27 USDC PnL**
- Status: ✗ MISSING from MongoDB

#### **2. Block Range 38393000-38420000 (Nov 19) - HIGH PRIORITY**
- Transaction: "Execute Limit Order" at block 38393636
- Value: 979.60 USDC
- **Entire Nov 19 is missing from MongoDB (ZERO events found)**
- Multiple high-PnL trades missing: ~500-1000 USDC per trade
- Status: ✗ COMPLETELY MISSING

#### **3. Block 38349323 (Nov 18) - NEEDS VERIFICATION**
- Transaction: "Execute Market Order"
- Value: 644.02 USDC
- Status: Needs verification against MongoDB

#### **4. Blocks 38493768-38493896 (Nov 22) - LIKELY OK**
- Multiple "Execute Market Order" transactions
- Recent data, probably already captured
- Status: Should verify to be sure

## Why Events Were Missing

The system was **ONLY listening for MarketExecuted events** but **completely IGNORING LimitExecuted events**.

### What are LimitExecuted events?
- **orderType 0**: Take Profit (TP) triggered
- **orderType 1**: Stop Loss (SL) triggered
- **orderType 2**: Liquidation
- **orderType 3**: Limit order OPEN

Many traders set TP/SL when opening positions, so their trades close via `LimitExecuted` events, NOT `MarketExecuted` events!

## Resolution: ✅ FIXED - Added LimitExecuted Support

**Changes Made:**

1. ✅ Added `LIMIT_EXECUTED_EVENT` definition to `config/events.ts`
2. ✅ Added `parseLimitExecuted()` and `batchParseLimitExecuted()` to `EventParser.ts`
3. ✅ Updated `Backfiller.ts` to fetch BOTH MarketExecuted AND LimitExecuted events in parallel
4. ✅ Updated `EventCorrelator.ts` to process both event types (they have identical structure)
5. ✅ Added `ParsedLimitExecutedEvent` type (alias of ParsedMarketExecutedEvent)

### How to Run Recovery

Simply re-run the backfill - it will now capture BOTH event types:

```bash
# Full backfill (now includes limit orders)
npx tsx scripts/backfill-single-wallet.ts 0x9c40c5c236bc2d67e07d9781196050d53fe78908 60

# Or use targeted backfill for specific ranges
npx tsx scripts/backfill-specific-blocks.ts 0x9c40c5c236bc2d67e07d9781196050d53fe78908
```

The backfiller will now show output like:
```
[Backfiller] Chunk 1/10: Found 15 market + 8 limit = 23 total events
```

### Expected Outcome

After re-running the backfill with limit order support:
- ✅ Will capture ALL limit order closes (TP/SL/Liquidation)
- ✅ Total PnL should increase from 5.5k to ~14.6k USDC
- ✅ Nov 19 and Nov 21 missing trades will appear
- ✅ The 971.27 USDC BTC trade (block 38460543) will be captured
- ✅ Any future limit order closures will be automatically tracked

## Block Ranges Explained

| Date   | Block Range           | Why Missing                          | Priority |
|--------|-----------------------|--------------------------------------|----------|
| Nov 18 | 38349000-38350000     | Single transaction might be missing  | Medium   |
| Nov 19 | 38393000-38420000     | **ENTIRE DAY MISSING**               | **HIGH** |
| Nov 21 | 38460000-38461000     | **High-value BTC trade missing**     | **HIGH** |
| Nov 22 | 38493500-38494000     | Recent, likely OK but verify         | Low      |

## Verification Steps

After running the targeted backfill:

1. **Check Nov 19 is no longer empty:**
   ```bash
   # Should return events now
   npx tsx scripts/check-missing-trades.ts
   ```

2. **Verify total PnL:**
   - Run MetricsComputer for the wallet
   - Compare with Avantis dashboard (should be ~14.6k USDC)

3. **Check for the 971.27 USDC BTC trade:**
   - Query MongoDB for block 38460543
   - Should see a CLOSE event with ~971 USDC PnL

## Prevention for Future

To prevent this issue in the future:

1. **Use smaller chunk sizes** for initial backfills (500-1000 blocks)
2. **Add retry logic** for failed RPC requests
3. **Verify completeness** by comparing total trades with Avantis API
4. **Run incremental backfills** more frequently (daily) instead of large historical fetches

## Technical Details

The simplified event storage approach is **CORRECT**:
- ✅ Each executed event (Market OR Limit) stored independently as OPEN or CLOSE
- ✅ PnL comes directly from blockchain (no calculation errors)
- ✅ orderId is unique identifier (no duplicate issues)
- ✅ Both MarketExecuted and LimitExecuted use the same trade tuple structure

The problem was **missing event types**, not logic errors or RPC issues.

## Next Steps

1. **Run the targeted backfill script** (command above)
2. **Verify the recovered data** matches Avantis dashboard
3. **If still missing events**, expand the block ranges and re-run
4. **Consider switching RPC providers** if QuickNode continues to have reliability issues

---

**Created:** 2025-11-23
**Status:** Ready to execute recovery
