"use client";

interface HeatmapCell {
  conviction: number;
  side: "LONG" | "SHORT";
  n_traders: number;
  total_usd: number;
}

interface HeatmapProps {
  coins: string[];
  snapshots: string[];
  matrix: Record<string, Record<string, HeatmapCell>>;
}

function cellColor(cell: HeatmapCell | undefined): string {
  if (!cell) return "bg-gray-900";
  const intensity = Math.min(cell.conviction, 1);
  const level = Math.round(intensity * 9) * 100;
  if (cell.side === "LONG") {
    const map: Record<number, string> = {
      100: "bg-green-900", 200: "bg-green-800", 300: "bg-green-700",
      400: "bg-green-600", 500: "bg-green-500", 600: "bg-green-500",
      700: "bg-green-400", 800: "bg-green-300", 900: "bg-green-200",
    };
    return map[level] ?? "bg-green-900";
  }
  const map: Record<number, string> = {
    100: "bg-red-900", 200: "bg-red-800", 300: "bg-red-700",
    400: "bg-red-600", 500: "bg-red-500", 600: "bg-red-500",
    700: "bg-red-400", 800: "bg-red-300", 900: "bg-red-200",
  };
  return map[level] ?? "bg-red-900";
}

function fmtSnap(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function fmtUsd(n: number) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

// Deduplicate snapshots to ~1 per day for readability
function deduplicateDays(snapshots: string[]): string[] {
  const seen = new Set<string>();
  return snapshots.filter((s) => {
    const day = s.slice(0, 10);
    if (seen.has(day)) return false;
    seen.add(day);
    return true;
  });
}

export function Heatmap({ coins, snapshots, matrix }: HeatmapProps) {
  const displaySnaps = deduplicateDays(snapshots).slice(-14);

  return (
    <div className="overflow-x-auto">
      <table className="text-xs font-mono border-collapse">
        <thead>
          <tr>
            <th className="text-left text-gray-500 pr-2 w-16">Coin</th>
            {displaySnaps.map((s) => (
              <th key={s} className="text-gray-500 px-1 text-center min-w-10">
                {fmtSnap(s)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {coins.map((coin) => (
            <tr key={coin}>
              <td className="text-gray-300 pr-2 py-0.5 font-bold">{coin}</td>
              {displaySnaps.map((snap) => {
                const cell = matrix[coin]?.[snap] as HeatmapCell | undefined;
                return (
                  <td key={snap} className="px-0.5 py-0.5 text-center">
                    <div
                      className={`${cellColor(cell)} w-9 h-5 rounded-sm cursor-default`}
                      title={
                        cell
                          ? `${coin} ${cell.side} | Conv: ${(cell.conviction * 100).toFixed(0)}% | ${cell.n_traders} traders | ${fmtUsd(cell.total_usd)}`
                          : "No data"
                      }
                    />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex gap-4 mt-2 text-xs text-gray-500 font-mono">
        <span>
          <span className="inline-block w-3 h-3 bg-green-500 rounded-sm mr-1" />
          LONG
        </span>
        <span>
          <span className="inline-block w-3 h-3 bg-red-500 rounded-sm mr-1" />
          SHORT
        </span>
        <span className="text-gray-600">Darker = stronger conviction</span>
      </div>
    </div>
  );
}
