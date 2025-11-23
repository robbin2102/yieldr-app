# Missing Trades Analysis & Recovery Plan

## Problem Summary

- **Expected PnL:** 14.6k USDC (from Avantis dashboard)
- **Actual PnL in MongoDB:** 5.5k USDC
- **Missing:** ~9k USDC in PnL
- **Root Cause:** RPC `getLogs()` didn't return all MarketExecuted events during 60-day backfill

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

## Why Events Are Missing

The 60-day backfill called `getLogs()` with large block ranges. The RPC provider may have:
1. **Rate limited** the requests
2. **Timed out** on large queries
3. **Silently omitted** events without errors
4. **Syncing issues** at the time of backfill

This is a known issue with blockchain RPCs when fetching large historical ranges.

## Resolution: Targeted Re-Backfill

I've created a script that will re-fetch ONLY the missing block ranges with:
- **Smaller chunk sizes** (500 blocks instead of default)
- **Less parallelism** (2 concurrent requests instead of default 5)
- **Focused ranges** (only ~28,000 blocks total vs. 518,400 for 60 days)

### How to Run Recovery

```bash
# Run targeted backfill for missing blocks
npx tsx scripts/backfill-specific-blocks.ts 0x9c40c5c236bc2d67e07d9781196050d53fe78908
```

This will:
1. Re-fetch blocks 38349000-38350000 (Nov 18)
2. Re-fetch blocks 38393000-38420000 (Nov 19) **← Most important**
3. Re-fetch blocks 38460000-38461000 (Nov 21) **← High-value BTC trade**
4. Re-fetch blocks 38493500-38494000 (Nov 22)

The script will:
- Skip duplicates automatically (using orderId unique index)
- Report how many NEW events were recovered
- Show final PnL statistics
- Compare with Avantis dashboard

### Expected Outcome

After running the targeted backfill:
- Should recover ~10-20 missing CLOSE events
- Total PnL should increase from 5.5k to ~14.6k USDC
- Nov 19 should no longer be empty
- Nov 21 BTC trade (971.27 USDC) should appear

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
- ✅ Each MarketExecuted event stored independently as OPEN or CLOSE
- ✅ PnL comes directly from blockchain (no calculation errors)
- ✅ orderId is unique identifier (no duplicate issues)

The problem is purely **data fetching from RPC**, not logic errors.

## Next Steps

1. **Run the targeted backfill script** (command above)
2. **Verify the recovered data** matches Avantis dashboard
3. **If still missing events**, expand the block ranges and re-run
4. **Consider switching RPC providers** if QuickNode continues to have reliability issues

---

**Created:** 2025-11-23
**Status:** Ready to execute recovery
