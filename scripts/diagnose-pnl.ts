/**
 * Diagnostic script to understand P&L discrepancy between Polymarket UI and our profiler
 */

const API_BASE = 'https://data-api.polymarket.com';

interface Position {
  conditionId: string;
  title: string;
  outcome: string;
  size: number;
  avgPrice: number;
  curPrice: number;
  initialValue: number;
  currentValue: number;
  cashPnl: number;
}

interface ClosedPosition {
  title: string;
  outcome: string;
  totalBought: number;
  avgPrice: number;
  realizedPnl: number;
  timestamp: number;
}

async function diagnose(wallet: string, label: string) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`DIAGNOSING: ${label} (${wallet})`);
  console.log('='.repeat(70));

  // 1. Fetch positions
  console.log('\n1. POSITIONS API (/positions):');
  const posUrl = `${API_BASE}/positions?user=${wallet}&sizeThreshold=0.1&limit=500`;
  const posRes = await fetch(posUrl);
  const positions = await posRes.json() as Position[];

  console.log(`   Total positions returned: ${positions.length}`);

  // Group by price range
  const active = positions.filter(p => p.curPrice >= 0.001 && p.curPrice <= 0.99);
  const resolvedLosses = positions.filter(p => p.curPrice < 0.001);
  const resolvedWins = positions.filter(p => p.curPrice > 0.99);

  console.log(`   - Active (0.1¢-99¢): ${active.length}`);
  console.log(`   - Resolved Losses (< 0.1¢): ${resolvedLosses.length}`);
  console.log(`   - Resolved Wins (> 99¢): ${resolvedWins.length}`);

  // Show top positions by value
  console.log('\n   Top 10 positions by currentValue:');
  const sorted = [...positions].sort((a, b) => b.currentValue - a.currentValue);
  for (const p of sorted.slice(0, 10)) {
    const price = (p.curPrice * 100).toFixed(1);
    const title = p.title ? p.title.substring(0, 40) : 'N/A';
    console.log(`   - ${title}... | ${price}¢ | $${(p.currentValue || 0).toFixed(2)} | PnL: $${(p.cashPnl || 0).toFixed(2)}`);
  }

  // Show resolved wins specifically
  if (resolvedWins.length > 0) {
    console.log('\n   Resolved WINS (100¢):');
    for (const p of resolvedWins) {
      const title = p.title ? p.title.substring(0, 50) : 'N/A';
      const profit = p.currentValue - p.initialValue;
      console.log(`   - ${title}... | +$${profit.toFixed(2)}`);
    }
  }

  // Show resolved losses specifically
  if (resolvedLosses.length > 0) {
    console.log('\n   Resolved LOSSES (0¢):');
    for (const p of resolvedLosses.slice(0, 10)) {
      const title = p.title ? p.title.substring(0, 50) : 'N/A';
      console.log(`   - ${title}... | -$${p.initialValue.toFixed(2)}`);
    }
    if (resolvedLosses.length > 10) {
      console.log(`   ... and ${resolvedLosses.length - 10} more`);
    }
  }

  // Calculate totals from positions
  const totalOpenValue = active.reduce((s, p) => s + (p.currentValue || 0), 0);
  const totalUnrealizedPnl = active.reduce((s, p) => s + (p.cashPnl || 0), 0);
  const totalResolvedLoss = resolvedLosses.reduce((s, p) => s + (p.initialValue || 0), 0);
  const totalResolvedWin = resolvedWins.reduce((s, p) => s + ((p.currentValue || 0) - (p.initialValue || 0)), 0);

  console.log('\n   Calculated from /positions:');
  console.log(`   - Open Value: $${totalOpenValue.toFixed(2)}`);
  console.log(`   - Unrealized PnL: $${totalUnrealizedPnl.toFixed(2)}`);
  console.log(`   - Resolved Losses: -$${totalResolvedLoss.toFixed(2)}`);
  console.log(`   - Resolved Wins: +$${totalResolvedWin.toFixed(2)}`);

  // 2. Fetch closed positions
  console.log('\n2. CLOSED POSITIONS API (/v1/closed-positions):');
  const now = Math.floor(Date.now() / 1000);
  const startTs = now - (30 * 24 * 60 * 60); // 30 days

  let allClosed: ClosedPosition[] = [];
  let offset = 0;
  let done = false;
  while (!done && offset < 5000) {
    const url = `${API_BASE}/v1/closed-positions?user=${wallet}&limit=50&offset=${offset}&sortBy=TIMESTAMP&sortDirection=DESC`;
    const res = await fetch(url);
    const batch = await res.json() as ClosedPosition[];
    if (batch.length === 0) break;

    for (const pos of batch) {
      if (pos.timestamp >= startTs) {
        allClosed.push(pos);
      } else {
        done = true;
        break;
      }
    }
    if (batch.length < 50) break;
    offset += 50;
    await new Promise(r => setTimeout(r, 100));
  }

  console.log(`   Closed positions (30 days): ${allClosed.length}`);

  const closedWins = allClosed.filter(p => p.realizedPnl >= 0);
  const closedLosses = allClosed.filter(p => p.realizedPnl < 0);
  const closedProfit = closedWins.reduce((s, p) => s + p.realizedPnl, 0);
  const closedLoss = closedLosses.reduce((s, p) => s + Math.abs(p.realizedPnl), 0);

  console.log(`   - Wins: ${closedWins.length} (+$${closedProfit.toFixed(2)})`);
  console.log(`   - Losses: ${closedLosses.length} (-$${closedLoss.toFixed(2)})`);
  console.log(`   - Net Closed P&L: $${(closedProfit - closedLoss).toFixed(2)}`);

  // Show top closed positions
  if (allClosed.length > 0) {
    console.log('\n   Top 10 closed by |realizedPnl|:');
    const sortedClosed = [...allClosed].sort((a, b) => Math.abs(b.realizedPnl) - Math.abs(a.realizedPnl));
    for (const p of sortedClosed.slice(0, 10)) {
      const sign = p.realizedPnl >= 0 ? '+' : '';
      const title = p.title ? p.title.substring(0, 40) : 'N/A';
      console.log(`   - ${title}... | ${sign}$${p.realizedPnl.toFixed(2)}`);
    }
  }

  // 3. Final calculation - CORRECTED APPROACH
  console.log('\n3. CORRECTED P&L CALCULATION (30-day period):');
  console.log('   ─────────────────────────────────────');
  console.log('   IMPORTANT: /positions API returns ALL-TIME data (no time filter)');
  console.log('   Only /v1/closed-positions supports time filtering!');
  console.log('   ─────────────────────────────────────');

  const netFromClosed = closedProfit - closedLoss;

  console.log(`\n   ✅ CORRECT: Use /v1/closed-positions only (30-day filtered):`);
  console.log(`      Realized P&L: $${netFromClosed.toFixed(2)}`);
  console.log(`      + Unrealized PnL: $${totalUnrealizedPnl.toFixed(2)}`);
  console.log(`      ─────────────────────────────────────`);
  console.log(`      30-DAY TOTAL P&L: $${(netFromClosed + totalUnrealizedPnl).toFixed(2)}`);

  // Show what the WRONG calculation looked like (mixing ALL-TIME with 30-day)
  const wrongTotalRealizedPnl = netFromClosed - totalResolvedLoss + totalResolvedWin;
  console.log(`\n   ❌ WRONG (old approach - mixing ALL-TIME with 30-day):`);
  console.log(`      /closed-positions (30-day): $${netFromClosed.toFixed(2)}`);
  console.log(`      + resolved losses (ALL-TIME): -$${totalResolvedLoss.toFixed(2)}`);
  console.log(`      + resolved wins (ALL-TIME): +$${totalResolvedWin.toFixed(2)}`);
  console.log(`      ─────────────────────────────────────`);
  console.log(`      WRONG TOTAL: $${(wrongTotalRealizedPnl + totalUnrealizedPnl).toFixed(2)}`);

  console.log(`\n   📊 The ${resolvedLosses.length} resolved losses are ALL-TIME losses`);
  console.log(`      They should NOT be added to a 30-day P&L calculation!`);
}

async function showApiDocNote() {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('API DOCUMENTATION NOTE:');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('- /positions API: Returns ALL positions (no time filter available)');
  console.log('- /v1/closed-positions API: Has timestamp field, can filter by time');
  console.log('- For period-based P&L, ONLY use /v1/closed-positions');
  console.log('- Resolved positions from /positions are ALL-TIME historical data');
  console.log('═══════════════════════════════════════════════════════════════');
}

async function main() {
  await showApiDocNote();
  await diagnose('0x2a2c53bd278c04da9962fcf96490e17f3dfb9bc1', 'test-wallet');
}

main().catch(console.error);
