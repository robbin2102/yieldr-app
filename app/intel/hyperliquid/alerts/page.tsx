"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  hlSignals,
  type TradeAlert,
  type TradeAlertScorecard,
} from "@/lib/hyperliquid-signals";

function fmtPx(p: number | null | undefined) {
  if (p == null || p <= 0) return "—";
  if (p >= 10_000) return p.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (p >= 1) return p.toFixed(3);
  if (p >= 0.0001) return p.toFixed(5);
  return p.toExponential(3);
}

function fmtPct(n: number | null | undefined, showPlus = true) {
  if (n == null) return "—";
  return `${showPlus && n > 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function fmtDateTime(ts: string | null | undefined) {
  if (!ts) return "—";
  const d = new Date(ts.endsWith("Z") ? ts : ts + "Z");
  return `${d.toLocaleString("en-US", { month: "short" })} ${d.getDate()}, ${d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}`;
}

function timeLeft(until: string) {
  const diff = new Date(until.endsWith("Z") ? until : until + "Z").getTime() - Date.now();
  if (diff <= 0) return "expired";
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  if (h > 0) return `${h}h ${m}m left`;
  return `${m}m left`;
}

const STRATEGY_COLOR: Record<string, string> = {
  WAKEUP_LS10: "text-purple-400 bg-purple-950 border-purple-800",
  LS10_CROSS: "text-blue-400 bg-blue-950 border-blue-800",
  WHALE_EXIT_FADE: "text-orange-400 bg-orange-950 border-orange-800",
};

const STRATEGY_SHORT: Record<string, string> = {
  WAKEUP_LS10: "WAKEUP+",
  LS10_CROSS: "L:S≥10",
  WHALE_EXIT_FADE: "EXIT↩",
};

function ReturnBadge({ val }: { val: number | null | undefined }) {
  if (val == null) return <span className="text-gray-600">—</span>;
  return (
    <span className={val > 0 ? "text-green-400" : "text-red-400"}>
      {val > 0 ? "▲" : "▼"} {fmtPct(Math.abs(val), false)}
    </span>
  );
}

function ScoreCard({ s }: { s: TradeAlertScorecard }) {
  const col = STRATEGY_COLOR[s.strategy] ?? "text-gray-400 bg-gray-900 border-gray-700";
  const liveTotal = s.live_total;
  const liveWinPct = s.live_win_pct;
  return (
    <div className={`border rounded p-3 space-y-2 ${col.split(" ").slice(1).join(" ")}`}>
      <div className={`text-xs font-bold ${col.split(" ")[0]}`}>{s.label}</div>
      <div className="text-gray-500 text-[10px] leading-relaxed">{s.rule}</div>

      <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[10px]">
        <div>
          <div className="text-gray-600">Backtest ({s.backtest_horizon_h}h)</div>
          <div className="text-white font-bold">
            {s.backtest_win_pct}% win · +{s.backtest_return_pct}% avg
            <span className="text-gray-600 font-normal ml-1">({s.backtest_n} trades)</span>
          </div>
        </div>
        <div>
          <div className="text-gray-600">Live ({liveTotal} resolved)</div>
          <div className={`font-bold ${liveTotal === 0 ? "text-gray-600" : liveWinPct != null && liveWinPct >= 60 ? "text-green-400" : "text-yellow-400"}`}>
            {liveTotal === 0 ? "no data yet" : `${liveWinPct}% win`}
            {s.live_avg_win_pct != null && (
              <span className="text-gray-500 font-normal ml-1">· avg +{s.live_avg_win_pct}%</span>
            )}
          </div>
        </div>
      </div>

      <div className="flex gap-3 text-[10px] pt-1 border-t border-gray-800">
        <span className="text-gray-500">{s.open} open</span>
        <span className="text-green-600">{s.live_wins} wins</span>
        <span className="text-red-600">{s.live_losses} losses</span>
        <span className="text-gray-600">hold {s.hold_hours}h</span>
      </div>
    </div>
  );
}

function ActiveRow({ a }: { a: TradeAlert }) {
  const isLong = a.side === "LONG";
  const ret = a.live_return_pct;
  const retColor = ret == null ? "text-gray-600" : ret > 0 ? "text-green-400" : "text-red-400";
  const stratCol = STRATEGY_COLOR[a.strategy] ?? "text-gray-400 bg-gray-900 border-gray-700";
  return (
    <tr className="border-b border-gray-900 hover:bg-gray-800">
      <td className="px-3 py-1.5">
        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${stratCol}`}>
          {STRATEGY_SHORT[a.strategy] ?? a.strategy}
        </span>
      </td>
      <td className="px-3 py-1.5">
        <Link href={`/intel/hyperliquid/coin/${a.coin}`} className="text-white font-bold hover:text-blue-400">
          {a.coin}
        </Link>
      </td>
      <td className={`px-3 py-1.5 font-bold ${isLong ? "text-green-400" : "text-red-400"}`}>
        {isLong ? "▲ LONG" : "▼ SHORT"}
      </td>
      <td className="px-3 py-1.5 text-right text-gray-400 font-mono">${fmtPx(a.entry_px)}</td>
      <td className="px-3 py-1.5 text-right text-gray-300 font-mono">${fmtPx(a.current_px)}</td>
      <td className={`px-3 py-1.5 text-right font-mono font-bold ${retColor}`}>
        {ret == null ? "—" : fmtPct(ret)}
      </td>
      <td className="px-3 py-1.5 text-right text-gray-600 text-[10px]">{fmtDateTime(a.fired_at)}</td>
      <td className="px-3 py-1.5 text-right text-gray-500 text-[10px]">{timeLeft(a.hold_until)}</td>
    </tr>
  );
}

