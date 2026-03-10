/**
 * PnL Method Comparison
 *
 * Compares two PnL calculation approaches for a given wallet:
 *
 *   Method A — Positions-based (all-time, no time filter needed):
 *     PnL = sum(closedPosition.realizedPnl) + sum(openPosition.cashPnl)
 *
 *   Method B — Activity-based (cash flow):
 *     PnL = totalSells + totalRedeems + endingValue(open positions) - totalBuys
 *
 * Usage:
 *   npx tsx scripts/ai-hedge-fund/compare-pnl-methods.ts <wallet>
 *
 * Example:
 *   npx tsx scripts/ai-hedge-fund/compare-pnl-methods.ts 0x118689b24aead1d6e9507b8068d056b2ec4f051b
 */

const API_BASE = 'https://data-api.polymarket.com';
const wallet = process.argv[2];

if (!wallet) {
  console.error('Usage: npx tsx compare-pnl-methods.ts <wallet>');
  process.exit(1);
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface OpenPosition {
  conditionId: string;
  title: string;
  outcome: string;
  size: number;
  avgPrice: number;
  curPrice: number;
  initialValue: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
}

interface ClosedPosition {
  conditionId: string;
  title: string;
  outcome: string;
  realizedPnl: number;
  totalBought: number;
  timestamp: number;
}

interface Activity {
  conditionId: string;
  title: string;
  type: 'TRADE' | 'REDEEM' | 'SPLIT' | 'MERGE' | 'REWARD' | 'CONVERSION';
  side?: 'BUY' | 'SELL';
  usdcSize: number;
  timestamp: number;
}

// ─── Fetch helpers ────────────────────────────────────────────────────────────

async function fetchAllOpenPositions(): Promise<OpenPosition[]> {
  const LIMIT = 500;
  let all: OpenPosition[] = [];
  let offset = 0;

  while (true) {
    const url = `${API_BASE}/positions?user=${wallet}&sizeThreshold=0.1&limit=${LIMIT}&offset=${offset}`;
    const res = await fetch(url);
    if (res.status === 400) break;
    if (!res.ok) throw new Error(`open positions API error: ${res.status}`);
    const batch = await res.json() as OpenPosition[];
    if (batch.length === 0) break;
    all = all.concat(batch);
    console.log(`  open positions: fetched ${all.length}`);
    if (batch.length < LIMIT) break;
    offset += LIMIT;
    await sleep(100);
  }

  return all;
}

async function fetchAllClosedPositions(): Promise<ClosedPosition[]> {
  const LIMIT = 50; // API max
  let all: ClosedPosition[] = [];
  let offset = 0;

  while (true) {
    const url = `${API_BASE}/v1/closed-positions?user=${wallet}&limit=${LIMIT}&offset=${offset}&sortBy=TIMESTAMP&sortDirection=DESC`;
    const res = await fetch(url);
    if (res.status === 400) break;
    if (!res.ok) throw new Error(`closed positions API error: ${res.status}`);
    const batch = await res.json() as ClosedPosition[];
    if (batch.length === 0) break;
    all = all.concat(batch);
    const lastTs = batch[batch.length - 1]?.timestamp;
    console.log(`  closed positions: fetched ${all.length} (last: ${lastTs ? new Date(lastTs * 1000).toISOString().split('T')[0] : 'N/A'})`);
    if (batch.length < LIMIT) break;
    offset += LIMIT;
    await sleep(100);
  }

  return all;
}

async function fetchAllActivities(): Promise<Activity[]> {
  const LIMIT = 500;
  const MAX_OFFSET = 10000;
  let all: Activity[] = [];
  let offset = 0;

  while (offset <= MAX_OFFSET) {
    const url = `${API_BASE}/activity?user=${wallet}&limit=${LIMIT}&offset=${offset}&sortBy=TIMESTAMP&sortDirection=DESC`;
    const res = await fetch(url);
    if (res.status === 400) {
      console.log(`  activities: API 400 at offset=${offset} (pagination cap)`);
      break;
    }
    if (!res.ok) throw new Error(`activities API error: ${res.status}`);
    const batch = await res.json() as Activity[];
    if (batch.length === 0) break;
    all = all.concat(batch);
    const lastTs = batch[batch.length - 1]?.timestamp;
    console.log(`  activities: fetched ${all.length} (last: ${lastTs ? new Date(lastTs * 1000).toISOString().split('T')[0] : 'N/A'})`);
    if (batch.length < LIMIT) break;
    offset += LIMIT;
    await sleep(100);
  }

  return all;
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nWallet: ${wallet}\n`);

  // Fetch everything in parallel
  console.log('Fetching data...');
  const [openPositions, closedPositions, activities] = await Promise.all([
    fetchAllOpenPositions(),
    fetchAllClosedPositions(),
    fetchAllActivities(),
  ]);

  // ── Method A: Positions-based ─────────────────────────────────────────────
  const realizedPnl   = closedPositions.reduce((s, p) => s + p.realizedPnl, 0);
  const unrealizedPnl = openPositions.reduce((s, p) => s + p.cashPnl, 0);
  const methodA_pnl   = realizedPnl + unrealizedPnl;

  // Supporting data
  const totalCostBasis    = closedPositions.reduce((s, p) => s + p.totalBought, 0);
  const totalCurrentValue = openPositions.reduce((s, p) => s + p.currentValue, 0);
  const totalInitialValue = openPositions.reduce((s, p) => s + p.initialValue, 0);

  // ── Method B: Activity-based (cash flow) ──────────────────────────────────
  let totalBuys = 0, totalSells = 0, totalRedeems = 0;
  const conditionIds = new Set<string>();

  for (const a of activities) {
    conditionIds.add(a.conditionId);
    if (a.type === 'TRADE' && a.side === 'BUY')   totalBuys    += a.usdcSize;
    if (a.type === 'TRADE' && a.side === 'SELL')  totalSells   += a.usdcSize;
    if (a.type === 'REDEEM')                       totalRedeems += a.usdcSize;
  }

  // endingValue = currentValue of open positions whose conditionId appears in activities
  let endingValue = 0;
  const openPositionMap = new Map(openPositions.map(p => [p.conditionId, p]));
  for (const cid of conditionIds) {
    const p = openPositionMap.get(cid);
    if (p && p.curPrice > 0.001) endingValue += p.currentValue;
  }

  const methodB_pnl = totalSells + totalRedeems + endingValue - totalBuys;

  // ── Activity coverage check ───────────────────────────────────────────────
  // How many closed positions have NO activity records? (missing buy history)
  const closedWithActivity   = closedPositions.filter(p => conditionIds.has(p.conditionId)).length;
  const closedWithoutActivity = closedPositions.length - closedWithActivity;
  const missingBuys = closedPositions
    .filter(p => !conditionIds.has(p.conditionId))
    .reduce((s, p) => s + p.totalBought, 0);

  // ── Print results ─────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(60));
  console.log('  METHOD A — Positions-based (all-time)');
  console.log('═'.repeat(60));
  console.log(`  Closed positions:   ${closedPositions.length}`);
  console.log(`  Total cost basis:   $${totalCostBasis.toFixed(2)}`);
  console.log(`  Realized PnL:       $${realizedPnl.toFixed(2)}`);
  console.log(`  Open positions:     ${openPositions.length}`);
  console.log(`  Total init value:   $${totalInitialValue.toFixed(2)}`);
  console.log(`  Total curr value:   $${totalCurrentValue.toFixed(2)}`);
  console.log(`  Unrealized PnL:     $${unrealizedPnl.toFixed(2)}`);
  console.log(`  ─────────────────────────────────────`);
  console.log(`  TOTAL PnL (A):      $${methodA_pnl.toFixed(2)}`);

  console.log('\n' + '═'.repeat(60));
  console.log('  METHOD B — Activity-based cash flow (all activities fetched)');
  console.log('═'.repeat(60));
  console.log(`  Total activities:   ${activities.length}`);
  console.log(`  Unique conditionIds:${conditionIds.size}`);
  console.log(`  Total buys:         $${totalBuys.toFixed(2)}`);
  console.log(`  Total sells:        $${totalSells.toFixed(2)}`);
  console.log(`  Total redeems:      $${totalRedeems.toFixed(2)}`);
  console.log(`  Ending value:       $${endingValue.toFixed(2)}`);
  console.log(`  ─────────────────────────────────────`);
  console.log(`  TOTAL PnL (B):      $${methodB_pnl.toFixed(2)}`);

  console.log('\n' + '═'.repeat(60));
  console.log('  COMPARISON');
  console.log('═'.repeat(60));
  const diff = methodA_pnl - methodB_pnl;
  console.log(`  Difference (A - B): $${diff.toFixed(2)}`);
  console.log(`  Closed positions without any activity records: ${closedWithoutActivity} / ${closedPositions.length}`);
  console.log(`  Missing buy cost for those:  $${missingBuys.toFixed(2)}`);
  console.log(``);
  console.log(`  Interpretation:`);
  if (Math.abs(diff) < 1) {
    console.log(`  ✓ Methods agree — activity history is complete`);
  } else if (diff > 0) {
    console.log(`  Method A > B by $${diff.toFixed(2)}`);
    console.log(`  → Activity-based UNDERSTATES PnL (missing buy history → overstated cost)`);
    console.log(`    OR positions-based OVERSTATES (e.g. cashPnl counting pre-history gains)`);
  } else {
    console.log(`  Method B > A by $${Math.abs(diff).toFixed(2)}`);
    console.log(`  → Activity-based OVERSTATES PnL`);
    console.log(`  → Likely cause: buys missing from activity log, endingValue still counted in full`);
  }
  console.log('═'.repeat(60) + '\n');
}

main().catch(console.error);
