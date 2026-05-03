"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  hlSignals,
  type DashboardData,
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
  return new Date(ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
}

function pct(n: number | null | undefined, decimals = 0) {
  if (n == null) return "—";
  return `${(n * 100).toFixed(decimals)}%`;
}

// Sub-metric pill: "91% count | 99% $ | 28% cohort"
function SubMetrics({
  countConviction,
  dollarConviction,
  cohortParticipation,
}: {
  countConviction?: number | null;
  dollarConviction?: number | null;
  cohortParticipation?: number | null;
}) {
  return (
    <div className="flex gap-1 text-[10px] font-mono text-gray-500 flex-wrap mt-1">
      <span>{pct(countConviction, 0)} count</span>
      <span className="text-gray-700">|</span>
      <span>{pct(dollarConviction, 0)} $</span>
      <span className="text-gray-700">|</span>
      <span>{pct(cohortParticipation, 1)} cohort</span>
    </div>
  );
}

const SEV_COLOR: Record<string, string> = {
  HIGH: "text-red-400 border-red-800",
  MEDIUM: "text-yellow-400 border-yellow-800",
  LOW: "text-blue-400 border-blue-800",
};

function SignalCard({ signal }: { signal: SignalV2 }) {
  const side = signal.side;
  const sideColor = side === "LONG" ? "text-green-400" : "text-red-400";
  const sevClass = SEV_COLOR[signal.severity] ?? "text-gray-400 border-gray-700";

  return (
    <Link href={`/intel/hyperliquid/coin/${signal.coin}`}>
      <div
        className={`border ${sevClass} bg-gray-900 rounded p-2.5 hover:bg-gray-800 transition-colors cursor-pointer`}
      >
        <div className="flex items-center justify-between">
          <span className="font-mono font-bold text-white">{signal.coin}</span>
          <div className="flex items-center gap-1">
            <span className={`text-[10px] font-bold px-1 border rounded ${sevClass}`}>
              {signal.severity}
            </span>
            <span className={`text-xs font-bold ${sideColor}`}>
              {side === "LONG" ? "▲" : "▼"} {side}
            </span>
          </div>
        </div>
        <div className="text-[10px] font-mono text-gray-500 mt-0.5">
          {signal.signal_type.replace(/_/g, " ")}
        </div>
        {signal.total_usd != null && (
          <div className="text-xs font-mono text-gray-400 mt-1">
            {fmtUsd(signal.total_usd)}
            {signal.total_count != null && (
              <span className="text-gray-600"> · {signal.total_count} traders</span>
            )}
          </div>
        )}
        <SubMetrics
          countConviction={signal.count_conviction}
          dollarConviction={signal.dollar_conviction}
          cohortParticipation={signal.cohort_participation}
        />
      </div>
    </Link>
  );
}

const EVENT_COLOR: Record<string, string> = {
  WAKEUP: "text-purple-400",
  SCALEUP: "text-green-400",
  FLIP: "text-yellow-400",
  EXIT: "text-red-400",
  LEVERAGE_PUSH: "text-orange-400",
};

function WhaleCard({ event }: { event: WhaleEvent }) {
  const sideColor = event.side === "LONG" ? "text-green-400" : "text-red-400";
  const evColor = EVENT_COLOR[event.event_type] ?? "text-gray-400";

  return (
    <Link href={`/intel/hyperliquid/coin/${event.coin}`}>
      <div className="border border-gray-800 bg-gray-900 rounded p-2.5 hover:bg-gray-800 transition-colors cursor-pointer">
        <div className="flex items-center justify-between">
          <span className="font-mono font-bold text-white">{event.coin}</span>
          <span className={`text-xs font-bold font-mono ${evColor}`}>{event.event_type}</span>
        </div>
        <div className="flex items-center gap-2 mt-1 text-xs font-mono">
          <span className={sideColor}>{event.side === "LONG" ? "▲" : "▼"} {event.side}</span>
          <span className="text-gray-400">{fmtUsd(event.size_usd)}</span>
          <span className="text-gray-600">{fmtTs(event.ts)}</span>
        </div>
        <div className="text-[10px] font-mono text-gray-600 mt-0.5 truncate">
          {event.address.slice(0, 10)}…
        </div>
      </div>
    </Link>
  );
}

