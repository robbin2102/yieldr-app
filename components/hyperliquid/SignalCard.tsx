"use client";

import { useState } from "react";
import type { ConvergenceSignal } from "@/lib/hyperliquid-signals";
import { Sparkline } from "./Sparkline";

interface SignalCardProps {
  signal: ConvergenceSignal;
  sparkData?: number[];
  tier?: 1 | 2 | 3;
  onExpand?: () => void;
}

function fmtUsd(n: number) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

const TIER_BADGE: Record<number, string> = {
  1: "bg-yellow-500 text-black",
  2: "bg-blue-500 text-white",
  3: "bg-gray-600 text-gray-200",
};

export function SignalCard({ signal, sparkData, tier, onExpand }: SignalCardProps) {
  const [expanded, setExpanded] = useState(false);
  const isLong = signal.side === "LONG";
  const borderColor = isLong ? "border-green-500" : "border-red-500";
  const sideColor = isLong ? "text-green-400" : "text-red-400";
  const conviction = (signal.conviction * 100).toFixed(1);

  function toggle() {
    setExpanded((e) => !e);
    onExpand?.();
  }

  return (
    <div
      className={`border ${borderColor} bg-gray-900 rounded p-3 cursor-pointer hover:bg-gray-800 transition-colors`}
      onClick={toggle}
    >
      <div className="flex items-start justify-between">
        <div>
          <span className="font-mono font-bold text-white text-lg">{signal.coin}</span>
          {tier && (
            <span className={`ml-2 text-xs px-1 rounded font-bold ${TIER_BADGE[tier]}`}>
              T{tier}
            </span>
          )}
        </div>
        <div className={`flex items-center gap-1 font-mono text-sm font-bold ${sideColor}`}>
          {isLong ? "▲" : "▼"} {signal.side}
        </div>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-xs text-gray-300">
        <span>
          Conv: <span className={sideColor}>{conviction}%</span>
        </span>
        <span>Traders: {signal.n_traders}</span>
        <span>Exposure: {fmtUsd(signal.total_usd)}</span>
        <span>Avg ROI: {(signal.avg_mo_roi * 100).toFixed(1)}%</span>
      </div>

      {sparkData && (
        <div className="mt-2">
          <Sparkline data={sparkData} color={isLong ? "#22c55e" : "#ef4444"} />
        </div>
      )}

      {expanded && signal.top_traders.length > 0 && (
        <div className="mt-3 border-t border-gray-700 pt-2">
          <p className="text-gray-500 text-xs mb-1 font-mono">TOP HOLDERS</p>
          {signal.top_traders.map((t, i) => (
            <div key={t.address} className="flex justify-between font-mono text-xs text-gray-400">
              <span className="truncate w-36">
                #{i + 1} {t.address.slice(0, 10)}…
              </span>
              <span className={sideColor}>{fmtUsd(t.size_usd)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
