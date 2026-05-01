"use client";

import type { Trader } from "@/lib/hyperliquid-signals";

interface TraderRowProps {
  trader: Trader;
  rank: number;
}

function fmtUsd(n: number) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

export function TraderRow({ trader, rank }: TraderRowProps) {
  const name = trader.display_name || trader.address.slice(0, 12);
  const roiColor = trader.month_roi > 0 ? "text-green-400" : "text-red-400";

  return (
    <div className="grid grid-cols-6 gap-2 font-mono text-xs py-1 border-b border-gray-800 hover:bg-gray-900">
      <span className="text-gray-500">#{rank}</span>
      <span className="col-span-2 text-gray-300 truncate" title={trader.address}>
        {name}
      </span>
      <span className="text-gray-400">{fmtUsd(trader.account_value)}</span>
      <span className={roiColor}>{(trader.month_roi * 100).toFixed(1)}%</span>
      <span className="text-gray-500">{trader.roi_ratio.toFixed(2)}x</span>
    </div>
  );
}