function Column({
  title,
  children,
  count,
}: {
  title: string;
  children?: ReactNode;
  count: number;
}) {
  return (
    <div className="flex flex-col gap-2 min-w-0">
      <div className="flex items-center gap-2 mb-1">
        <h2 className="text-gray-500 text-xs font-bold tracking-widest">{title}</h2>
        <span className="text-gray-700 text-xs">({count})</span>
      </div>
      <div className="space-y-2 overflow-y-auto max-h-[calc(100vh-160px)] pr-1">
        {count === 0 ? (
          <p className="text-gray-700 text-xs font-mono">No signals yet.</p>
        ) : (
          children
        )}
      </div>
    </div>
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
    queryFn: () => hlSignals.getCoinMetrics(50),
    refetchInterval: REFETCH_MS,
  });

  const dashboard = dashData;
  const alerts: Alert[] = alertsData?.data ?? [];
  const tier1Alerts = alerts.filter((a) => a.severity === 1).slice(0, 3);

  const totalTraders = cohortData?.total ?? 0;
  const todayChanges = cohortChangesData?.data ?? [];
  const newToday = todayChanges.filter((c) => c.change_type === "NEW_ENTRANT").length;
  const droppedToday = todayChanges.filter((c) => c.change_type === "DROPPED").length;

  const metrics = metricsData?.data ?? [];
  const totalPortfolioUsd = metrics.reduce((s, m) => s + m.total_usd, 0);

  const snapshotTs = dashboard?.snapshot_ts ?? metricsData?.snapshot_ts ?? null;

  const acknowledgeAlert = async (id: string) => {
    await hlSignals.acknowledgeAlert(id);
    qc.invalidateQueries({ queryKey: ["hl-alerts"] });
  };

  const accelerating = dashboard?.accelerating ?? [];
  const whaleMoves = dashboard?.whale_moves ?? [];
  const directionFlips = dashboard?.direction_flips ?? [];
  const exits = dashboard?.exits ?? [];

  // Sort signals: HIGH first, then by total_usd desc
  const sortSigs = (sigs: SignalV2[]) =>
    [...sigs].sort((a, b) => {
      const sevOrder: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
      const d = (sevOrder[a.severity] ?? 9) - (sevOrder[b.severity] ?? 9);
      if (d !== 0) return d;
      return (b.total_usd ?? 0) - (a.total_usd ?? 0);
    });

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
          <Link
            href="/intel/hyperliquid/cohort"
            className="text-xs text-blue-400 hover:text-blue-300"
          >
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
              <span className={alert.side === "LONG" ? "text-green-400" : "text-red-400"}>
                {alert.side}
              </span>
              <span className="text-yellow-300">{(alert.conviction * 100).toFixed(0)}% bias</span>
              <span className="text-gray-400">{alert.n_traders} traders</span>
              <span className="text-gray-400">{fmtUsd(alert.total_usd)}</span>
              <button
                onClick={() => acknowledgeAlert(alert.id)}
                className="text-gray-500 hover:text-gray-300 ml-1"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {/* 4-Column Dashboard */}
      {dashError && (
        <div className="mx-4 mt-3 bg-red-950 border border-red-800 rounded px-4 py-2 text-xs text-red-400 font-mono">
          ⚠ API unreachable — check HL_SIGNALS_API_URL env var in Vercel (server-side, no NEXT_PUBLIC_ prefix)
        </div>
      )}
      {isLoading ? (
        <div className="p-8 text-center text-gray-600 text-xs">Loading signals…</div>
      ) : (
        <div className="p-4 grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Column title="ACCELERATING" count={accelerating.length}>
            {sortSigs(accelerating).map((s, i) => (
              <SignalCard key={`${s.signal_type}-${s.coin}-${i}`} signal={s} />
            ))}
          </Column>

          <Column title="WHALE MOVES" count={whaleMoves.length}>
            {whaleMoves.map((e, i) => (
              <WhaleCard key={`${e.address}-${e.coin}-${i}`} event={e} />
            ))}
          </Column>

          <Column title="DIRECTION FLIPS" count={directionFlips.length}>
            {sortSigs(directionFlips).map((s, i) => (
              <SignalCard key={`${s.signal_type}-${s.coin}-${i}`} signal={s} />
            ))}
          </Column>

          <Column title="EXITS" count={exits.length}>
            {sortSigs(exits).map((s, i) => (
              <SignalCard key={`${s.signal_type}-${s.coin}-${i}`} signal={s} />
            ))}
          </Column>
        </div>
      )}

      {/* Coin Metrics Table */}
      {metrics.length > 0 && (
        <div className="px-4 pb-6">
          <h2 className="text-gray-500 text-xs font-bold tracking-widest mb-2">COIN METRICS</h2>
          <div className="bg-gray-900 border border-gray-800 rounded overflow-auto">
            <table className="w-full text-xs font-mono">
              <thead>
                <tr className="text-gray-600 border-b border-gray-800">
                  <th className="text-left px-3 py-1.5">Coin</th>
                  <th className="text-left px-3 py-1.5">Side</th>
                  <th className="text-right px-3 py-1.5">Count %</th>
                  <th className="text-right px-3 py-1.5">$ %</th>
                  <th className="text-right px-3 py-1.5">Cohort</th>
                  <th className="text-right px-3 py-1.5">Traders</th>
                  <th className="text-right px-3 py-1.5">Total USD</th>
                  <th className="text-right px-3 py-1.5">Avg Lev</th>
                  <th className="text-right px-3 py-1.5">Q1 L/S</th>
                </tr>
              </thead>
              <tbody>
                {metrics.map((m) => {
                  const sideColor =
                    m.dominant_side === "LONG" ? "text-green-400" : "text-red-400";
                  return (
                    <tr
                      key={m.coin}
                      className="border-b border-gray-900 hover:bg-gray-800 cursor-pointer"
                    >
                      <td className="px-3 py-1.5">
                        <Link
                          href={`/intel/hyperliquid/coin/${m.coin}`}
                          className="text-white font-bold hover:text-blue-400"
                        >
                          {m.coin}
                        </Link>
                      </td>
                      <td className={`px-3 py-1.5 font-bold ${sideColor}`}>
                        {m.dominant_side === "LONG" ? "▲" : "▼"} {m.dominant_side}
                      </td>
                      <td className="px-3 py-1.5 text-right text-gray-300">
                        {pct(m.count_conviction)}
                      </td>
                      <td className="px-3 py-1.5 text-right text-gray-300">
                        {pct(m.dollar_conviction)}
                      </td>
                      <td className="px-3 py-1.5 text-right text-gray-400">
                        {pct(m.cohort_participation, 1)}
                      </td>
                      <td className="px-3 py-1.5 text-right text-gray-400">{m.total_count}</td>
                      <td className="px-3 py-1.5 text-right text-gray-300">
                        {fmtUsd(m.total_usd)}
                      </td>
                      <td className="px-3 py-1.5 text-right text-gray-500">
                        {m.avg_leverage.toFixed(1)}x
                      </td>
                      <td className="px-3 py-1.5 text-right text-gray-500">
                        <span className="text-green-600">{m.q1_long}</span>
                        {" / "}
                        <span className="text-red-600">{m.q1_short}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
