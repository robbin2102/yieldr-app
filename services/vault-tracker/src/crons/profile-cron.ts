/**
 * Profile Cron — runs full v3 profileTrader() every 24 hours per active vault wallet
 *
 * Each cycle:
 *  1. Loads active vault wallets from vaults collection
 *  2. Runs profileTrader(wallet) → { core, positions }
 *  3. Upserts core → vaults collection (preserves status, initial_capital_usdc)
 *  4. Upserts positions → vault_openPositions collection
 *  5. Recomputes vault_size_usdc from initial_capital_usdc + totalPnlAllTime
 */

import { getCollections } from '../db';
import { CONFIG } from '../config';
import { createLogger } from '../utils/logger';
import { profileTrader } from '../profiler/profile-trader-v3';

function startOfDay(d: Date): Date {
  const t = new Date(d);
  t.setUTCHours(0, 0, 0, 0);
  return t;
}

const log = createLogger('ProfileCron');

async function profileVaultWallet(wallet: string): Promise<void> {
  const { vaults, vaultOpenPositions } = getCollections();

  // Load current vault doc to preserve static fields
  const existing = await vaults.findOne({ wallet: wallet.toLowerCase() });
  if (!existing) {
    log.warn(`Wallet ${wallet} not found in vaults collection — skipping`);
    return;
  }

  const label = existing.traderLabel ?? wallet.slice(0, 10);
  log.info(`${label}: running full v3 profile...`);

  const started = Date.now();
  const { core, positions } = await profileTrader(wallet, {
    convictionMultiplier: CONFIG.CONVICTION_MULTIPLIER,
    verbose: false,
  });

  // Augment core with vault-specific fields that profileTrader doesn't know about
  const initialCapital = existing.initial_capital_usdc ?? 0;
  const totalPnl       = (core.totalPnlAllTime as number) ?? 0;
  const vaultSize      = initialCapital + totalPnl;

  const coreToSave = {
    ...core,
    // Preserve vault-specific fields
    status:               existing.status,
    traderLabel:          existing.traderLabel ?? core.traderLabel,
    initial_capital_usdc: initialCapital,
    vault_size_usdc:      vaultSize,
    // Preserve last_polled_activity_ts so poller doesn't reset
    last_polled_activity_ts: existing.last_polled_activity_ts ?? 0,
  };

  await vaults.replaceOne(
    { wallet: wallet.toLowerCase() },
    coreToSave,
    { upsert: true }
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (vaultOpenPositions as any).replaceOne(
    { wallet: wallet.toLowerCase() },
    { ...positions, wallet: wallet.toLowerCase() },
    { upsert: true }
  );

  // ── Seed vault_daily_snapshots from v3's accurate daily PnL series ─────
  // dailyPnLByFrame['30d'] is an array of daily realized PnL values (oldest→newest).
  // We build a cumulative series and upsert one snapshot per day.
  // This is the source of truth for the PnL chart — accurate because it uses
  // Polymarket's own realizedPnl from closedPositions API (not activity reconstruction).
  const { vaultDailySnapshots } = getCollections();
  const positionsDoc = positions as Record<string, unknown>;
  const dailyPnLSeries = (positionsDoc.dailyPnLByFrame as Record<string, number[]>)?.['30d'] ?? [];

  if (dailyPnLSeries.length > 0) {
    // Build cumulative from the END: today's cumulative = totalPnlAllTime - unrealized
    // Each prior day = subtract that day's realized PnL going backwards
    const totalRealized = (core.totalRealizedPnl as number) ?? 0;

    // dailyPnLSeries is chronological (oldest first), sum = 30d realized
    let runningCumulative = totalRealized;
    // Work backwards: today is last element
    const daySnapshots: { date: Date; dailyPnl: number; cumulative: number }[] = [];
    for (let i = dailyPnLSeries.length - 1; i >= 0; i--) {
      const dayPnl = dailyPnLSeries[i];
      const dayDate = new Date();
      dayDate.setUTCDate(dayDate.getUTCDate() - (dailyPnLSeries.length - 1 - i));
      daySnapshots.unshift({ date: startOfDay(dayDate), dailyPnl: dayPnl, cumulative: runningCumulative });
      runningCumulative -= dayPnl;
    }

    for (const snap of daySnapshots) {
      const snapVaultSize = initialCapital + snap.cumulative;
      await vaultDailySnapshots.updateOne(
        { wallet: wallet.toLowerCase(), date: snap.date },
        { $set: {
          wallet:              wallet.toLowerCase(),
          date:                snap.date,
          cumulative_pnl_usdc: snap.cumulative,
          daily_pnl_usdc:      snap.dailyPnl,
          vault_size_usdc:     snapVaultSize,
        }},
        { upsert: true }
      );
    }
    log.info(`${label}: seeded ${daySnapshots.length} daily snapshots from v3 dailyPnLSeries`);
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  log.success(
    `${label}: profile complete in ${elapsed}s | ` +
    `WR=${((core.win_rate as number) ?? 0).toFixed(1)}% | ` +
    `PnL=$${totalPnl.toFixed(0)} | ` +
    `VaultSize=$${vaultSize.toFixed(0)}`
  );
}

// ── Profile loop ──────────────────────────────────────────────

export async function startProfileCron(): Promise<void> {
  const { vaults } = getCollections();

  async function runCycle(): Promise<void> {
    const activeVaults = await vaults.find({ status: 'active' }).toArray();
    log.info(`Profile cycle — ${activeVaults.length} active vaults`);

    for (const vault of activeVaults) {
      try {
        await profileVaultWallet(vault.wallet);
      } catch (err: unknown) {
        const msg = (err as Error).message;
        if (msg.includes('BOT_SKIP')) {
          log.warn(`${vault.wallet}: skipped (bot guard triggered)`);
        } else {
          log.error(`${vault.wallet}: profile failed —`, msg);
        }
      }
      // Stagger between wallets — profiling is heavy (multiple paginated API calls)
      await delay(2000);
    }

    log.success('Profile cycle complete');
  }

  // Run immediately on service start
  await runCycle();

  // Then every 24h
  setInterval(async () => {
    try {
      await runCycle();
    } catch (err: unknown) {
      log.error('Profile cycle error:', (err as Error).message);
    }
  }, CONFIG.PROFILE_INTERVAL_MS);

  log.success(`Profile cron started — interval: ${CONFIG.PROFILE_INTERVAL_MS / 3600000}h`);
}

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
