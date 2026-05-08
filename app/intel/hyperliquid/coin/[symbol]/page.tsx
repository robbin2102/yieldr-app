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

function SignalPillWithTooltip({ signal }: { signal: { signal_type: string; severity: string } }) {
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const meta = SIGNAL_META[signal.signal_type] ?? {
    label: signal.signal_type.slice(0, 5),
    color: "bg-gray-800 text-gray-400 border-gray-700",
    tooltip: signal.signal_type,
  };
  return (
    <>
      <span
        className={`inline-flex items-center gap-1 text-[9px] font-bold px-1.5 py-0.5 rounded border cursor-default ${meta.color}`}
        onMouseEnter={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setAnchor({ x: r.left, y: r.top });
        }}
        onMouseLeave={() => setAnchor(null)}
      >
        <span className={signal.severity === "HIGH" ? "text-red-400" : "text-yellow-500"}>●</span>
        {meta.label}
      </span>
      {anchor && (
        <span
          className="fixed w-56 bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-[10px] text-gray-300 leading-relaxed z-[9999] shadow-xl pointer-events-none whitespace-normal"
          style={{ left: anchor.x, top: anchor.y - 6, transform: "translateY(-100%)" }}
        >
          <span className={`font-bold block mb-0.5 ${meta.color.split(" ")[1]}`}>{meta.label}</span>
          {meta.tooltip}
        </span>
      )}
    </>
  );
}

export default function CoinDetailPage({
  params,
}: {
  params: Promise<{ symbol: string }>;
}) {
  const { symbol } = use(params);
  const coin = symbol.toUpperCase();
  const [sortBy, setSortBy] = useState<"size" | "recency">("size");
  const [whaleHours, setWhaleHours] = useState<6 | 12 | 24>(6);

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
    queryKey: ["hl-coin-whales", coin, whaleHours],
    queryFn: () => hlSignals.getWhaleEvents(coin, undefined, whaleHours),
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

  const whaleSummary = {
    exitUsd:  whaleEvents.filter(e => e.event_type === "EXIT").reduce((s, e) => s + e.size_usd, 0),
    entryUsd: whaleEvents.filter(e => e.event_type === "WAKEUP" || e.event_type === "SCALEUP").reduce((s, e) => s + e.size_usd, 0),
    flipCount: whaleEvents.filter(e => e.event_type === "FLIP").length,
    exitCount: whaleEvents.filter(e => e.event_type === "EXIT").length,
    entryCount: whaleEvents.filter(e => e.event_type === "WAKEUP" || e.event_type === "SCALEUP").length,
  };

  const cm = metricsData;

  const hasRecencyData = rawHolders.some((h: any) => h.opened_at != null);
  const holders = [...rawHolders].sort((a, b) => {
    if (sortBy === "recency") {
      return (b.opened_at ? new Date(b.opened_at).getTime() : 0) -
             (a.opened_at ? new Date(a.opened_at).getTime() : 0);
    }
    return (b.size_usd ?? 0) - (a.size_usd ?? 0);
  });

  // Entry price stats per side
  const entryStats = (() => {
    const sides = ["LONG", "SHORT"] as const;
    const result: Record<string, { mean: number; wtMean: number; median: number; count: number } | null> = {};
    for (const side of sides) {
      const ps = rawHolders.filter((h: any) => h.side === side && h.entry_px > 0);
      if (ps.length === 0) { result[side] = null; continue; }
      const prices = ps.map((h: any) => Number(h.entry_px));
      const sizes  = ps.map((h: any) => Number(h.size_usd));
      const mean   = prices.reduce((a, b) => a + b, 0) / prices.length;
      const totalSz = sizes.reduce((a, b) => a + b, 0);
      const wtMean = prices.reduce((a, p, i) => a + p * sizes[i], 0) / totalSz;
      const sorted = [...prices].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
      result[side] = { mean, wtMean, median, count: ps.length };
    }
    return result;
  })();

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
              {/* Whale events — tabbed by time window, scrollable */}
              <div className="bg-gray-900 border border-gray-800 rounded p-3 flex flex-col gap-2">
                {/* Header: title + time tabs + count */}
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-gray-500 font-bold text-[10px]">WHALE MOVES</span>
                  <div className="flex gap-0.5">
                    {([6, 12, 24] as const).map(h => (
                      <button
                        key={h}
                        onClick={() => setWhaleHours(h)}
                        className={`text-[9px] px-1.5 py-0.5 rounded ${
                          whaleHours === h ? "bg-gray-700 text-white" : "text-gray-600 hover:text-gray-400"
                        }`}
                      >
                        {h}H
                      </button>
                    ))}
                  </div>
                  <span className="text-gray-700 text-[10px] ml-auto">· {whaleEvents.length}</span>
                </div>

                {/* Summary metrics */}
                {whaleEvents.length > 0 && (
                  <div className="flex gap-3 text-[10px] shrink-0 border-t border-gray-800 pt-1.5">
                    <div>
                      <span className="text-red-400 font-bold">{fmtUsd(whaleSummary.exitUsd)}</span>
                      <span className="text-gray-600 ml-1">exit ({whaleSummary.exitCount})</span>
                    </div>
                    <div>
                      <span className="text-green-400 font-bold">{fmtUsd(whaleSummary.entryUsd)}</span>
                      <span className="text-gray-600 ml-1">entry/up ({whaleSummary.entryCount})</span>
                    </div>
                    {whaleSummary.flipCount > 0 && (
                      <div>
                        <span className="text-yellow-400 font-bold">{whaleSummary.flipCount}</span>
                        <span className="text-gray-600 ml-1">flip</span>
                      </div>
                    )}
                  </div>
                )}

                {/* Event list */}
                {whaleEvents.length === 0 ? (
                  <p className="text-gray-700 text-[10px]">None in last {whaleHours}h</p>
                ) : (
                  <div className="space-y-1 overflow-y-auto max-h-40 pr-1">
                    {whaleEvents.map((e, i) => (
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
              {/* Active signal pills with fixed-position tooltips */}
              {signals.map((s, i) => (
                <SignalPillWithTooltip key={i} signal={s} />
              ))}
              <div className="ml-auto flex items-center gap-2">
                {sortBy === "recency" && !hasRecencyData && (
                  <span className="text-gray-700 text-[9px]">no open dates yet</span>
                )}
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

            {/* Entry price summary */}
            {(entryStats["LONG"] || entryStats["SHORT"]) && (
              <div className="flex flex-wrap gap-3 mb-2 text-[10px] font-mono">
                {(["LONG", "SHORT"] as const).map((side) => {
                  const s = entryStats[side];
                  if (!s) return null;
                  const col = side === "LONG" ? "text-green-400" : "text-red-400";
                  return (
                    <div key={side} className="flex items-center gap-3 bg-gray-900 border border-gray-800 rounded px-3 py-1.5">
                      <span className={`font-bold ${col}`}>{side === "LONG" ? "▲" : "▼"} {side}</span>
                      <span className="text-gray-600">mean</span>
                      <span className="text-gray-300">${s.mean.toFixed(1)}</span>
                      <span className="text-gray-600">wt.mean</span>
                      <span className="text-white font-bold">${s.wtMean.toFixed(1)}</span>
                      <span className="text-gray-600">median</span>
                      <span className="text-gray-300">${s.median.toFixed(1)}</span>
                      <span className="text-gray-700">({s.count})</span>
                    </div>
                  );
                })}
              </div>
            )}

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
