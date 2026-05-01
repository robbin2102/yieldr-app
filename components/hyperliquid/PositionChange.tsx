"use client";

import type { PositionChange as PC } from "@/lib/hyperliquid-signals";

interface PositionChangeProps {
  change: PC;
}

const TYPE_COLOR: Record<string, string> = {
  NEW_POSITION: "text-green-400",
  FLIP: "text-yellow-400",
  SIZE_CHANGE: "text-blue-400",
  CLOSED: "text-red-400",
  LEVERAGE_CHANGE: "text-orange-400",
};

const TYPE_LABEL: Record<string, string> = {
  NEW_POSITION: "NEW",
  FLIP: "FLIP",
  SIZE_CHANGE: "RESIZE",
  CLOSED: "CLOSED",
  LEVERAGE_CHANGE: "LEV↑",
};

function fmtTs(ts: string) {
  const d = new Date(ts);
  return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function fmtUsd(n: number) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

export function PositionChange({ change }: PositionChangeProps) {
  const color = TYPE_COLOR[change.change_type] ?? "text-gray-400";
  const label = TYPE_LABEL[change.change_type] ?? change.change_type;
  const state = change.new_state ?? change.previous_state;
  const sizeUsd = (state as any)?.size_usd ?? 0;
  const side = (state as any)?.side ?? "";
  const leverage = (state as any)?.leverage ?? 0;
  const sideColor = side === "LONG" ? "text-green-400" : "text-red-400";

  return (
    <div className="flex items-center gap-2 font-mono text-xs py-1 border-b border-gray-800">
      <span className="text-gray-500 w-12 shrink-0">{fmtTs(change.ts)}</span>
      <span className={`w-14 font-bold shrink-0 ${color}`}>{label}</span>
      <span className="text-white w-10 shrink-0">{change.coin}</span>
      <span className={`w-12 shrink-0 ${sideColor}`}>{side}</span>
      <span className="text-gray-300 w-16 shrink-0">{fmtUsd(sizeUsd)}</span>
      {leverage > 0 && <span className="text-gray-500">{leverage.toFixed(0)}x</span>}
      <span className="text-gray-600 truncate text-xs">{change.address.slice(0, 8)}…</span>
    </div>
  );
}
