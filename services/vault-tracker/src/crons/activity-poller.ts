/**
 * Activity Poller — runs every 1 minute per active vault wallet
 *
 * Each cycle:
 *  1. Fetches new Polymarket activities since last_polled_activity_ts
 *  2. Inserts new BUY trades into vault_trades (status: "open")
 *     On additional BUYs of same condition: increments size_usdc (scale-in)
 *  3. On SELL/REDEEM: closes matching vault_trade with pnl_usdc + status
 *  4. Refreshes vault_openPositions.topOpenPositions from /positions API
 *  5. Upserts today's vault_daily_snapshots
 *  6. Updates vaults.last_polled_activity_ts + vault_size_usdc
 */

import { getCollections, VaultDoc } from '../db';
import { CONFIG } from '../config';
import { createLogger } from '../utils/logger';

const log = createLogger('ActivityPoller');

// ── Polymarket activity type ──────────────────────────────────

interface PolyActivity {
  conditionId: string;
  asset: string;
  title: string;
  outcome: string;
  type: 'TRADE' | 'REDEEM' | 'SPLIT' | 'MERGE' | 'REWARD' | 'CONVERSION';
  side?: 'BUY' | 'SELL';
  size: number;
  price: number;
  usdcSize: number;
  timestamp: number;
  transactionHash: string;
}