function HistoryRow({ a }: { a: TradeAlert }) {
  const isLong = a.side === "LONG";
  const isWin = a.status === "WIN";
  const stratCol = STRATEGY_COLOR[a.strategy] ?? "text-gray-400 bg-gray-900 border-gray-700";
  return (
    <tr className="border-b border-gray-900 hover:bg-gray-800">
      <td className="px-3 py-1.5 text-gray-500 text-[10px]">{fmtDateTime(a.fired_at)}</td>
      <td className="px-3 py-1.5">
        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${stratCol}`}>
          {STRATEGY_SHORT[a.strategy] ?? a.strategy}
        </span>
      </td>
      <td className="px-3 py-1.5">
        <Link href={`/intel/hyperliquid/coin/${a.coin}`} className="text-white font-bold hover:text-blue-400">
          {a.coin}
        </Link>
      </td>
      <td className={`px-3 py-1.5 font-bold ${isLong ? "text-green-400" : "text-red-400"}`}>
        {isLong ? "▲" : "▼"} {a.side}
      </td>
      <td className="px-3 py-1.5 text-right text-gray-400 font-mono">${fmtPx(a.entry_px)}</td>
      <td className="px-3 py-1.5 text-right text-gray-400 font-mono">${fmtPx(a.exit_px)}</td>
      <td className={`px-3 py-1.5 text-right font-mono font-bold ${isWin ? "text-green-400" : "text-red-400"}`}>
        {fmtPct(a.return_pct)}
      </td>
      <td className="px-3 py-1.5 text-center">
        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${isWin ? "bg-green-900 text-green-300" : "bg-red-900 text-red-300"}`}>
          {a.status}
        </span>
      </td>
    </tr>
  );
}

