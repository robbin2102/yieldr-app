"use client";

import { useQuery } from "@tanstack/react-query";
import { hlSignals, type Trader } from "@/lib/hyperliquid-signals";

interface TraderModalProps {
  address: string;
  onClose: () => void;
}

function fmtUsd(n: number) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="bg-gray-800 rounded p-2">
      <div className="text-gray-500 text-xs">{label}</div>
      <div className={`font-mono font-bold text-sm mt-0.5 ${color ?? "text-white"}`}>{value}</div>
    </div>
  );
}

export function TraderModal({ address, onClose }: TraderModalProps) {
  const { data, isLoading } = useQuery({
    queryKey: ["hl-trader", address],
    queryFn: () => hlSignals.getTrader(address),
  });

  const profile = data?.profile as Trader | undefined;
  const positions = (data?.positions ?? []) as any[];
  const changes = (data?.recent_changes ?? []) as any[];

  const name = profile?.display_name || address.slice(0, 16) + "…";

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-gray-950 border border-gray-700 rounded-lg w-full max-w-2xl max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-800">
          <div>
            <div className="text-white font-mono font-bold">{name}</div>
            <div className="text-gray-500 text-xs font-mono">{address}</div>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-xl px-2">✕</button>
        </div>

        {isLoading ? (
          <div className="p-8 text-center text-gray-500 font-mono text-sm">Loading…</div>
        ) : !profile ? (
          <div className="p-8 text-center text-gray-500 font-mono text-sm">Trader not found</div>
        ) : (
          <div className="p-4 space-y-4">
            {/* Stats grid */}
            <div className="grid grid-cols-3 gap-2">
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
            <div>
              <h3 className="text-gray-500 text-xs font-mono font-bold tracking-widest mb-2">
                OPEN POSITIONS ({positions.length})
              </h3>
              {positions.length === 0 ? (
                <p className="text-gray-600 text-xs font-mono">No open positions</p>
              ) : (
                <div className="space-y-1">
                  <div className="grid grid-cols-6 text-gray-600 text-xs font-mono font-bold pb-1 border-b border-gray-800">
                    <span>Coin</span>
                    <span>Side</span>
                    <span>Size</span>
                    <span>Entry</span>
                    <span>Lev</span>
                    <span>uPnL</span>
                  </div>
                  {positions
                    .sort((a: any, b: any) => b.size_usd - a.size_usd)
                    .map((p: any, i: number) => {
                      const isLong = p.side === "LONG";
                      return (
                        <div
                          key={i}
                          className="grid grid-cols-6 text-xs font-mono py-1 border-b border-gray-900"
                        >
                          <span className="text-white font-bold">{p.coin}</span>
                          <span className={isLong ? "text-green-400" : "text-red-400"}>
                            {p.side}
                          </span>
                          <span className="text-gray-300">{fmtUsd(p.size_usd)}</span>
                          <span className="text-gray-400">${Number(p.entry_px).toFixed(2)}</span>
                          <span className="text-gray-400">{Number(p.leverage).toFixed(1)}x</span>
                          <span
                            className={
                              p.unrealized_pnl >= 0 ? "text-green-400" : "text-red-400"
                            }
                          >
                            {fmtUsd(Math.abs(p.unrealized_pnl))}
                          </span>
                        </div>
                      );
                    })}
                </div>
              )}
            </div>

            {/* Recent changes */}
            {changes.length > 0 && (
              <div>
                <h3 className="text-gray-500 text-xs font-mono font-bold tracking-widest mb-2">
                  RECENT CHANGES
                </h3>
                <div className="space-y-1 max-h-40 overflow-y-auto">
                  {changes.slice(0, 20).map((c: any, i: number) => (
                    <div key={i} className="flex gap-3 text-xs font-mono text-gray-400">
                      <span className="text-gray-600 w-20 shrink-0">
                        {new Date(c.ts).toLocaleTimeString("en-US", {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                      <span className="text-yellow-400 w-20 shrink-0">{c.change_type}</span>
                      <span className="text-white">{c.coin}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
