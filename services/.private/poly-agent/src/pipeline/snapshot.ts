/**
 * Edge-Ranked Trader Snapshots
 *
 * Runs once at the end of each 24h pipeline cycle (after edge-ranked-traders.ts).
 * Writes one doc per trader into ahf-edgeRankedSnapshots, joining:
 *   - Edge rank metrics    (ahf-edgeRankedTraders)
 *   - Consistency data     (polymarket-consistentTraders)
 *   - Core profile metrics (polymarket-traderProfiles)
 *
 * This builds a time-series of each trader's full pipeline journey,
 * allowing trend analysis across cycles (edge improving/degrading,
 * capital trend, win rate drift, entry/exit from ranked pool).
 *
 * TTL: 90 days (index set in db.ts)
 */

import { getPipelineDB, COLLECTIONS } from './db';
import { createLogger } from './logger';

const log = createLogger('Snapshot');

export async function snapshotEdgeRankedTraders(): Promise<number> {
  const db         = await getPipelineDB();
  const snapshotAt = new Date();

  // ── Load all three source collections ─────────────────────────────────────
  const [edgeDocs, consistentDocs, profileDocs] = await Promise.all([
    db.collection(COLLECTIONS.EDGE_RANKED_TRADERS)
      .find({})
      .toArray(),

    db.collection(COLLECTIONS.CONSISTENT_TRADERS)
      .find({ should_profile: true })
      .project({
        wallet: 1,
        consistent_categories: 1,
        leaderboard: 1,
        userName: 1,
        xUsername: 1,
        verifiedBadge: 1,
      })
      .toArray(),

    db.collection(COLLECTIONS.TRADER_PROFILES)
      .find({ tradingConsistency: { $exists: true } })
      .project({
        wallet: 1,
        capital_trend: 1,
        drawdown_trend: 1,
        insider_probability: 1,
        insider_score: 1,
        profitFactor: 1,
        avg_bet_size_usdc: 1,
        tradingConsistency: 1,
        specialty: 1,
        label: 1,
        profiledAt: 1,
        'timeframePnL.30d.roce': 1,
        'timeframePnL.30d.winRate': 1,
        'timeframePnL.30d.maxDrawdownPct': 1,
        roce_trend: 1,
        win_rate: 1,
        win_rate_sample_size: 1,
      })
      .toArray(),
  ]);

  // ── Index lookup maps ──────────────────────────────────────────────────────
  const consistentByWallet = new Map(consistentDocs.map(d => [d.wallet as string, d]));
  const profileByWallet    = new Map(profileDocs.map(d => [d.wallet as string, d]));

  const snapCollection = db.collection(COLLECTIONS.EDGE_RANKED_SNAPSHOTS);
  let written = 0;

  for (const edge of edgeDocs) {
    const wallet     = edge.wallet as string;
    const consistent = consistentByWallet.get(wallet);
    const profile    = profileByWallet.get(wallet);

    const doc = {
      snapshotAt,
      wallet,

      // ── Edge rank fields ─────────────────────────────────────────────────
      overall_rank:  edge.overall_rank,
      confidence:    edge.confidence,
      specialty:     edge.specialty,
      edge:          edge.edge,
      expected_wr:   edge.expected_wr,
      p_val:         edge.p_val,
      win_rate:      edge.win_rate,
      n:             edge.n,
      pf:            edge.pf,
      roce_30d:      edge.roce_30d,
      pnl_30d:       edge.pnl_30d,
      days_won_rate: edge.days_won_rate,
      sortino:       edge.sortino,
      act_per_day:   edge.act_per_day,
      insider:       edge.insider,
      insider_score: edge.insider_score,
      last_active:   edge.last_active,
      display_name:  edge.display_name,

      // ── Consistency fields ───────────────────────────────────────────────
      consistent_categories: consistent?.consistent_categories ?? null,
      leaderboard:           consistent?.leaderboard ?? null,
      userName:              consistent?.userName ?? null,
      xUsername:             consistent?.xUsername ?? null,

      // ── Profile fields ───────────────────────────────────────────────────
      capital_trend:         profile?.capital_trend ?? null,
      drawdown_trend:        profile?.drawdown_trend ?? null,
      insider_probability:   profile?.insider_probability ?? null,
      profitFactor:          profile?.profitFactor ?? null,
      avg_bet_size_usdc:     profile?.avg_bet_size_usdc ?? null,
      tradingConsistency:    profile?.tradingConsistency ?? null,
      profile_specialty:     profile?.specialty ?? null,
      label:                 profile?.label ?? null,
      profiledAt:            profile?.profiledAt ?? null,
      roce_trend:            profile?.roce_trend ?? null,
      win_rate_sample_size:  profile?.win_rate_sample_size ?? null,
      tf30_roce:             profile?.timeframePnL?.['30d']?.roce ?? null,
      tf30_win_rate:         profile?.timeframePnL?.['30d']?.winRate ?? null,
      tf30_max_drawdown_pct: profile?.timeframePnL?.['30d']?.maxDrawdownPct ?? null,
    };

    await snapCollection.insertOne(doc);
    written++;
  }

  return written;
}
