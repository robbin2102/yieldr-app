/**
 * Bucket raw liquidation history data into price zones.
 * Each bucket covers a 1% price range around current price.
 */
export interface LiqBucket {
  price_low: number;
  price_high: number;
  long_liq_usd: number;
  short_liq_usd: number;
  total_usd: number;
  count: number;
}

export async function bucketLiquidations(
  symbol: string,
  liqHistory: any[],
  currentPrice: number | null
): Promise<LiqBucket[]> {
  if (!liqHistory || liqHistory.length === 0) return [];
  if (!currentPrice || currentPrice <= 0) {
    // If no current price, use a flat bucketing approach
    return flatBucket(liqHistory);
  }

  // Create 20 buckets: 10% below to 10% above current price, each 1% wide
  const bucketCount = 20;
  const bucketWidthPct = 1; // 1% per bucket
  const rangeStartPct = -10;

  const buckets: LiqBucket[] = [];
  for (let i = 0; i < bucketCount; i++) {
    const lowPct = rangeStartPct + i * bucketWidthPct;
    const highPct = lowPct + bucketWidthPct;
    buckets.push({
      price_low: currentPrice * (1 + lowPct / 100),
      price_high: currentPrice * (1 + highPct / 100),
      long_liq_usd: 0,
      short_liq_usd: 0,
      total_usd: 0,
      count: 0,
    });
  }

  // Distribute liquidation data across buckets based on price
  for (const item of liqHistory) {
    const price = item?.price ?? item?.liqPrice ?? null;
    const longUsd = item?.longLiquidationUsd ?? 0;
    const shortUsd = item?.shortLiquidationUsd ?? 0;

    if (!price) {
      // No price info — distribute proportionally to middle bucket
      const midBucket = buckets[Math.floor(bucketCount / 2)];
      midBucket.long_liq_usd += longUsd;
      midBucket.short_liq_usd += shortUsd;
      midBucket.total_usd += longUsd + shortUsd;
      midBucket.count += 1;
      continue;
    }

    const pricePct = (price - currentPrice) / currentPrice * 100;
    const bucketIdx = Math.floor((pricePct - rangeStartPct) / bucketWidthPct);

    if (bucketIdx >= 0 && bucketIdx < buckets.length) {
      buckets[bucketIdx].long_liq_usd += longUsd;
      buckets[bucketIdx].short_liq_usd += shortUsd;
      buckets[bucketIdx].total_usd += longUsd + shortUsd;
      buckets[bucketIdx].count += 1;
    }
  }

  // Only return non-empty buckets
  return buckets.filter(b => b.total_usd > 0);
}

function flatBucket(liqHistory: any[]): LiqBucket[] {
  // Without price data, create a single aggregate bucket
  const totalLong = liqHistory.reduce((s, d) => s + (d?.longLiquidationUsd ?? 0), 0);
  const totalShort = liqHistory.reduce((s, d) => s + (d?.shortLiquidationUsd ?? 0), 0);

  if (totalLong === 0 && totalShort === 0) return [];

  return [{
    price_low: 0,
    price_high: 0,
    long_liq_usd: totalLong,
    short_liq_usd: totalShort,
    total_usd: totalLong + totalShort,
    count: liqHistory.length,
  }];
}
