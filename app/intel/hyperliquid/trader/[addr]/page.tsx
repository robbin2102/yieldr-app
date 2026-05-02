"use client";

import { use } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { hlSignals, type Trader } from "@/lib/hyperliquid-signals";

function fmtUsd(n: number | null | undefined) {
  if (n == null) return "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded p-2">
      <div className="text-gray-500 text-[10px]">{label}</div>
      <div className={`font-mono font-bold text-sm mt-0.5 ${color ?? "text-white"}`}>{value}</div>
    </div>
  );
}

const Q_COLOR: Record<number, string> = {
  1: "bg-yellow-600 text-black",
  2: "bg-blue-700 text-white",
  3: "bg-gray-700 text-gray-200",
  4: "bg-gray-900 text-gray-500",
};

export default function TraderDetailPage({
  params,
}: {
  params: Promise<{ addr: string }>;
}) {
  const { addr } = use(params);

  const { data, isLoading } = useQuery({
    queryKey: ["hl-trader", addr],
    queryFn: () => hlSignals.getTrader(addr),
    refetchInterval: 30_000,
  });

  const { data: whaleData } = useQuery({
    queryKey: ["hl-trader-whales", addr],
    queryFn: () => hlSignals.getWhaleEvents(undefined, undefined, 168),
    select: (d) => d.data.filter((e) => e.address === addr),
  });

  const profile = data?.profile as Trader | undefined;
  const positions = (data?.positions ?? []) as any[];
  const changes = (data?.recent_changes ?? []) as any[];
  const whaleEvents = whaleData ?? [];

  const q = profile?.skill_quartile ?? 4;
  const name = profile?.display_name || addr.slice(0, 16) + "…";

  return (
    <div className="min-h-screen bg-gray-950 text-gray-200 font-mono text-sm">
      <div className="border-b border-gray-800 px-4 py-3 flex items-center gap-4">
        <Link href="/intel/hyperliquid/cohort" className="text-gray-600 hover:text-gray-400 text-xs">
          ← Cohort
        </Link>
        {profile && (
          <>
            <h1 className="text-white font-bold">{name}</h1>
            <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${Q_COLOR[q]}`}>Q{q}</span>
            {profile.skill_score != null && (
              <span className="text-gray-600 text-xs">
                skill {profile.skill_score.toFixed(3)}
              </span>
            )}
          </>
        )}
      </div>

      {isLoading ? (
        <div className="p-8 text-center text-gray-600">Loading…</div>
      ) : !profile ? (
        <div className="p-8 text-center text-gray-600">Trader not found</div>
      ) : (
        <div className="p-4 space-y-6">
          {/* Address */}
          <div className="text-gray-600 text-xs">{addr}</div>

          {/* Stats */}
          <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
            <Stat label="Account Value" value={fmtUsd(profile.account_value)} />
            <Stat
              label="Month ROI"
              value={`${(profile.month_roi * 100).toFixed(1)}%`}
              color="text-green-400"
            />
            <Stat
              label="AllTime ROI"
              value={`${(profile.all_roi * 100).toFixed(1)}%`}
              color="text-green-400"
            />
            <Stat label="Month PnL" value={fmtUsd(profile.month_pnl)} />
            <Stat label="AllTime PnL" value={fmtUsd(profile.all_pnl)} />
            <Stat label="ROI Ratio" value={`${profile.roi_ratio.toFixed(2)}x`} />
            <Stat label="Month Volume" value={fmtUsd(profile.month_vlm)} />
            <Stat
              label="Month Efficiency"
              value={`${(profile.month_eff * 100).toFixed(3)}%`}
            />
            <Stat
              label="In Cohort Since"
              value={new Date(profile.in_cohort_since).toLocaleDateString()}
            />
          </div>

          {/* Open positions */}
          <section>
            <h2 className="text-gray-500 text-xs font-bold tracking-widest mb-2">
              OPEN POSITIONS ({positions.length})
            </h2>
            {positions.length === 0 ? (
              <p className="text-gray-700 text-xs">No open positions</p>
            ) : (
              <div className="bg-gray-900 border border-gray-800 rounded overflow-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-gray-600 border-b border-gray-800">
                      <th className="text-left px-3 py-1.5">Coin</th>
                      <th className="text-left px-3 py-1.5">Side</th>
                      <th className="text-right px-3 py-1.5">Size</th>
                      <th className="text-right px-3 py-1.5">Entry</th>
                      <th className="text-right px-3 py-1.5">Lev</th>
                      <th className="text-right px-3 py-1.5">uPnL</th>
                    </tr>
                  </thead>
                  <tbody>
                    {positions
                      .sort((a: any, b: any) => b.size_usd - a.size_usd)
                      .map((p: any, i: number) => {
                        const isLong = p.side === "LONG";
                        return (
                          <tr key={i} className="border-b border-gray-900 hover:bg-gray-800">
                            <td className="px-3 py-1">
                              <Link
                                href={`/intel/hyperliquid/coin/${p.coin}`}
                                className="text-white font-bold hover:text-blue-400"
                              >
                                {p.coin}
                              </Link>
                            </td>
                            <td
                              className={`px-3 py-1 font-bold ${
                                isLong ? "text-green-400" : "text-red-400"
                              }`}
                            >
                              {p.side}
                            </td>
                            <td className="px-3 py-1 text-right text-gray-300">
                              {fmtUsd(p.size_usd)}
                            </td>
                            <td className="px-3 py-1 text-right text-gray-500">
                              ${Number(p.entry_px).toFixed(2)}
                            </td>
                            <td className="px-3 py-1 text-right text-gray-500">
                              {Number(p.leverage).toFixed(1)}x
                            </td>
                            <td
                              className={`px-3 py-1 text-right ${
                                p.unrealized_pnl >= 0 ? "text-green-400" : "text-red-400"
                              }`}
                            >
                              {fmtUsd(Math.abs(p.unrealized_pnl))}
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Whale events */}
          {whaleEvents.length > 0 && (
            <section>
              <h2 className="text-gray-500 text-xs font-bold tracking-widest mb-2">
                WHALE EVENTS (7D)
              </h2>
              <div className="space-y-1">
                {whaleEvents.map((e, i) => {
                  const evColor: Record<string, string> = {
                    WAKEUP: "text-purple-400",
                    SCALEUP: "text-green-400",
                    FLIP: "text-yellow-400",
                    EXIT: "text-red-400",
                    LEVERAGE_PUSH: "text-orange-400",
                  };
                  return (
                    <div key={i} className="flex gap-3 items-center text-xs bg-gray-900 border border-gray-800 rounded px-3 py-1.5">
                      <span className={`font-bold w-24 shrink-0 ${evColor[e.event_type] ?? "text-gray-400"}`}>
                        {e.event_type}
                      </span>
                      <Link
                        href={`/intel/hyperliquid/coin/${e.coin}`}
                        className="text-white font-bold hover:text-blue-400 w-16 shrink-0"
                      >
                        {e.coin}
                      </Link>
                      <span className={e.side === "LONG" ? "text-green-400" : "text-red-400"}>
                        {e.side}
                      </span>
                      <span className="text-gray-300">{fmtUsd(e.size_usd)}</span>
                      <span className="text-gray-600 ml-auto text-[10px]">
                        {new Date(e.ts).toLocaleTimeString("en-US", {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* Recent position changes */}
          {changes.length > 0 && (
            <section>
              <h2 className="text-gray-500 text-xs font-bold tracking-widest mb-2">
                RECENT CHANGES
              </h2>
              <div className="space-y-1 max-h-60 overflow-y-auto">
                {changes.slice(0, 30).map((c: any, i: number) => (
                  <div key={i} className="flex gap-3 text-xs text-gray-400">
                    <span className="text-gray-600 w-20 shrink-0">
                      {new Date(c.ts).toLocaleTimeString("en-US", {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                    <span className="text-yellow-400 w-24 shrink-0">{c.change_type}</span>
                    <Link
                      href={`/intel/hyperliquid/coin/${c.coin}`}
                      className="text-white hover:text-blue-400"
                    >
                      {c.coin}
                    </Link>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