export default function AlertsPage() {
  const { data: scorecardData } = useQuery({
    queryKey: ["trade-scorecard"],
    queryFn: () => hlSignals.getTradeAlertsScorecard(),
    refetchInterval: 60_000,
  });

  const { data: activeData } = useQuery({
    queryKey: ["trade-alerts-active"],
    queryFn: () => hlSignals.getTradeAlertsActive(),
    refetchInterval: 30_000,
  });

  const { data: historyData } = useQuery({
    queryKey: ["trade-alerts-history"],
    queryFn: () => hlSignals.getTradeAlertsHistory(30),
    refetchInterval: 60_000,
  });

  const scorecard = scorecardData?.data ?? [];
  const active = activeData?.data ?? [];
  const history = historyData?.data ?? [];

  const totalWins   = history.filter(a => a.status === "WIN").length;
  const totalLosses = history.filter(a => a.status === "LOSS").length;
  const totalDone   = totalWins + totalLosses;
  const overallWinPct = totalDone > 0 ? Math.round(totalWins / totalDone * 100) : null;

  return (
    <div className="min-h-screen bg-gray-950 text-gray-200 font-mono text-sm">
      {/* Header */}
      <div className="border-b border-gray-800 px-4 py-3 flex items-center gap-4">
        <Link href="/intel/hyperliquid" className="text-gray-600 hover:text-gray-400 text-xs">← Dashboard</Link>
        <h1 className="text-white font-bold">Trade Alerts</h1>
        {overallWinPct != null && (
          <span className={`text-xs font-bold px-2 py-0.5 rounded ${overallWinPct >= 60 ? "bg-green-900 text-green-300" : "bg-yellow-900 text-yellow-300"}`}>
            Overall {overallWinPct}% win ({totalWins}/{totalDone})
          </span>
        )}
        <span className="text-gray-700 text-xs ml-auto">auto-refresh 30s</span>
      </div>

      <div className="p-4 space-y-6">

        {/* Strategy Scorecards */}
        <section>
          <h2 className="text-gray-500 text-xs font-bold tracking-widest mb-3">STRATEGY PERFORMANCE</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {scorecard.map(s => <ScoreCard key={s.strategy} s={s} />)}
          </div>
        </section>

        {/* Active Alerts */}
        <section>
          <h2 className="text-gray-500 text-xs font-bold tracking-widest mb-2">
            ACTIVE ALERTS ({active.length})
          </h2>
          {active.length === 0 ? (
            <p className="text-gray-700 text-xs">No open alerts — next check at next 5m snapshot.</p>
          ) : (
            <div className="bg-gray-900 border border-gray-800 rounded overflow-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-gray-600 border-b border-gray-800 text-[10px]">
                    <th className="text-left px-3 py-1.5">Strategy</th>
                    <th className="text-left px-3 py-1.5">Coin</th>
                    <th className="text-left px-3 py-1.5">Side</th>
                    <th className="text-right px-3 py-1.5">Entry $</th>
                    <th className="text-right px-3 py-1.5">Now $</th>
                    <th className="text-right px-3 py-1.5">P&L</th>
                    <th className="text-right px-3 py-1.5">Fired</th>
                    <th className="text-right px-3 py-1.5">Expires</th>
                  </tr>
                </thead>
                <tbody>
                  {active.map((a, i) => <ActiveRow key={i} a={a} />)}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* History */}
        <section>
          <div className="flex items-center gap-3 mb-2">
            <h2 className="text-gray-500 text-xs font-bold tracking-widest">
              COMPLETED (30d) — {totalWins} wins · {totalLosses} losses
            </h2>
          </div>
          {history.length === 0 ? (
            <p className="text-gray-700 text-xs">No completed alerts yet — alerts resolve after their hold window ends.</p>
          ) : (
            <div className="bg-gray-900 border border-gray-800 rounded overflow-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-gray-600 border-b border-gray-800 text-[10px]">
                    <th className="text-left px-3 py-1.5">Date</th>
                    <th className="text-left px-3 py-1.5">Strategy</th>
                    <th className="text-left px-3 py-1.5">Coin</th>
                    <th className="text-left px-3 py-1.5">Side</th>
                    <th className="text-right px-3 py-1.5">Entry $</th>
                    <th className="text-right px-3 py-1.5">Exit $</th>
                    <th className="text-right px-3 py-1.5">Return</th>
                    <th className="text-center px-3 py-1.5">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((a, i) => <HistoryRow key={i} a={a} />)}
                </tbody>
              </table>
            </div>
          )}
        </section>

      </div>
    </div>
  );
}