interface PolyOpenPosition {
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

// ── Fetch helpers ─────────────────────────────────────────────

async function fetchActivitiesSince(wallet: string, sinceTs: number): Promise<PolyActivity[]> {
  const LIMIT = 100;
  const collected: PolyActivity[] = [];
  let offset = 0;

  while (true) {
    const url = `${CONFIG.POLYMARKET_API}/activity?user=${wallet}&limit=${LIMIT}&offset=${offset}&sortBy=TIMESTAMP&sortDirection=DESC`;
    const res = await fetch(url);
    if (!res.ok) {
      if (res.status === 400) break; // pagination cap
      throw new Error(`Polymarket API error ${res.status} fetching activities`);
    }

    const batch = (await res.json()) as PolyActivity[];
    if (batch.length === 0) break;

    let reachedOld = false;
    for (const a of batch) {
      if (a.timestamp <= sinceTs) { reachedOld = true; break; }
      collected.push(a);
    }

    if (reachedOld || batch.length < LIMIT) break;
    offset += LIMIT;
    await delay(CONFIG.API_DELAY_MS);
  }

  // Return in ascending order so we process oldest-first
  return collected.reverse();
}

async function fetchOpenPositions(wallet: string): Promise<PolyOpenPosition[]> {
  const LIMIT = 500;
  const all: PolyOpenPosition[] = [];
  let offset = 0;

  while (true) {
    const url = `${CONFIG.POLYMARKET_API}/positions?user=${wallet}&sizeThreshold=0.1&limit=${LIMIT}&offset=${offset}`;
    const res = await fetch(url);
    if (!res.ok) {
      if (res.status === 400) break;
      throw new Error(`Polymarket API error ${res.status} fetching positions`);
    }
    const batch = (await res.json()) as PolyOpenPosition[];
    if (batch.length === 0) break;
    all.push(...batch);
    if (batch.length < LIMIT) break;
    offset += LIMIT;
    await delay(CONFIG.API_DELAY_MS);
  }

  return all;
}

// ── Main per-wallet poll ──────────────────────────────────────

async function pollWallet(vault: VaultDoc): Promise<void> {
  const wallet = vault.wallet.toLowerCase();
  const { vaults, vaultTrades, vaultOpenPositions, vaultDailySnapshots } = getCollections();

  const sinceTs = vault.last_polled_activity_ts ?? 0;
  const label = vault.traderLabel ?? wallet.slice(0, 10);

  // ── 1. Fetch new activities ───────────────────────────────
  const activities = await fetchActivitiesSince(wallet, sinceTs);
  log.info(`${label}: ${activities.length} new activities since ${new Date(sinceTs * 1000).toISOString()}`);

  let newTrades = 0;
  let closedTrades = 0;
  let maxTs = sinceTs;

  // ── 2 & 3. Process each activity ─────────────────────────
  for (const a of activities) {
    if (a.timestamp > maxTs) maxTs = a.timestamp;

    if (a.type !== 'TRADE' && a.type !== 'REDEEM') continue;

    const conditionId = a.conditionId;

    if (a.type === 'TRADE' && a.side === 'BUY') {
      // Find or create open trade for this conditionId
      const existing = await vaultTrades.findOne({ wallet, condition_id: conditionId, status: 'open' });

      if (!existing) {
        await vaultTrades.insertOne({
          wallet,
          market:      a.title,
          side:        a.outcome.toUpperCase() === 'NO' ? 'NO' : 'YES',
          entry_price: a.price,
          exit_price:  null,
          size_usdc:   a.usdcSize,
          pnl_usdc:    null,
          status:      'open',
          condition_id: conditionId,
          opened_at:   new Date(a.timestamp * 1000),
          closed_at:   null,
        });
        newTrades++;
      } else {
        // Scale-in: add to existing size, update avg entry price
        const totalSize = existing.size_usdc + a.usdcSize;
        const avgEntry  = (existing.entry_price * existing.size_usdc + a.price * a.usdcSize) / totalSize;
        await vaultTrades.updateOne(
          { _id: existing._id },
          { $set: { size_usdc: totalSize, entry_price: avgEntry } }
        );
      }

    } else if (a.type === 'TRADE' && a.side === 'SELL') {
      const open = await vaultTrades.findOne({ wallet, condition_id: conditionId, status: 'open' });
      if (open) {
        const pnl = a.usdcSize - open.size_usdc;
        await vaultTrades.updateOne(
          { _id: open._id },
          { $set: {
            exit_price: a.price,
            pnl_usdc:   pnl,
            status:     pnl >= 0 ? 'win' : 'loss',
            closed_at:  new Date(a.timestamp * 1000),
          }}
        );
        closedTrades++;
      }

    } else if (a.type === 'REDEEM') {
      const open = await vaultTrades.findOne({ wallet, condition_id: conditionId, status: 'open' });
      if (open) {
        const pnl = a.usdcSize - open.size_usdc;
        await vaultTrades.updateOne(
          { _id: open._id },
          { $set: {
            exit_price: 1.0,
            pnl_usdc:   pnl,
            status:     pnl >= 0 ? 'win' : 'loss',
            closed_at:  new Date(a.timestamp * 1000),
          }}
        );
        closedTrades++;
      }
    }
  }

  // ── 4. Refresh open positions ─────────────────────────────
  await delay(CONFIG.API_DELAY_MS);
  const rawPositions = await fetchOpenPositions(wallet);

  const LOSS_THRESHOLD = 0.001;
  const topOpenPositions = rawPositions
    .filter(p => p.curPrice >= LOSS_THRESHOLD)
    .sort((a, b) => b.currentValue - a.currentValue)
    .map(p => ({
      title:        p.title,
      outcome:      p.outcome,
      size:         p.size,
      avgPrice:     p.avgPrice,
      curPrice:     p.curPrice,
      currentValue: p.currentValue,
      cashPnl:      p.cashPnl,
      percentPnl:   p.percentPnl,
    }));

  await vaultOpenPositions.updateOne(
    { wallet },
    { $set: { wallet, profiledAt: new Date(), topOpenPositions } },
    { upsert: true }
  );

  // ── 5. Upsert today's daily snapshot ─────────────────────
  // cumulative_pnl_usdc comes from v3 profiler's totalPnlAllTime (accurate).
  // The activity poller only owns daily_pnl_usdc (intraday approximation from vault_trades).
  // vault_size_usdc is owned by the profile cron — we never overwrite it here.
  const todayStart = startOfDay(new Date());

  // Re-read vault doc to get the latest totalPnlAllTime written by profile cron
  const freshVault = await vaults.findOne({ wallet });
  const cumulativePnl   = (freshVault?.totalPnlAllTime as number) ?? 0;
  const initialCapital  = freshVault?.initial_capital_usdc ?? vault.initial_capital_usdc ?? 0;
  const vaultSize       = initialCapital + cumulativePnl;

  // Daily PnL approximation — sum of vault_trades closed today
  const dailyCursor = await vaultTrades.aggregate([
    { $match: { wallet, status: { $in: ['win', 'loss'] }, closed_at: { $gte: todayStart } } },
    { $group: { _id: null, total: { $sum: '$pnl_usdc' } } },
  ]).toArray();
  const dailyPnl = (dailyCursor[0]?.total as number) ?? 0;

  await vaultDailySnapshots.updateOne(
    { wallet, date: todayStart },
    { $set: {
      wallet,
      date:                todayStart,
      cumulative_pnl_usdc: cumulativePnl,
      daily_pnl_usdc:      dailyPnl,
      vault_size_usdc:     vaultSize,
    }},
    { upsert: true }
  );

  // ── 6. Update vault state ──────────────────────────────────
  // Only update last_polled_activity_ts — vault_size_usdc is owned by profile cron
  await vaults.updateOne(
    { wallet },
    { $set: { last_polled_activity_ts: maxTs } }
  );

  if (newTrades > 0 || closedTrades > 0) {
    log.success(`${label}: +${newTrades} new trades, ${closedTrades} closed | v3PnL=$${cumulativePnl.toFixed(0)} | vaultSize=$${vaultSize.toFixed(0)}`);
  } else {
    log.info(`${label}: no new trades | ${topOpenPositions.length} open positions | snapshot ok`);
  }
}

// ── Poll loop ─────────────────────────────────────────────────

export async function startActivityPoller(): Promise<void> {
  const { vaults } = getCollections();

  async function runCycle(): Promise<void> {
    const activeVaults = await vaults.find({ status: 'active' }).toArray();
    log.info(`Activity poll cycle — ${activeVaults.length} active vaults`);

    for (const vault of activeVaults) {
      try {
        await pollWallet(vault);
      } catch (err: unknown) {
        log.error(`Failed polling ${vault.wallet}:`, (err as Error).message);
      }
      // Small stagger between wallets to respect rate limits
      await delay(500);
    }
  }

  // Run immediately on start
  await runCycle();

  // Then on interval
  setInterval(async () => {
    try {
      await runCycle();
    } catch (err: unknown) {
      log.error('Activity poll cycle error:', (err as Error).message);
    }
  }, CONFIG.ACTIVITY_POLL_INTERVAL_MS);

  log.success(`Activity poller started — interval: ${CONFIG.ACTIVITY_POLL_INTERVAL_MS / 1000}s`);
}

// ── Helpers ───────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function startOfDay(d: Date): Date {
  const t = new Date(d);
  t.setUTCHours(0, 0, 0, 0);
  return t;
}
