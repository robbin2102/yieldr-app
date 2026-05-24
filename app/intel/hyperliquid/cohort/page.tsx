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
  1: "bg-amber-500 text-black",
  2: "bg-sky-700 text-white",
  3: "bg-zinc-700 text-zinc-200",
  4: "bg-zinc-900 text-zinc-500",
};

const SORT_OPTIONS = [
  { value: "month_roi",    label: "MO ROI" },
  { value: "account_value", label: "ACCT VALUE" },
  { value: "roi_ratio",    label: "ROI RATIO" },
  { value: "month_eff",   label: "EFFICIENCY" },
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
    <div>
      {/* Sub-header */}
      <div className="border-b border-zinc-800 px-4 py-2 flex items-center gap-4 flex-wrap">
        <span className="text-zinc-100 font-bold text-sm tracking-widest">
          {total} <span className="text-zinc-500 font-normal text-xs">ACTIVE TRADERS</span>
        </span>
        <div className="flex gap-1 ml-2">
          {SORT_OPTIONS.map((o) => (
            <button
              key={o.value}
              onClick={() => { setSortBy(o.value); setPage(1); }}
              className={`text-xs px-2.5 py-1 rounded border transition-colors ${
                sortBy === o.value
                  ? "bg-orange-500/10 border-orange-500/50 text-orange-400"
                  : "border-zinc-800 text-zinc-600 hover:text-zinc-300 hover:border-zinc-600"
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
        <input
          type="text"
          placeholder="Search address or name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="ml-auto bg-zinc-900 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-200 placeholder:text-zinc-600 w-56 focus:outline-none focus:border-orange-500/50"
        />
      </div>

      <div className="p-4">
        {isLoading ? (
          <div className="text-center text-zinc-600 text-sm py-12">Loading…</div>
        ) : (
          <>
            <div className="bg-[#0D1117] border border-zinc-800 rounded overflow-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-zinc-500 border-b border-zinc-800 text-xs uppercase tracking-widest">
                    <th className="text-left px-4 py-2.5">#</th>
                    <th className="text-left px-4 py-2.5">Q</th>
                    <th className="text-left px-4 py-2.5">Name / Address</th>
                    <th className="text-right px-4 py-2.5">Acct Value</th>
                    <th className="text-right px-4 py-2.5">Mo ROI</th>
                    <th className="text-right px-4 py-2.5">All ROI</th>
                    <th className="text-right px-4 py-2.5">Ratio</th>
                    <th className="text-right px-4 py-2.5">Mo Eff</th>
                    <th className="text-right px-4 py-2.5">Skill</th>
                  </tr>
                </thead>
                <tbody>
                  {traders.map((t: Trader, i: number) => {
                    const q = t.skill_quartile ?? 4;
                    return (
                      <tr key={t.address} className="border-b border-zinc-800/50 hover:bg-zinc-800/40">
                        <td className="px-4 py-2 text-zinc-600">{(page - 1) * 50 + i + 1}</td>
                        <td className="px-4 py-2">
                          <span className={`px-1.5 py-0.5 rounded text-xs font-bold ${Q_COLOR[q]}`}>
                            Q{q}
                          </span>
                        </td>
                        <td className="px-4 py-2">
                          <Link
                            href={`/intel/hyperliquid/trader/${t.address}`}
                            className="text-sky-400 hover:text-orange-400 transition-colors"
                          >
                            {t.display_name || t.address.slice(0, 14) + "…"}
                          </Link>
                        </td>
                        <td className="px-4 py-2 text-right text-zinc-300">{fmtUsd(t.account_value)}</td>
                        <td className="px-4 py-2 text-right text-emerald-400 font-medium">
                          {(t.month_roi * 100).toFixed(1)}%
                        </td>
                        <td className="px-4 py-2 text-right text-emerald-400 font-medium">
                          {(t.all_roi * 100).toFixed(1)}%
                        </td>
                        <td className="px-4 py-2 text-right text-zinc-400">
                          {t.roi_ratio.toFixed(2)}x
                        </td>
                        <td className="px-4 py-2 text-right text-zinc-400">
                          {(t.month_eff * 100).toFixed(3)}%
                        </td>
                        <td className="px-4 py-2 text-right text-zinc-500">
                          {t.skill_score?.toFixed(3) ?? "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="flex items-center gap-3 mt-3 text-xs text-zinc-500">
              <button
                disabled={page === 1}
                onClick={() => setPage((p) => p - 1)}
                className="px-3 py-1.5 rounded border border-zinc-800 disabled:opacity-30 hover:text-zinc-100 hover:border-zinc-600 transition-colors"
              >
                ← Prev
              </button>
              <span>Page {page} · {total} traders</span>
              <button
                disabled={page * 50 >= total}
                onClick={() => setPage((p) => p + 1)}
                className="px-3 py-1.5 rounded border border-zinc-800 disabled:opacity-30 hover:text-zinc-100 hover:border-zinc-600 transition-colors"
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
