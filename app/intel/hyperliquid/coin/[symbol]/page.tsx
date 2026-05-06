"use client";

import { use, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { hlSignals } from "@/lib/hyperliquid-signals";

function fmtUsd(n: number | null | undefined) {
  if (n == null) return "—";
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function pct(n: number | null | undefined, d = 1) {
  if (n == null) return "—";
  return `${(n * 100).toFixed(d)}%`;
}

function fmtAge(ts: string | null | undefined) {
  if (!ts) return null;
  const d = new Date(ts + (ts.endsWith("Z") ? "" : "Z"));
  const diffH = (Date.now() - d.getTime()) / 3_600_000;
  if (diffH < 1) return `${Math.round(diffH * 60)}m ago`;
  if (diffH < 24) return `${Math.round(diffH)}h ago`;
  return `${Math.round(diffH / 24)}d ago`;
}

function fmtTs(ts: string) {
  const d = new Date(ts + (ts.endsWith("Z") ? "" : "Z"));
  return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
}

const Q_COLOR: Record<number, string> = {
  1: "bg-yellow-500 text-black",
  2: "bg-blue-700 text-white",
  3: "bg-gray-700 text-gray-300",
  4: "bg-gray-800 text-gray-500",
};

function QBadge({ q }: { q?: number | null }) {
  if (!q) return null;
  return (
    <span className={`text-[9px] font-bold px-1 rounded ${Q_COLOR[q] ?? ""}`}>Q{q}</span>
  );
}

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

const EVENT_COLOR: Record<string, string> = {
  WAKEUP: "text-purple-400",
  SCALEUP: "text-green-400",
  FLIP: "text-yellow-400",
  EXIT: "text-red-400",
  LEVERAGE_PUSH: "text-orange-400",
};

export default function CoinDetailPage({
  params,
}: {
  params: Promise<{ symbol: string }>;
}) {
  const { symbol } = use(params);
  const coin = symbol.toUpperCase();
  const [sortBy, setSortBy] = useState<"size" | "recency">("size");

  const { data: coinData, isLoading } = useQuery({
    queryKey: ["hl-coin", coin],
    queryFn: () => hlSignals.getCoin(coin, 7),
    refetchInterval: 30_000,
  });

  const { data: signalsData } = useQuery({
    queryKey: ["hl-coin-signals", coin],
    queryFn: () => hlSignals.getSignalsV2(undefined, 72),
    refetchInterval: 30_000,
    select: (d) => ({ ...d, data: d.data.filter((s) => s.coin === coin) }),
  });

  const { data: whaleData } = useQuery({
    queryKey: ["hl-coin-whales", coin],
    queryFn: () => hlSignals.getWhaleEvents(coin, undefined, 72),
    refetchInterval: 30_000,
  });

  const { data: metricsData } = useQuery({
    queryKey: ["hl-coin-metrics-all"],
    queryFn: () => hlSignals.getCoinMetrics(200),
    select: (d) => d.data.find((m) => m.coin === coin),
  });

  const rawHolders = (coinData?.holders ?? []) as any[];
  const signals = (signalsData?.data ?? []).sort((a, b) => {
    const o: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
    return (o[a.severity] ?? 9) - (o[b.severity] ?? 9);
  });
  const whaleEvents = [...(whaleData?.data ?? [])].sort(
    (a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime()
  );
  const cm = metricsData;

  const holders = [...rawHolders].sort((a, b) => {
    if (sortBy === "recency") {
      return (b.opened_at ? new Date(b.opened_at).getTime() : 0) -
             (a.opened_at ? new Date(a.opened_at).getTime() : 0);
    }
    return (b.size_usd ?? 0) - (a.size_usd ?? 0);
  });

  const dominant_side = cm?.dominant_side ?? "LONG";
  const sideColor = dominant_side === "LONG" ? "text-green-400" : "text-red-400";

  return (
    <div className="min-h-screen bg-gray-950 text-gray-200 font-mono text-sm">
      {/* Header */}
      <div className="border-b border-gray-800 px-4 py-3 flex items-center gap-4">
        <Link href="/intel/hyperliquid" className="text-gray-600 hover:text-gray-400 text-xs">← Back</Link>
        <h1 className="text-white font-bold text-lg">{coin}</h1>
        {cm && (
          <span className={`font-bold ${sideColor}`}>
            {dominant_side === "LONG" ? "▲" : "▼"} {dominant_side}
          </span>
        )}
      </div>

      {isLoading ? (
        <div className="p-8 text-center text-gray-600">Loading…</div>
      ) : (
        <div className="p-4 space-y-4">

          {/* Metrics summary */}
          {cm && (
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
              {[
                { label: "Count bias", value: pct(cm.count_conviction) },
                { label: "$ bias",     value: pct(cm.dollar_conviction) },
                { label: "Cohort",     value: pct(cm.cohort_participation, 1) },
                { label: "Total USD",  value: fmtUsd(cm.total_usd) },
                { label: "Traders",    value: String(cm.total_count) },
                { label: "Avg Lev",    value: `${cm.avg_leverage.toFixed(1)}x` },
              ].map(({ label, value }) => (
                <div key={label} className="bg-gray-900 border border-gray-800 rounded p-2">
                  <div className="text-gray-600 text-[10px]">{label}</div>
                  <div className="text-white font-bold text-sm mt-0.5">{value}</div>
                </div>
              ))}
            </div>
          )}

          {/* Long vs Short */}
          {cm && (
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="bg-gray-900 border border-gray-800 rounded p-3">
                <div className="text-gray-500 mb-2 font-bold text-[10px]">LONG vs SHORT</div>
                <div className="flex gap-6">
                  <div>
                    <div className="text-gray-600 text-[10px]">Long</div>
                    <div className="text-green-400 font-bold">{fmtUsd(cm.long_usd)}</div>
                    <div className="text-gray-500">{cm.long_count} traders · Q1: {cm.q1_long}</div>
                  </div>
                  <div>
                    <div className="text-gray-600 text-[10px]">Short</div>
                    <div className="text-red-400 font-bold">{fmtUsd(cm.short_usd)}</div>
                    <div className="text-gray-500">{cm.short_count} traders · Q1: {cm.q1_short}</div>
                  </div>
                </div>
              </div>
              {/* Whale events compact */}
              <div className="bg-gray-900 border border-gray-800 rounded p-3 overflow-hidden">
                <div className="text-gray-500 mb-2 font-bold text-[10px]">WHALE MOVES (72H)</div>
                {whaleEvents.length === 0 ? (
                  <p className="text-gray-700 text-[10px]">None</p>
                ) : (
                  <div className="space-y-1">
                    {whaleEvents.slice(0, 4).map((e, i) => (
                      <div key={i} className="flex items-center gap-2 text-[10px]">
                        <span className={`font-bold w-16 shrink-0 ${EVENT_COLOR[e.event_type] ?? "text-gray-400"}`}>
                          {e.event_type}
                        </span>
                        <span className={e.side === "LONG" ? "text-green-400" : "text-red-400"}>
                          {e.side === "LONG" ? "▲" : "▼"}
                        </span>
                        <span className="text-gray-300">{fmtUsd(e.size_usd)}</span>
                        <Link
                          href={`/intel/hyperliquid/trader/${e.address}`}
                          className="text-blue-400 hover:text-blue-300 truncate"
                          onClick={(ev) => ev.stopPropagation()}
                        >
                          {e.address.slice(0, 8)}…
                        </Link>
                        <span className="text-gray-700 ml-auto shrink-0">{fmtAge(e.ts)}</span>
                      </div>
                    ))}
                    {whaleEvents.length > 4 && (
                      <div className="text-gray-700 text-[10px]">+{whaleEvents.length - 4} more</div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Holders table with signals inline */}
          <section>
            {/* Section header: title + signal pills + sort toggle */}
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              <h2 className="text-gray-500 text-xs font-bold tracking-widest shrink-0">
                POSITIONS ({holders.length})
              </h2>
              {/* Active signal pills with tooltips */}
              {signals.map((s, i) => {
                const meta = SIGNAL_META[s.signal_type] ?? { label: s.signal_type.slice(0, 5), color: "bg-gray-800 text-gray-400 border-gray-700", tooltip: s.signal_type };
                return (
                  <span key={i} className="relative group inline-flex">
                    <span className={`inline-flex items-center gap-1 text-[9px] font-bold px-1.5 py-0.5 rounded border cursor-default ${meta.color}`}>
                      <span className={s.severity === "HIGH" ? "text-red-400" : "text-yellow-500"}>●</span>
                      {meta.label}
                    </span>
                    <span className="pointer-events-none absolute bottom-full left-0 mb-1.5 w-56 bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-[10px] text-gray-300 leading-relaxed invisible group-hover:visible z-50 shadow-xl whitespace-normal">
                      <span className={`font-bold block mb-0.5 ${meta.color.split(" ")[1]}`}>{meta.label}</span>
                      {meta.tooltip}
                    </span>
                  </span>
                );
              })}
              <div className="ml-auto flex gap-1">
                {(["size", "recency"] as const).map((s) => (
                  <button
                    key={s}
                    onClick={() => setSortBy(s)}
                    className={`text-[10px] px-2 py-0.5 rounded ${
                      sortBy === s ? "bg-gray-700 text-white" : "text-gray-600 hover:text-gray-400"
                    }`}
                  >
                    {s === "size" ? "By Size" : "By Recency"}
                  </button>
                ))}
              </div>
            </div>

            <div className="bg-gray-900 border border-gray-800 rounded overflow-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-gray-600 border-b border-gray-800 text-[10px]">
                    <th className="text-left px-3 py-1.5">#</th>
                    <th className="text-left px-3 py-1.5">Address</th>
                    <th className="text-left px-3 py-1.5">Q</th>
                    <th className="text-left px-3 py-1.5">Side</th>
                    <th className="text-right px-3 py-1.5">Size</th>
                    <th className="text-right px-3 py-1.5">Entry</th>
                    <th className="text-right px-3 py-1.5">Lev</th>
                    <th className="text-right px-3 py-1.5">uPnL</th>
                    <th className="text-right px-3 py-1.5">Opened</th>
                  </tr>
                </thead>
                <tbody>
                  {holders.map((h: any, i: number) => {
                    const isLong = h.side === "LONG";
                    const age = fmtAge(h.opened_at);
                    return (
                      <tr key={h.address + i} className="border-b border-gray-900 hover:bg-gray-800">
                        <td className="px-3 py-1 text-gray-600">{i + 1}</td>
                        <td className="px-3 py-1">
                          <Link
                            href={`/intel/hyperliquid/trader/${h.address}`}
                            className="text-blue-400 hover:text-blue-300"
                          >
                            {h.address.slice(0, 12)}…
                          </Link>
                        </td>
                        <td className="px-3 py-1"><QBadge q={h.skill_quartile} /></td>
                        <td className={`px-3 py-1 font-bold ${isLong ? "text-green-400" : "text-red-400"}`}>
                          {isLong ? "▲" : "▼"} {h.side}
                        </td>
                        <td className="px-3 py-1 text-right text-gray-300">{fmtUsd(h.size_usd)}</td>
                        <td className="px-3 py-1 text-right text-gray-500">
                          ${Number(h.entry_px || 0).toFixed(3)}
                        </td>
                        <td className="px-3 py-1 text-right text-gray-500">
                          {Number(h.leverage || 0).toFixed(1)}x
                        </td>
                        <td className={`px-3 py-1 text-right ${(h.unrealized_pnl ?? 0) >= 0 ? "text-green-400" : "text-red-400"}`}>
                          {fmtUsd(Math.abs(h.unrealized_pnl ?? 0))}
                        </td>
                        <td className="px-3 py-1 text-right text-gray-600">
                          {age ? <span title={h.opened_at}>{age}</span> : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

        </div>
      )}
    </div>
  );
}
