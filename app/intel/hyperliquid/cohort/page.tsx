"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { hlSignals, type Trader } from "@/lib/hyperliquid-signals";

function fmtUsd(n: number) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

const Q_COLOR: Record<number, string> = {
  1: "bg-yellow-600 text-black",
  2: "bg-blue-700 text-white",
  3: "bg-gray-700 text-gray-200",
  4: "bg-gray-900 text-gray-500",
};

const SORT_OPTIONS = [
  { value: "month_roi", label: "MoROI" },
  { value: "account_value", label: "AV" },
  { value: "roi_ratio", label: "Ratio" },
  { value: "month_eff", label: "Eff" },
];

export default function CohortPage() {
  const [sortBy, setSortBy] = useState("month_roi");
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["hl-cohort-full", page, sortBy],
    queryFn: () => hlSignals.getCohort(page, 50, sortBy),
    refetchInterval: 60_000,
  });

  const traders = (data?.data ?? []).filter(
    (t: Trader) =>
      !search ||
      t.address.includes(search.toLowerCase()) ||
      (t.display_name ?? "").toLowerCase().includes(search.toLowerCase())
  );
  const total = data?.total ?? 0;

  return (
    <div className="min-h-screen bg-gray-950 text-gray-200 font-mono text-sm">
      <div className="border-b border-gray-800 px-4 py-3 flex items-center gap-4 flex-wrap">
        <Link href="/intel/hyperliquid" className="text-gray-600 hover:text-gray-400 text-xs">
          ← Dashboard
        </Link>
        <h1 className="text-white font-bold">COHORT</h1>
        <span className="text-gray-500 text-xs">{total} active traders</span>
        <input
          type="text"
          placeholder="Search address or name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 w-52 ml-auto"
        />
      </div>

      <div className="p-4">
        {/* Sort controls */}
        <div className="flex gap-2 mb-3">
          <span className="text-gray-600 text-xs self-center">Sort:</span>
          {SORT_OPTIONS.map((o) => (
            <button
              key={o.value}
              onClick={() => { setSortBy(o.value); setPage(1); }}
              className={`text-xs px-2 py-0.5 rounded ${
                sortBy === o.value ? "bg-gray-700 text-white" : "text-gray-600 hover:text-gray-300"
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>

        {isLoading ? (
          <div className="text-center text-gray-600 py-8">Loading…</div>
        ) : (
          <>
            <div className="bg-gray-900 border border-gray-800 rounded overflow-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-gray-600 border-b border-gray-800">
                    <th className="text-left px-3 py-2">#</th>
                    <th className="text-left px-3 py-2">Q</th>
                    <th className="text-left px-3 py-2">Name / Address</th>
                    <th className="text-right px-3 py-2">AV</th>
                    <th className="text-right px-3 py-2">MoROI</th>
                    <th className="text-right px-3 py-2">AllROI</th>
                    <th className="text-right px-3 py-2">Ratio</th>
                    <th className="text-right px-3 py-2">MoEff</th>
                    <th className="text-right px-3 py-2">Skill</th>
                  </tr>
                </thead>
                <tbody>
                  {traders.map((t: Trader, i: number) => {
                    const q = t.skill_quartile ?? 4;
                    return (
                      <tr key={t.address} className="border-b border-gray-900 hover:bg-gray-800">
                        <td className="px-3 py-1 text-gray-600">{(page - 1) * 50 + i + 1}</td>
                        <td className="px-3 py-1">
                          <span className={`px-1 rounded text-[10px] font-bold ${Q_COLOR[q]}`}>
                            Q{q}
                          </span>
                        </td>
                        <td className="px-3 py-1">
                          <Link
                            href={`/intel/hyperliquid/trader/${t.address}`}
                            className="text-blue-400 hover:text-blue-300"
                          >
                            {t.display_name || t.address.slice(0, 14) + "…"}
                          </Link>
                        </td>
                        <td className="px-3 py-1 text-right text-gray-300">{fmtUsd(t.account_value)}</td>
                        <td className="px-3 py-1 text-right text-green-400">
                          {(t.month_roi * 100).toFixed(1)}%
                        </td>
                        <td className="px-3 py-1 text-right text-green-400">
                          {(t.all_roi * 100).toFixed(1)}%
                        </td>
                        <td className="px-3 py-1 text-right text-gray-400">
                          {t.roi_ratio.toFixed(2)}x
                        </td>
                        <td className="px-3 py-1 text-right text-gray-400">
                          {(t.month_eff * 100).toFixed(3)}%
                        </td>
                        <td className="px-3 py-1 text-right text-gray-500">
                          {t.skill_score?.toFixed(3) ?? "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            <div className="flex items-center gap-3 mt-3 text-xs text-gray-500">
              <button
                disabled={page === 1}
                onClick={() => setPage((p) => p - 1)}
                className="px-2 py-1 rounded border border-gray-800 disabled:opacity-30 hover:text-white"
              >
                ← Prev
              </button>
              <span>
                Page {page} · {total} total
              </span>
              <button
                disabled={page * 50 >= total}
                onClick={() => setPage((p) => p + 1)}
                className="px-2 py-1 rounded border border-gray-800 disabled:opacity-30 hover:text-white"
              >
                Next →
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
