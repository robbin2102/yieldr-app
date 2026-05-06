"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  hlSignals,
  type SignalV2,
  type WhaleEvent,
  type CoinMetrics,
  type Alert,
} from "@/lib/hyperliquid-signals";

const REFETCH_MS = 30_000;

function fmtUsd(n: number | null | undefined) {
  if (n == null) return "—";
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function fmtTs(ts: string | null | undefined) {
  if (!ts) return "—";
  return new Date(ts + (ts.endsWith("Z") ? "" : "Z")).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function pct(n: number | null | undefined, decimals = 0) {
  if (n == null) return "—";
  return `${(n * 100).toFixed(decimals)}%`;
}

// Short label + color + tooltip for each signal type
const SIGNAL_META: Record<string, { label: string; color: string; tooltip: string }> = {
  CONVERGENCE_ACCELERATION: {
    label: "ACCEL", color: "bg-red-900 text-red-300 border-red-800",
    tooltip: "Multiple conviction metrics (count, dollar, cohort%) growing across several time windows — smart money actively building this position.",
  },
  CAPITAL_ROTATION: {
    label: "ROT", color: "bg-orange-900 text-orange-300 border-orange-800",
    tooltip: "This coin's share of total cohort portfolio shifted significantly — capital flowing in or out relative to other coins.",
  },
  COHORT_DIRECTION_FLIP: {
    label: "FLIP", color: "bg-yellow-900 text-yellow-300 border-yellow-800",
    tooltip: "Dominant side switched LONG↔SHORT in the last 48h — cohort collectively changed directional view.",
  },
  WHALE_ACTIVITY: {
    label: "WHALE", color: "bg-purple-900 text-purple-300 border-purple-800",
    tooltip: "A Q1 (top-quartile) trader made a major move: wakeup after dormancy, large scaleup, full direction flip, or full exit.",
  },
  SMART_EXIT: {
    label: "EXIT", color: "bg-blue-900 text-blue-300 border-blue-800",
    tooltip: "Q1 traders closing positions at a higher rate than Q4 — smart money exiting faster than the crowd. Caution signal.",
  },
  LEVERAGE_SPIKE: {
    label: "LEV↑", color: "bg-pink-900 text-pink-300 border-pink-800",
    tooltip: "Average leverage jumped significantly vs 4h ago — cohort increasing risk exposure on this coin right now.",
  },
  ASYMMETRIC_POSITIONING: {
    label: "ASYM", color: "bg-teal-900 text-teal-300 border-teal-800",
    tooltip: "Large gap between headcount conviction and dollar conviction — whales and crowd are sizing very differently on the same side.",
  },
  FUNDING_DIVERGENCE: {
    label: "FUND", color: "bg-indigo-900 text-indigo-300 border-indigo-800",
    tooltip: "Cohort bias opposes the market funding rate — smart money positioned against the crowd's funding-implied lean.",
  },
  STALE_POSITION_DECAY: {
    label: "STALE", color: "bg-gray-800 text-gray-400 border-gray-700",
    tooltip: "Most holders entered long ago with few new entries recently — stagnant positions, conviction likely fading.",
  },
};

function SignalPill({ type, severity }: { type: string; severity: string }) {
  const meta = SIGNAL_META[type] ?? { label: type.slice(0, 5), color: "bg-gray-800 text-gray-400 border-gray-700", tooltip: type };
  const dimmed = severity === "MEDIUM" ? "opacity-60" : "";
  return (
    <span className={`relative group inline-flex ${dimmed}`}>
      <span className={`inline-flex items-center text-[9px] font-bold px-1 py-0.5 rounded border cursor-default ${meta.color}`}>
        {meta.label}
      </span>
      <span className="pointer-events-none absolute bottom-full left-0 mb-1.5 w-56 bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-[10px] text-gray-300 leading-relaxed invisible group-hover:visible z-50 shadow-xl whitespace-normal">
        <span className={`font-bold block mb-0.5 ${meta.color.split(" ")[1]}`}>{meta.label}</span>
        {meta.tooltip}
      </span>
    </span>
  );
}

export default function HyperliquidDashboard() {
  const qc = useQueryClient();
  const [hours, setHours] = useState(24);

  const { data: dashData, isLoading, isError: dashError } = useQuery({
    queryKey: ["hl-dashboard", hours],
    queryFn: () => hlSignals.getDashboard(hours),
    refetchInterval: REFETCH_MS,
    retry: 1,
  });

  const { data: alertsData } = useQuery({
    queryKey: ["hl-alerts"],
    queryFn: () => hlSignals.getAlerts(undefined, false),
    refetchInterval: REFETCH_MS,
  });

  const { data: cohortData } = useQuery({
    queryKey: ["hl-cohort-meta"],
    queryFn: () => hlSignals.getCohort(1, 1),
    refetchInterval: REFETCH_MS * 6,
  });

  const { data: cohortChangesData } = useQuery({
    queryKey: ["hl-cohort-changes"],
    queryFn: () => hlSignals.getCohortChanges(1),
    refetchInterval: REFETCH_MS * 6,
  });

  const { data: metricsData } = useQuery({
    queryKey: ["hl-coin-metrics"],
    queryFn: () => hlSignals.getCoinMetrics(200),
    refetchInterval: REFETCH_MS,
  });

  const alerts: Alert[] = alertsData?.data ?? [];
  const tier1Alerts = alerts.filter((a) => a.severity === 1).slice(0, 3);

  const totalTraders = cohortData?.total ?? 0;
  const todayChanges = cohortChangesData?.data ?? [];
  const newToday = todayChanges.filter((c) => c.change_type === "NEW_ENTRANT").length;
  const droppedToday = todayChanges.filter((c) => c.change_type === "DROPPED").length;

  const metrics: CoinMetrics[] = metricsData?.data ?? [];
  const totalPortfolioUsd = metrics.reduce((s, m) => s + m.total_usd, 0);
  const snapshotTs = dashData?.snapshot_ts ?? metricsData?.snapshot_ts ?? null;

  // Build coin → signals map from dashboard data
  const signalsByCoin = useMemo(() => {
    const map = new Map<string, SignalV2[]>();
    const allSigs: SignalV2[] = [
      ...(dashData?.accelerating ?? []),
      ...(dashData?.direction_flips ?? []),
      ...(dashData?.exits ?? []),
    ];
    for (const s of allSigs) {
      const arr = map.get(s.coin) ?? [];
      arr.push(s);
      map.set(s.coin, arr);
    }
    // Deduplicate per signal_type per coin, keep highest severity
    const sevOrder: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
    map.forEach((sigs, coin) => {
      const seen = new Map<string, SignalV2>();
      for (const s of sigs) {
        const ex = seen.get(s.signal_type);
        if (!ex || (sevOrder[s.severity] ?? 9) < (sevOrder[ex.severity] ?? 9)) {
          seen.set(s.signal_type, s);
        }
      }
      map.set(coin, Array.from(seen.values()));
    });
    return map;
  }, [dashData]);

  // Whale moves per coin (latest event type per coin)
  const whaleByCoin = useMemo(() => {
    const map = new Map<string, WhaleEvent[]>();
    for (const e of dashData?.whale_moves ?? []) {
      const arr = map.get(e.coin) ?? [];
      arr.push(e);
      map.set(e.coin, arr);
    }
    return map;
  }, [dashData?.whale_moves]);

  const acknowledgeAlert = async (id: string) => {
    await hlSignals.acknowledgeAlert(id);
    qc.invalidateQueries({ queryKey: ["hl-alerts"] });
  };

  return (
    <div className="min-h-screen bg-gray-950 text-gray-200 font-mono text-sm">
      {/* Header */}
      <div className="border-b border-gray-800 px-4 py-3 flex flex-wrap items-center gap-6">
        <h1 className="text-white font-bold text-base tracking-wider">
          HL SIGNALS <span className="text-green-500">▶</span>
        </h1>
        <div className="flex gap-5 text-xs text-gray-400 flex-wrap">
          <span>COHORT <span className="text-white font-bold">{totalTraders}</span></span>
          <span>PORTFOLIO <span className="text-green-400 font-bold">{fmtUsd(totalPortfolioUsd)}</span></span>
          <span>SNAPSHOT <span className="text-gray-300">{fmtTs(snapshotTs)}</span></span>
          <span>
            NEW <span className="text-green-400 font-bold">+{newToday}</span>{" / "}
            DROP <span className="text-red-400 font-bold">-{droppedToday}</span>
          </span>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <div className="flex gap-1">
            {[4, 24, 48].map((h) => (
              <button
                key={h}
                onClick={() => setHours(h)}
                className={`text-xs px-2 py-0.5 rounded ${
                  hours === h ? "bg-gray-700 text-white" : "text-gray-600 hover:text-gray-400"
                }`}
              >
                {h}h
              </button>
            ))}
          </div>
          <Link href="/intel/hyperliquid/cohort" className="text-xs text-blue-400 hover:text-blue-300">
            Cohort →
          </Link>
          <span className="text-xs text-gray-700">auto-refresh 30s</span>
        </div>
      </div>

      {/* Tier 1 Alert Banner */}
      {tier1Alerts.length > 0 && (
        <div className="bg-yellow-950 border-b border-yellow-800 px-4 py-2 flex flex-wrap gap-3">
          <span className="text-yellow-500 font-bold text-xs shrink-0">⚠ TIER 1</span>
          {tier1Alerts.map((alert) => (
            <div
              key={alert.id}
              className="flex items-center gap-2 bg-yellow-900/40 border border-yellow-800 rounded px-3 py-1 text-xs"
            >
              <span className="text-white font-bold">{alert.coin}</span>
              <span className={alert.side === "LONG" ? "text-green-400" : "text-red-400"}>{alert.side}</span>
              <span className="text-yellow-300">{(alert.conviction * 100).toFixed(0)}% bias</span>
              <span className="text-gray-400">{alert.n_traders} traders</span>
              <span className="text-gray-400">{fmtUsd(alert.total_usd)}</span>
              <button onClick={() => acknowledgeAlert(alert.id)} className="text-gray-500 hover:text-gray-300 ml-1">✕</button>
            </div>
          ))}
        </div>
      )}

      {dashError && (
        <div className="mx-4 mt-3 bg-red-950 border border-red-800 rounded px-4 py-2 text-xs text-red-400 font-mono">
          ⚠ API unreachable — check HL_SIGNALS_API_URL env var in Vercel (server-side, no NEXT_PUBLIC_ prefix)
        </div>
      )}

      {/* Coin Metrics Table */}
      <div className="p-4">
        {isLoading ? (
          <div className="text-center text-gray-600 text-xs py-12">Loading…</div>
        ) : metrics.length === 0 ? (
          <div className="text-center text-gray-700 text-xs py-12">No data yet — waiting for first snapshot.</div>
        ) : (
          <div className="bg-gray-900 border border-gray-800 rounded overflow-auto">
            <table className="w-full text-xs font-mono">
              <thead>
                <tr className="text-gray-600 border-b border-gray-800 text-[10px]">
                  <th className="text-left px-3 py-2">Coin</th>
                  <th className="text-left px-3 py-2">Side</th>
                  <th className="text-right px-3 py-2">Count %</th>
                  <th className="text-right px-3 py-2">$ %</th>
                  <th className="text-right px-3 py-2">Cohort</th>
                  <th className="text-right px-3 py-2">Traders</th>
                  <th className="text-right px-3 py-2">Total USD</th>
                  <th className="text-right px-3 py-2">Lev</th>
                  <th className="text-right px-3 py-2">Q1 L/S</th>
                  <th className="text-left px-3 py-2">Signals</th>
                </tr>
              </thead>
              <tbody>
                {metrics.map((m) => {
                  const sideColor = m.dominant_side === "LONG" ? "text-green-400" : "text-red-400";
                  const coinSigs = signalsByCoin.get(m.coin) ?? [];
                  const whaleEvts = whaleByCoin.get(m.coin) ?? [];

                  // Sort: HIGH first
                  const sevOrd: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
                  const sortedSigs = [...coinSigs].sort(
                    (a, b) => (sevOrd[a.severity] ?? 9) - (sevOrd[b.severity] ?? 9)
                  );

                  return (
                    <tr key={m.coin} className="border-b border-gray-900 hover:bg-gray-800">
                      <td className="px-3 py-2">
                        <Link
                          href={`/intel/hyperliquid/coin/${m.coin}`}
                          className="text-white font-bold hover:text-blue-400"
                        >
                          {m.coin}
                        </Link>
                      </td>
                      <td className={`px-3 py-2 font-bold ${sideColor}`}>
                        {m.dominant_side === "LONG" ? "▲" : "▼"} {m.dominant_side}
                      </td>
                      <td className="px-3 py-2 text-right text-gray-300">{pct(m.count_conviction)}</td>
                      <td className="px-3 py-2 text-right text-gray-300">{pct(m.dollar_conviction)}</td>
                      <td className="px-3 py-2 text-right text-gray-400">{pct(m.cohort_participation, 1)}</td>
                      <td className="px-3 py-2 text-right text-gray-400">{m.total_count}</td>
                      <td className="px-3 py-2 text-right text-gray-300">{fmtUsd(m.total_usd)}</td>
                      <td className="px-3 py-2 text-right text-gray-500">{m.avg_leverage.toFixed(1)}x</td>
                      <td className="px-3 py-2 text-right">
                        <span className="text-green-700">{m.q1_long}</span>
                        <span className="text-gray-700"> / </span>
                        <span className="text-red-700">{m.q1_short}</span>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-1">
                          {sortedSigs.map((s, i) => (
                            <SignalPill key={i} type={s.signal_type} severity={s.severity} />
                          ))}
                          {whaleEvts.length > 0 && (
                            <span className="inline-flex items-center text-[9px] font-bold px-1 py-0.5 rounded border bg-purple-900 text-purple-300 border-purple-800">
                              🐋 {whaleEvts.length}
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
