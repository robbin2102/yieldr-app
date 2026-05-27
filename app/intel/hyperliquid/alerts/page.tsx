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
  const month = d.toLocaleString("en-US", { month: "short" });
  const day = d.getDate();
  const time = d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
  return `${month} ${day} · ${time}`;
}

function timeLeft(until: string) {
  const diff = new Date(until.endsWith("Z") ? until : until + "Z").getTime() - Date.now();
  if (diff <= 0) return "expired";
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

const STRATEGY_COLOR: Record<string, { badge: string; card: string }> = {
  WAKEUP_LS10_4H:         { badge: "text-violet-300 bg-violet-950/60 border-violet-800", card: "border-violet-800/50 bg-violet-950/20" },
  WAKEUP_LS10:            { badge: "text-fuchsia-300 bg-fuchsia-950/60 border-fuchsia-800", card: "border-fuchsia-800/50 bg-fuchsia-950/20" },
  WAKEUP_LS10_WHALE_EXIT: { badge: "text-pink-300 bg-pink-950/60 border-pink-800",       card: "border-pink-800/50 bg-pink-950/20" },
  LS10_CROSS:             { badge: "text-sky-300 bg-sky-950/60 border-sky-800",          card: "border-sky-800/50 bg-sky-950/20" },
  WHALE_EXIT_FADE:        { badge: "text-orange-300 bg-orange-950/60 border-orange-800", card: "border-orange-800/50 bg-orange-950/20" },
};

const STRATEGY_SHORT: Record<string, string> = {
  WAKEUP_LS10_4H:         "WAKE 4h",
  WAKEUP_LS10:            "WAKE 24h",
  WAKEUP_LS10_WHALE_EXIT: "WAKE→exit",
  LS10_CROSS:             "L:S≥10",
  WHALE_EXIT_FADE:        "EXIT↩",
};

function entryLs(a: TradeAlert): string {
  const r = a.trigger_detail?.ls_ratio;
  return typeof r === "number" ? `${r.toFixed(1)}:1` : "—";
}

function ScoreCard({ s }: { s: TradeAlertScorecard }) {
  const col = STRATEGY_COLOR[s.strategy] ?? { badge: "text-zinc-400 bg-zinc-900 border-zinc-700", card: "border-zinc-800 bg-zinc-900/30" };
  const liveTotal = s.live_total;
  const liveWinPct = s.live_win_pct;
  const hasBacktest = s.backtest_win_pct != null;
  const holdLabel = s.hold_hours != null ? `${s.hold_hours}h hold` : "exit on whale close";
  // Same-horizon comparison: live holds at s.hold_hours, backtest shown at s.backtest_horizon_h
  // (set equal in STRATEGY_META) so the two numbers are directly comparable.
  const beating = hasBacktest && liveWinPct != null && liveTotal > 0 && liveWinPct >= (s.backtest_win_pct ?? 0);
  return (
    <div className={`border rounded p-4 space-y-3 ${col.card}`}>
      <div className="flex items-center justify-between">
        <span className={`text-xs font-bold px-2 py-0.5 rounded border ${col.badge}`}>
          {STRATEGY_SHORT[s.strategy] ?? s.strategy}
        </span>
        <span className="text-zinc-500 text-xs">{holdLabel}</span>
      </div>

      <div className="text-zinc-400 text-xs leading-relaxed">{s.rule}</div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-0.5">
          <div className="text-zinc-600 text-[10px] uppercase tracking-widest">
            {hasBacktest ? `Backtest ${s.backtest_horizon_h}h` : "Backtest"}
          </div>
          {hasBacktest ? (
            <>
              <div className="text-zinc-100 font-bold text-sm">{s.backtest_win_pct}% win</div>
              <div className="text-zinc-400 text-xs">+{s.backtest_return_pct}% avg · {s.backtest_n}n</div>
            </>
          ) : (
            <div className="text-zinc-600 text-sm">variable hold —<br/>no fixed-horizon backtest</div>
          )}
        </div>
        <div className="space-y-0.5">
          <div className="text-zinc-600 text-[10px] uppercase tracking-widest">Live ({liveTotal} closed)</div>
          <div className={`font-bold text-sm ${liveTotal === 0 ? "text-zinc-600" : liveWinPct != null && liveWinPct >= 60 ? "text-emerald-400" : "text-yellow-400"}`}>
            {liveTotal === 0 ? "—" : `${liveWinPct}% win`}
          </div>
          {s.live_avg_win_pct != null && (
            <div className="text-zinc-500 text-xs">+{s.live_avg_win_pct}% avg</div>
          )}
          {hasBacktest && liveTotal > 0 && (
            <div className={`text-[10px] ${beating ? "text-emerald-500" : "text-yellow-600"}`}>
              {beating ? "▲ at/above backtest" : "▼ below backtest"}
            </div>
          )}
        </div>
      </div>

      <div className="flex gap-4 text-xs pt-2 border-t border-zinc-800">
        <span className="text-zinc-500">{s.open} open</span>
        <span className="text-emerald-500">{s.live_wins}W</span>
        <span className="text-red-500">{s.live_losses}L</span>
      </div>
    </div>
  );
}

function ActiveRow({ a }: { a: TradeAlert }) {
  const isLong = a.side === "LONG";
  const ret = a.live_return_pct;
  const retColor = ret == null ? "text-zinc-600" : ret > 0 ? "text-emerald-400" : "text-red-400";
  const col = STRATEGY_COLOR[a.strategy] ?? { badge: "text-zinc-400 bg-zinc-900 border-zinc-700", card: "" };
  return (
    <tr className="border-b border-zinc-800/50 hover:bg-zinc-800/40">
      <td className="px-4 py-2">
        <span className={`text-xs font-bold px-1.5 py-0.5 rounded border ${col.badge}`}>
          {STRATEGY_SHORT[a.strategy] ?? a.strategy}
        </span>
      </td>
      <td className="px-4 py-2">
        <Link href={`/intel/hyperliquid/coin/${a.coin}`} className="text-sky-400 hover:text-orange-400 font-bold transition-colors">
          {a.coin}
        </Link>
      </td>
      <td className={`px-4 py-2 font-bold ${isLong ? "text-emerald-400" : "text-red-400"}`}>
        {isLong ? "▲ LONG" : "▼ SHORT"}
      </td>
      <td className="px-4 py-2 text-right text-zinc-500">{entryLs(a)}</td>
      <td className="px-4 py-2 text-right text-zinc-400">${fmtPx(a.entry_px)}</td>
      <td className="px-4 py-2 text-right text-zinc-300">${fmtPx(a.current_px)}</td>
      <td className={`px-4 py-2 text-right font-bold ${retColor}`}>
        {ret == null ? "—" : fmtPct(ret)}
      </td>
      <td className="px-4 py-2 text-right text-zinc-600 text-xs">{fmtDateTime(a.fired_at)}</td>
      <td className="px-4 py-2 text-right text-zinc-500 text-xs">{timeLeft(a.hold_until)}</td>
    </tr>
  );
}

function HistoryRow({ a }: { a: TradeAlert }) {
  const isLong = a.side === "LONG";
  const isWin = a.status === "WIN";
  const col = STRATEGY_COLOR[a.strategy] ?? { badge: "text-zinc-400 bg-zinc-900 border-zinc-700", card: "" };
  return (
    <tr className="border-b border-zinc-800/50 hover:bg-zinc-800/40">
      <td className="px-4 py-2 text-zinc-500 text-xs">{fmtDateTime(a.fired_at)}</td>
      <td className="px-4 py-2">
        <span className={`text-xs font-bold px-1.5 py-0.5 rounded border ${col.badge}`}>
          {STRATEGY_SHORT[a.strategy] ?? a.strategy}
        </span>
      </td>
      <td className="px-4 py-2">
        <Link href={`/intel/hyperliquid/coin/${a.coin}`} className="text-sky-400 hover:text-orange-400 font-bold transition-colors">
          {a.coin}
        </Link>
      </td>
      <td className={`px-4 py-2 font-bold ${isLong ? "text-emerald-400" : "text-red-400"}`}>
        {isLong ? "▲" : "▼"} {a.side}
      </td>
      <td className="px-4 py-2 text-right text-zinc-500">{entryLs(a)}</td>
      <td className="px-4 py-2 text-right text-zinc-400">${fmtPx(a.entry_px)}</td>
      <td className="px-4 py-2 text-right text-zinc-400">${fmtPx(a.exit_px)}</td>
      <td className={`px-4 py-2 text-right font-bold ${isWin ? "text-emerald-400" : "text-red-400"}`}>
        {fmtPct(a.return_pct)}
      </td>
      <td className="px-4 py-2 text-center">
        <span className={`text-xs font-bold px-2 py-0.5 rounded ${isWin ? "bg-emerald-900/60 text-emerald-300" : "bg-red-900/60 text-red-300"}`}>
          {a.status}
        </span>
        {a.exit_reason === "whale_exit" && (
          <span className="ml-1 text-[10px] text-pink-400" title="closed when whale exited">↩</span>
        )}
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
    <div>
      {/* Sub-header */}
      <div className="border-b border-zinc-800 px-4 py-2 flex items-center gap-4 flex-wrap">
        <span className="text-zinc-100 font-bold text-sm tracking-widest">
          {active.length} <span className="text-zinc-500 font-normal text-xs">OPEN ALERTS</span>
        </span>
        {overallWinPct != null && (
          <span className={`text-xs font-bold px-2.5 py-1 rounded border ${overallWinPct >= 60 ? "bg-emerald-500/10 border-emerald-500/50 text-emerald-400" : "bg-yellow-500/10 border-yellow-500/50 text-yellow-400"}`}>
            {overallWinPct}% WIN RATE · {totalWins}W {totalLosses}L
          </span>
        )}
      </div>

      <div className="p-4 space-y-6">

        {/* Strategy Scorecards */}
        <section>
          <div className="text-zinc-500 text-xs font-bold tracking-widest mb-3 uppercase">Strategy Performance</div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {scorecard.map(s => <ScoreCard key={s.strategy} s={s} />)}
          </div>
        </section>

        {/* Active Alerts */}
        <section>
          <div className="text-zinc-500 text-xs font-bold tracking-widest mb-2 uppercase">
            Active Alerts ({active.length})
          </div>
          {active.length === 0 ? (
            <p className="text-zinc-700 text-sm py-4">No open alerts — fires on next 5m snapshot.</p>
          ) : (
            <div className="bg-[#0D1117] border border-zinc-800 rounded overflow-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-zinc-500 border-b border-zinc-800 text-xs uppercase tracking-widest">
                    <th className="text-left px-4 py-2.5">Strategy</th>
                    <th className="text-left px-4 py-2.5">Coin</th>
                    <th className="text-left px-4 py-2.5">Side</th>
                    <th className="text-right px-4 py-2.5">Entry L:S</th>
                    <th className="text-right px-4 py-2.5">Entry</th>
                    <th className="text-right px-4 py-2.5">Current</th>
                    <th className="text-right px-4 py-2.5">P&amp;L</th>
                    <th className="text-right px-4 py-2.5">Fired</th>
                    <th className="text-right px-4 py-2.5">Expires</th>
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
          <div className="text-zinc-500 text-xs font-bold tracking-widest mb-2 uppercase">
            Completed (30d) — {totalWins} wins · {totalLosses} losses
          </div>
          {history.length === 0 ? (
            <p className="text-zinc-700 text-sm py-4">No completed alerts yet — resolves after hold window ends.</p>
          ) : (
            <div className="bg-[#0D1117] border border-zinc-800 rounded overflow-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-zinc-500 border-b border-zinc-800 text-xs uppercase tracking-widest">
                    <th className="text-left px-4 py-2.5">Date</th>
                    <th className="text-left px-4 py-2.5">Strategy</th>
                    <th className="text-left px-4 py-2.5">Coin</th>
                    <th className="text-left px-4 py-2.5">Side</th>
                    <th className="text-right px-4 py-2.5">Entry L:S</th>
                    <th className="text-right px-4 py-2.5">Entry</th>
                    <th className="text-right px-4 py-2.5">Exit</th>
                    <th className="text-right px-4 py-2.5">Return</th>
                    <th className="text-center px-4 py-2.5">Result</th>
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
