"use client";

import { useState, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { hlSignals, type ConvergenceSignal, type Alert } from "@/lib/hyperliquid-signals";
import { SignalCard } from "@/components/hyperliquid/SignalCard";
import { TraderRow } from "@/components/hyperliquid/TraderRow";
import { TraderModal } from "@/components/hyperliquid/TraderModal";
import { PositionChange } from "@/components/hyperliquid/PositionChange";
import { Heatmap } from "@/components/hyperliquid/Heatmap";
import { FilterPanel } from "@/components/hyperliquid/FilterPanel";

const REFETCH_MS = 30_000;

function fmtUsd(n: number) {
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function fmtTs(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
}

// Build a map of coin → dominant side (higher total_usd wins)
function buildDominanceMap(signals: ConvergenceSignal[]): Record<string, "LONG" | "SHORT"> {
  const map: Record<string, { long: number; short: number }> = {};
  for (const s of signals) {
    if (!map[s.coin]) map[s.coin] = { long: 0, short: 0 };
    if (s.side === "LONG") map[s.coin].long += s.total_usd;
    else map[s.coin].short += s.total_usd;
  }
  const result: Record<string, "LONG" | "SHORT"> = {};
  for (const [coin, { long, short }] of Object.entries(map)) {
    result[coin] = long >= short ? "LONG" : "SHORT";
  }
  return result;
}

function signalTier(
  s: ConvergenceSignal,
  isDominant: boolean
): 1 | 2 | 3 | undefined {
  const { conviction, n_traders, total_usd } = s;
  if (isDominant && conviction >= 0.9 && n_traders >= 5 && total_usd >= 1_000_000) return 1;
  if (isDominant && conviction >= 0.7 && n_traders >= 10) return 2;
  if (n_traders >= 5) return 3;
  return undefined;
}

export default function HyperliquidDashboard() {
  const qc = useQueryClient();
  const [cohortOpen, setCohortOpen] = useState(false);
  const [changeTypeFilter, setChangeTypeFilter] = useState<string>("ALL");
  const [selectedTrader, setSelectedTrader] = useState<string | null>(null);

  const { data: convergenceData } = useQuery({
    queryKey: ["hl-convergence"],
    queryFn: () => hlSignals.getConvergence(50),
    refetchInterval: REFETCH_MS,
  });

  const { data: alertsData } = useQuery({
    queryKey: ["hl-alerts"],
    queryFn: () => hlSignals.getAlerts(undefined, false),
    refetchInterval: REFETCH_MS,
  });

  const { data: changesData } = useQuery({
    queryKey: ["hl-changes", changeTypeFilter],
    queryFn: () =>
      hlSignals.getPositionChanges(
        undefined,
        10_000,
        changeTypeFilter === "ALL" ? undefined : changeTypeFilter
      ),
    refetchInterval: REFETCH_MS,
  });

  const { data: cohortData } = useQuery({
    queryKey: ["hl-cohort"],
    queryFn: () => hlSignals.getCohort(1, 100),
    refetchInterval: REFETCH_MS,
  });

  const { data: cohortChangesData } = useQuery({
    queryKey: ["hl-cohort-changes"],
    queryFn: () => hlSignals.getCohortChanges(1),
    refetchInterval: REFETCH_MS,
  });

  const { data: heatmapData } = useQuery({
    queryKey: ["hl-heatmap"],
    queryFn: () => hlSignals.getHeatmap(20, 7),
    refetchInterval: REFETCH_MS * 6,
  });

  const { data: configData } = useQuery({
    queryKey: ["hl-config"],
    queryFn: () => hlSignals.getConfig(),
  });

  const acknowledgeAlert = useCallback(
    async (id: string) => {
      await hlSignals.acknowledgeAlert(id);
      qc.invalidateQueries({ queryKey: ["hl-alerts"] });
    },
    [qc]
  );

  const signals = convergenceData?.data ?? [];
  const snapshotTs = convergenceData?.snapshot_ts ?? null;
  const alerts: Alert[] = alertsData?.data ?? [];
  const tier1Alerts = alerts.filter((a) => a.severity === 1).slice(0, 3);
  const changes = changesData?.data ?? [];
  const traders = cohortData?.data ?? [];
  const totalTraders = cohortData?.total ?? 0;
  const todayChanges = cohortChangesData?.data ?? [];
  const newToday = todayChanges.filter((c) => c.change_type === "NEW_ENTRANT").length;
  const droppedToday = todayChanges.filter((c) => c.change_type === "DROPPED").length;

  const totalPortfolioUsd = signals.reduce((acc, s) => acc + s.total_usd, 0);
  const dominanceMap = buildDominanceMap(signals);

  // Sort: T1 dominant first, then T2, then T3, then by USD
  const sortedSignals = [...signals].sort((a, b) => {
    const domA = dominanceMap[a.coin] === a.side;
    const domB = dominanceMap[b.coin] === b.side;
    const ta = signalTier(a, domA) ?? 99;
    const tb = signalTier(b, domB) ?? 99;
    if (ta !== tb) return ta - tb;
    return b.total_usd - a.total_usd;
  });

  const sparkMap: Record<string, number[]> = {};
  signals.forEach((s) => {
    const k = `${s.coin}_${s.side}`;
    if (!sparkMap[k]) sparkMap[k] = [];
    sparkMap[k].push(s.conviction);
  });

  const filterSettings = (configData?.data as any)?.filter_settings ?? {
    min_av: 50000,
    max_av: 50000000,
    min_month_vlm: 1000000,
    min_pnl_av_ratio: 0.1,
    min_month_eff: 0.005,
    min_roi_ratio: 0.3,
    filter_roi_cap_enabled: false,
    filter_efficiency_enabled: true,
    filter_roi_ratio_enabled: true,
    max_month_roi: 5.0,
    max_all_roi: 50.0,
  };

  const CHANGE_TYPES = ["ALL", "NEW_POSITION", "FLIP", "SIZE_CHANGE", "CLOSED", "LEVERAGE_CHANGE"];

  return (
    <div className="min-h-screen bg-gray-950 text-gray-200 font-mono text-sm">
      {/* Header */}
      <div className="border-b border-gray-800 px-4 py-3 flex flex-wrap items-center gap-6">
        <h1 className="text-white font-bold text-base tracking-wider">
          HL SIGNALS <span className="text-green-500">▶</span>
        </h1>
        <div className="flex gap-6 text-xs text-gray-400">
          <span>COHORT <span className="text-white font-bold">{totalTraders}</span></span>
          <span>PORTFOLIO <span className="text-green-400 font-bold">{fmtUsd(totalPortfolioUsd)}</span></span>
          <span>SNAPSHOT <span className="text-gray-300">{fmtTs(snapshotTs)}</span></span>
          <span>
            NEW <span className="text-green-400 font-bold">+{newToday}</span> / DROP{" "}
            <span className="text-red-400 font-bold">-{droppedToday}</span>
          </span>
        </div>
        <div className="ml-auto text-xs text-gray-600">auto-refresh 30s</div>
      </div>

      {/* Tier 1 Alert Banner */}
      {tier1Alerts.length > 0 && (
        <div className="bg-yellow-950 border-b border-yellow-800 px-4 py-2 flex flex-wrap gap-3">
          <span className="text-yellow-500 font-bold text-xs shrink-0">⚠ TIER 1</span>
          {tier1Alerts.map((alert) => (
            <div
              key={alert.created_at}
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
                className="text-gray-500 hover:text-gray-300 text-xs"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="p-4 space-y-6">
        {/* Convergence Signal Board */}
        <section>
          <h2 className="text-gray-500 text-xs font-bold mb-3 tracking-widest">
            CONVERGENCE SIGNALS
          </h2>
          {sortedSignals.length === 0 ? (
            <p className="text-gray-600 text-xs">No signals yet — waiting for first snapshot.</p>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-2">
              {sortedSignals.map((s) => {
                const isDominant = dominanceMap[s.coin] === s.side;
                const tier = signalTier(s, isDominant);
                return (
                  <SignalCard
                    key={`${s.coin}-${s.side}`}
                    signal={s}
                    sparkData={sparkMap[`${s.coin}_${s.side}`]}
                    tier={tier}
                    isDominant={isDominant}
                  />
                );
              })}
            </div>
          )}
        </section>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Position Changes Feed */}
          <section className="lg:col-span-2">
            <div className="flex items-center gap-3 mb-3">
              <h2 className="text-gray-500 text-xs font-bold tracking-widest">POSITION CHANGES</h2>
              <div className="flex gap-1 flex-wrap">
                {CHANGE_TYPES.map((t) => (
                  <button
                    key={t}
                    onClick={() => setChangeTypeFilter(t)}
                    className={`text-xs px-2 py-0.5 rounded ${changeTypeFilter === t ? "bg-gray-700 text-white" : "bg-gray-900 text-gray-500 hover:text-gray-300"}`}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
            <div className="bg-gray-900 rounded border border-gray-800 p-2 max-h-96 overflow-y-auto">
              {changes.length === 0 ? (
                <p className="text-gray-600 text-xs p-2">No changes yet.</p>
              ) : (
                changes.map((c, i) => <PositionChange key={i} change={c} />)
              )}
            </div>
          </section>

          {/* Cohort Panel */}
          <section>
            <h2 className="text-gray-500 text-xs font-bold mb-3 tracking-widest">
              COHORT COMPOSITION
            </h2>
            <div className="bg-gray-900 rounded border border-gray-800 p-3 space-y-2">
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="bg-gray-800 rounded p-2">
                  <div className="text-gray-500">Active Traders</div>
                  <div className="text-white text-xl font-bold">{totalTraders}</div>
                </div>
                <div className="bg-gray-800 rounded p-2">
                  <div className="text-gray-500">Today</div>
                  <div className="text-xs mt-1">
                    <span className="text-green-400">+{newToday}</span>{" "}
                    <span className="text-red-400">-{droppedToday}</span>
                  </div>
                </div>
              </div>
              <button
                onClick={() => setCohortOpen((o) => !o)}
                className="w-full text-left text-xs text-blue-400 hover:text-blue-300 py-1"
              >
                {cohortOpen ? "▲ Hide cohort" : "▼ View full cohort →"}
              </button>
              {cohortOpen && (
                <div className="max-h-64 overflow-y-auto">
                  <div className="grid grid-cols-6 gap-2 text-xs text-gray-500 mb-1 font-bold">
                    <span>#</span>
                    <span className="col-span-2">Name</span>
                    <span>AV</span>
                    <span>MoROI</span>
                    <span>Ratio</span>
                  </div>
                  {traders.map((t, i) => (
                    <div
                      key={t.address}
                      onClick={() => setSelectedTrader(t.address)}
                      className="cursor-pointer hover:bg-gray-800 rounded"
                    >
                      <TraderRow trader={t} rank={i + 1} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>

        {/* Convergence Heatmap */}
        <section>
          <h2 className="text-gray-500 text-xs font-bold mb-3 tracking-widest">
            CONVERGENCE HEATMAP — 7 DAYS
          </h2>
          <div className="bg-gray-900 rounded border border-gray-800 p-3">
            {heatmapData ? (
              <Heatmap
                coins={heatmapData.coins}
                snapshots={heatmapData.snapshots}
                matrix={heatmapData.matrix as any}
              />
            ) : (
              <p className="text-gray-600 text-xs">Loading heatmap…</p>
            )}
          </div>
        </section>
      </div>

      {/* Filter Settings Panel */}
      <FilterPanel initialConfig={filterSettings} />

      {/* Trader Profile Modal */}
      {selectedTrader && (
        <TraderModal
          address={selectedTrader}
          onClose={() => setSelectedTrader(null)}
        />
      )}
    </div>
  );
}
