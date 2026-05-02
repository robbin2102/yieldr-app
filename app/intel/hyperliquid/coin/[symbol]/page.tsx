"use client";

import { use } from "react";
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

function fmtTs(ts: string) {
  return new Date(ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
}

export default function CoinDetailPage({
  params,
}: {
  params: Promise<{ symbol: string }>;
}) {
  const { symbol } = use(params);
  const coin = symbol.toUpperCase();

  const { data: coinData, isLoading: coinLoading } = useQuery({
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

  const holders = (coinData?.holders ?? []) as any[];
  const convHistory = coinData?.conviction_history ?? [];
  const signals = signalsData?.data ?? [];
  const whaleEvents = whaleData?.data ?? [];
  const cm = metricsData;

  const dominant_side = cm?.dominant_side ?? "LONG";
  const sideColor = dominant_side === "LONG" ? "text-green-400" : "text-red-400";

  return (
    <div className="min-h-screen bg-gray-950 text-gray-200 font-mono text-sm">
      {/* Header */}
      <div className="border-b border-gray-800 px-4 py-3 flex items-center gap-4">
        <Link href="/intel/hyperliquid" className="text-gray-600 hover:text-gray-400 text-xs">
          ← Back
        </Link>
        <h1 className="text-white font-bold text-lg">{coin}</h1>
        {cm && (
          <span className={`font-bold ${sideColor}`}>
            {dominant_side === "LONG" ? "▲" : "▼"} {dominant_side}
          </span>
        )}
      </div>

      {coinLoading ? (
        <div className="p-8 text-center text-gray-600">Loading…</div>
      ) : (
        <div className="p-4 space-y-6">
          {/* Metrics summary */}
          {cm && (
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
              {[
                { label: "Count bias", value: pct(cm.count_conviction) },
                { label: "$ bias", value: pct(cm.dollar_conviction) },
                { label: "Cohort", value: pct(cm.cohort_participation, 1) },
                { label: "Total USD", value: fmtUsd(cm.total_usd) },
                { label: "Traders", value: String(cm.total_count) },
                { label: "Avg Lev", value: `${cm.avg_leverage.toFixed(1)}x` },
              ].map(({ label, value }) => (
                <div key={label} className="bg-gray-900 border border-gray-800 rounded p-2">
                  <div className="text-gray-600 text-[10px]">{label}</div>
                  <div className="text-white font-bold text-sm mt-0.5">{value}</div>
                </div>
              ))}
            </div>
          )}

          {cm && (
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="bg-gray-900 border border-gray-800 rounded p-3">
                <div className="text-gray-500 mb-2 font-bold">LONG vs SHORT</div>
                <div className="flex gap-4">
                  <div>
                    <div className="text-gray-500 text-[10px]">Long</div>
                    <div className="text-green-400 font-bold">{fmtUsd(cm.long_usd)}</div>
                    <div className="text-gray-500">{cm.long_count} traders</div>
                    <div className="text-gray-600 text-[10px]">Q1: {cm.q1_long}</div>
                  </div>
                  <div>
                    <div className="text-gray-500 text-[10px]">Short</div>
                    <div className="text-red-400 font-bold">{fmtUsd(cm.short_usd)}</div>
                    <div className="text-gray-500">{cm.short_count} traders</div>
                    <div className="text-gray-600 text-[10px]">Q1: {cm.q1_short}</div>
                  </div>
                </div>
              </div>
              <div className="bg-gray-900 border border-gray-800 rounded p-3">
                <div className="text-gray-500 mb-2 font-bold text-[10px]">ACTIVE SIGNALS</div>
                {signals.length === 0 ? (
                  <p className="text-gray-700 text-[10px]">No active signals</p>
                ) : (
                  <div className="space-y-1">
                    {signals.map((s, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <span
                          className={`text-[10px] font-bold ${
                            s.severity === "HIGH"
                              ? "text-red-400"
                              : s.severity === "MEDIUM"
                              ? "text-yellow-400"
                              : "text-blue-400"
                          }`}
                        >
                          {s.severity}
                        </span>
                        <span className="text-gray-300 text-[10px]">
                          {s.signal_type.replace(/_/g, " ")}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Top holders */}
          <section>
            <h2 className="text-gray-500 text-xs font-bold tracking-widest mb-2">
              CURRENT HOLDERS ({holders.length})
            </h2>
            <div className="bg-gray-900 border border-gray-800 rounded overflow-hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-gray-600 border-b border-gray-800">
                    <th className="text-left px-3 py-1.5">#</th>
                    <th className="text-left px-3 py-1.5">Address</th>
                    <th className="text-left px-3 py-1.5">Side</th>
                    <th className="text-right px-3 py-1.5">Size</th>
                    <th className="text-right px-3 py-1.5">Entry</th>
                    <th className="text-right px-3 py-1.5">Lev</th>
                    <th className="text-right px-3 py-1.5">uPnL</th>
                  </tr>
                </thead>
                <tbody>
                  {holders.map((h: any, i: number) => {
                    const isLong = h.side === "LONG";
                    return (
                      <tr
                        key={h.address + i}
                        className="border-b border-gray-900 hover:bg-gray-800"
                      >
                        <td className="px-3 py-1 text-gray-600">{i + 1}</td>
                        <td className="px-3 py-1">
                          <Link
                            href={`/intel/hyperliquid/trader/${h.address}`}
                            className="text-blue-400 hover:text-blue-300"
                          >
                            {h.address.slice(0, 12)}…
                          </Link>
                        </td>
                        <td
                          className={`px-3 py-1 font-bold ${
                            isLong ? "text-green-400" : "text-red-400"
                          }`}
                        >
                          {h.side}
                        </td>
                        <td className="px-3 py-1 text-right text-gray-300">
                          {fmtUsd(h.size_usd)}
                        </td>
                        <td className="px-3 py-1 text-right text-gray-500">
                          ${Number(h.entry_px || 0).toFixed(2)}
                        </td>
                        <td className="px-3 py-1 text-right text-gray-500">
                          {Number(h.leverage || 0).toFixed(1)}x
                        </td>
                        <td
                          className={`px-3 py-1 text-right ${
                            (h.unrealized_pnl ?? 0) >= 0 ? "text-green-400" : "text-red-400"
                          }`}
                        >
                          {fmtUsd(Math.abs(h.unrealized_pnl ?? 0))}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          {/* Whale events */}
          {whaleEvents.length > 0 && (
            <section>
              <h2 className="text-gray-500 text-xs font-bold tracking-widest mb-2">
                WHALE EVENTS (72H)
              </h2>
              <div className="space-y-1.5">
                {whaleEvents.map((e, i) => {
                  const evColor: Record<string, string> = {
                    WAKEUP: "text-purple-400",
                    SCALEUP: "text-green-400",
                    FLIP: "text-yellow-400",
                    EXIT: "text-red-400",
                    LEVERAGE_PUSH: "text-orange-400",
                  };
                  return (
                    <div
                      key={i}
                      className="flex items-center gap-3 bg-gray-900 border border-gray-800 rounded px-3 py-2 text-xs"
                    >
                      <span className={`font-bold w-24 shrink-0 ${evColor[e.event_type] ?? "text-gray-400"}`}>
                        {e.event_type}
                      </span>
                      <Link
                        href={`/intel/hyperliquid/trader/${e.address}`}
                        className="text-blue-400 hover:text-blue-300 w-28 shrink-0"
                      >
                        {e.address.slice(0, 10)}…
                      </Link>
                      <span
                        className={
                          e.side === "LONG" ? "text-green-400" : "text-red-400"
                        }
                      >
                        {e.side}
                      </span>
                      <span className="text-gray-300">{fmtUsd(e.size_usd)}</span>
                      <span className="text-gray-600 ml-auto">{fmtTs(e.ts)}</span>
                    </div>
                  );
                })}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
