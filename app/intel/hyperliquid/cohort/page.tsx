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

function fmtPnl(n: number | null | undefined) {
  if (n == null) return <span className="text-zinc-600">—</span>;
  const abs = Math.abs(n);
  const str =
    abs >= 1_000_000 ? `$${(abs / 1_000_000).toFixed(1)}M` :
    abs >= 1_000     ? `$${(abs / 1_000).toFixed(0)}K` :
                       `$${abs.toFixed(0)}`;
  return (
    <span className={n >= 0 ? "text-emerald-400" : "text-red-400"}>
      {n >= 0 ? "+" : "-"}{str}
    </span>
  );
}

const Q_COLOR: Record<number, string> = {
  1: "bg-amber-500 text-black",
  2: "bg-sky-700 text-white",
  3: "bg-zinc-700 text-zinc-200",
  4: "bg-zinc-900 text-zinc-500",
};

type SortField =
  | "month_roi" | "all_roi" | "account_value" | "roi_ratio"
  | "month_eff" | "skill_score" | "day_pnl" | "week_pnl" | "month_pnl"
  | "active_positions_count" | "active_positions_usd";

interface ColDef {
  field: SortField;
  label: string;
}

const COLUMNS: ColDef[] = [
  { field: "account_value",          label: "Acct Value"  },
  { field: "active_positions_count", label: "Positions"   },
  { field: "active_positions_usd",   label: "Pos Size"    },
  { field: "day_pnl",                label: "1d PnL"      },
  { field: "week_pnl",               label: "7d PnL"      },
  { field: "month_roi",              label: "Mo ROI"      },
  { field: "all_roi",                label: "All ROI"     },
  { field: "roi_ratio",              label: "Ratio"       },
  { field: "month_eff",              label: "Mo Eff"      },
  { field: "skill_score",            label: "Skill"       },
];

function SortIcon({ active, order }: { active: boolean; order: "asc" | "desc" }) {
  if (!active) return <span className="ml-1 text-zinc-700">⇅</span>;
  return <span className="ml-1 text-orange-400">{order === "desc" ? "↓" : "↑"}</span>;
}

export default function CohortPage() {
  const [sortBy, setSortBy] = useState<SortField>("month_roi");
  const [order, setOrder] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");

  function handleSort(field: SortField) {
    if (field === sortBy) {
      setOrder((o) => (o === "desc" ? "asc" : "desc"));
    } else {
      setSortBy(field);
      setOrder("desc");
    }
    setPage(1);
  }

  const { data, isLoading } = useQuery({
    queryKey: ["hl-cohort-full", page, sortBy, order],
    queryFn: () => hlSignals.getCohort(page, 50, sortBy, order),
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
                  <tr className="border-b border-zinc-800 text-xs uppercase tracking-widest">
                    <th className="text-left px-4 py-2.5 text-zinc-500 select-none">#</th>
                    <th className="text-left px-4 py-2.5 text-zinc-500 select-none">Q</th>
                    <th className="text-left px-4 py-2.5 text-zinc-500 select-none">Name / Address</th>
                    {COLUMNS.map((col) => (
                      <th
                        key={col.field}
                        onClick={() => handleSort(col.field)}
                        className={`text-right px-4 py-2.5 cursor-pointer select-none whitespace-nowrap hover:text-zinc-300 transition-colors ${
                          sortBy === col.field ? "text-orange-400" : "text-zinc-500"
                        }`}
                      >
                        {col.label}
                        <SortIcon active={sortBy === col.field} order={order} />
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {traders.map((t: Trader, i: number) => {
                    const q = t.skill_quartile ?? 4;
                    const posCount = t.active_positions_count ?? 0;
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
                        {/* Acct Value */}
                        <td className="px-4 py-2 text-right text-zinc-300">{fmtUsd(t.account_value)}</td>
                        {/* Positions count */}
                        <td className="px-4 py-2 text-right">
                          {posCount > 0
                            ? <span className="text-zinc-100 font-medium">{posCount}</span>
                            : <span className="text-zinc-700">0</span>
                          }
                        </td>
                        {/* Pos size USD */}
                        <td className="px-4 py-2 text-right text-zinc-400">
                          {t.active_positions_usd
                            ? fmtUsd(t.active_positions_usd)
                            : <span className="text-zinc-700">—</span>
                          }
                        </td>
                        {/* 1d PnL */}
                        <td className="px-4 py-2 text-right">{fmtPnl(t.day_pnl)}</td>
                        {/* 7d PnL */}
                        <td className="px-4 py-2 text-right">{fmtPnl(t.week_pnl)}</td>
                        {/* Mo ROI */}
                        <td className="px-4 py-2 text-right text-emerald-400 font-medium">
                          {(t.month_roi * 100).toFixed(1)}%
                        </td>
                        {/* All ROI */}
                        <td className="px-4 py-2 text-right text-emerald-400 font-medium">
                          {(t.all_roi * 100).toFixed(1)}%
                        </td>
                        {/* Ratio */}
                        <td className="px-4 py-2 text-right text-zinc-400">
                          {t.roi_ratio.toFixed(2)}x
                        </td>
                        {/* Mo Eff */}
                        <td className="px-4 py-2 text-right text-zinc-400">
                          {(t.month_eff * 100).toFixed(3)}%
                        </td>
                        {/* Skill */}
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
