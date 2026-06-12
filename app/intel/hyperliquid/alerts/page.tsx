"use client";

import { useState } from "react";
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
  WAKEUP_LS10_4H:           { badge: "text-violet-300 bg-violet-950/60 border-violet-800",  card: "border-violet-800/50 bg-violet-950/20" },
  WAKEUP_LS10:              { badge: "text-fuchsia-300 bg-fuchsia-950/60 border-fuchsia-800", card: "border-fuchsia-800/50 bg-fuchsia-950/20" },
  WHALE_FLIP:               { badge: "text-orange-300 bg-orange-950/60 border-orange-800",   card: "border-orange-800/50 bg-orange-950/20" },
  WAKEUP_LS_LOW_24H:        { badge: "text-cyan-300 bg-cyan-950/60 border-cyan-800",        card: "border-cyan-800/50 bg-cyan-950/20" },
  WAKEUP_LS_LOW_SHORT_24H:  { badge: "text-sky-300 bg-sky-950/60 border-sky-800",           card: "border-sky-800/50 bg-sky-950/20" },
  WHALE_SCALEUP_4H:         { badge: "text-amber-300 bg-amber-950/60 border-amber-800",     card: "border-amber-800/50 bg-amber-950/20" },
};

const STRATEGY_SHORT: Record<string, string> = {
  WAKEUP_LS10_4H:           "WAKE 4h",
  WAKEUP_LS10:              "WAKE 24h",
  WHALE_FLIP:               "FLIP",
  WAKEUP_LS_LOW_24H:        "WAKE-LO 24h",
  WAKEUP_LS_LOW_SHORT_24H:  "WAKE-LO-S 24h",
  WHALE_SCALEUP_4H:         "SCALE 4h",
};

function entryLs(a: TradeAlert): string {
  const r = a.trigger_detail?.crowd_ratio;
  if (typeof r !== "number") return "—";
  const side = a.trigger_detail?.crowd_side;
  const suffix = side === "short" ? " (S)" : side === "long" ? " (L)" : "";
  return `${r.toFixed(1)}:1${suffix}`;
}

// ── Coin-level breakdown table ────────────────────────────────────────────────
function CoinStatsTable({ trades }: { trades: TradeAlert[] }) {
  const stats = (() => {
    const map: Record<string, { n: number; wins: number; net: number[]; winRets: number[] }> = {};
    for (const a of trades) {
      if (!map[a.coin]) map[a.coin] = { n: 0, wins: 0, net: [], winRets: [] };
      map[a.coin].n++;
      if (a.return_pct != null) map[a.coin].net.push(a.return_pct);
      if (a.status === "WIN") {
        map[a.coin].wins++;
        if (a.return_pct != null) map[a.coin].winRets.push(a.return_pct);
      }
    }
    return Object.entries(map)
      .map(([coin, s]) => ({
        coin,
        n:        s.n,
        wins:     s.wins,
        losses:   s.n - s.wins,
        winPct:   s.n > 0 ? Math.round(s.wins / s.n * 100) : 0,
        avgNet:   s.net.length     ? s.net.reduce((a, b) => a + b, 0)     / s.net.length     : null,
        avgWin:   s.winRets.length ? s.winRets.reduce((a, b) => a + b, 0) / s.winRets.length : null,
      }))
      .sort((a, b) => b.n - a.n);
  })();

  if (stats.length === 0) return null;

  return (
    <div className="bg-[#0D1117] border border-zinc-800 rounded overflow-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-zinc-500 border-b border-zinc-800 uppercase tracking-widest">
            <th className="text-left  px-3 py-2">Coin</th>
            <th className="text-right px-3 py-2">N</th>
            <th className="text-right px-3 py-2">W / L</th>
            <th className="text-right px-3 py-2">Win%</th>
            <th className="text-right px-3 py-2">Net Avg</th>
            <th className="text-right px-3 py-2">Avg Win</th>
          </tr>
        </thead>
        <tbody>
          {stats.map(s => (
            <tr key={s.coin} className="border-b border-zinc-800/40 hover:bg-zinc-800/30">
              <td className="px-3 py-1.5">
                <Link href={`/intel/hyperliquid/coin/${s.coin}`}
                      className="text-sky-400 hover:text-orange-400 font-bold transition-colors">
                  {s.coin}
                </Link>
              </td>
              <td className="px-3 py-1.5 text-right text-zinc-400">{s.n}</td>
              <td className="px-3 py-1.5 text-right">
                <span className="text-emerald-600">{s.wins}W</span>
                <span className="text-zinc-700"> · </span>
                <span className="text-red-700">{s.losses}L</span>
              </td>
              <td className={`px-3 py-1.5 text-right font-bold ${
                s.winPct >= 60 ? "text-emerald-400" : s.winPct >= 40 ? "text-yellow-500" : "text-red-400"
              }`}>{s.winPct}%</td>
              <td className={`px-3 py-1.5 text-right ${
                s.avgNet != null && s.avgNet > 0 ? "text-emerald-400" : "text-red-400"
              }`}>{fmtPct(s.avgNet)}</td>
              <td className="px-3 py-1.5 text-right text-emerald-500">{fmtPct(s.avgWin)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Strategy scorecard table ──────────────────────────────────────────────────
function ScorecardRow({ s }: { s: TradeAlertScorecard }) {
  const col = STRATEGY_COLOR[s.strategy] ?? { badge: "text-zinc-400 bg-zinc-900 border-zinc-700", card: "" };
  const liveTotal  = s.live_total;
  const liveWinPct = s.live_win_pct;
  const hasBacktest = s.backtest_win_pct != null;
  const holdLabel   = s.hold_hours != null ? `${s.hold_hours}h` : "var";
  const beating     = hasBacktest && liveWinPct != null && liveTotal > 0 && liveWinPct >= (s.backtest_win_pct ?? 0);
  return (
    <tr className="border-b border-zinc-800/50 hover:bg-zinc-800/40">
      <td className="px-3 py-2">
        <span className={`text-xs font-bold px-1.5 py-0.5 rounded border ${col.badge}`}>
          {STRATEGY_SHORT[s.strategy] ?? s.strategy}
        </span>
      </td>
      <td className="px-3 py-2 text-zinc-500 text-xs hidden lg:table-cell max-w-xs truncate" title={s.rule}>
        {s.rule}
      </td>
      <td className="px-3 py-2 text-center text-zinc-400 text-xs">{holdLabel}</td>
      <td className="px-3 py-2 text-right text-zinc-300 text-xs">
        {hasBacktest ? `${s.backtest_win_pct}%` : "—"}
      </td>
      <td className={`px-3 py-2 text-right text-xs ${
        hasBacktest && s.backtest_return_pct != null
          ? (s.backtest_return_pct > 0 ? "text-emerald-500" : "text-red-500")
          : "text-zinc-600"
      }`}>
        {hasBacktest ? fmtPct(s.backtest_return_pct) : "—"}
      </td>
      <td className="px-3 py-2 text-right text-zinc-600 text-xs">{hasBacktest ? s.backtest_n : "—"}</td>
      <td className="px-3 py-2 text-right text-zinc-500 text-xs">{s.open}</td>
      <td className="px-3 py-2 text-right text-xs">
        <span className="text-emerald-500">{s.live_wins}W</span>
        <span className="text-zinc-700"> / </span>
        <span className="text-red-500">{s.live_losses}L</span>
      </td>
      <td className={`px-3 py-2 text-right font-bold text-xs ${
        liveTotal === 0 ? "text-zinc-600" : liveWinPct != null && liveWinPct >= 60 ? "text-emerald-400" : "text-yellow-400"
      }`}>
        {liveTotal === 0 ? "—" : `${liveWinPct}%`}
      </td>
      <td className={`px-3 py-2 text-right text-xs ${
        s.live_avg_net_pct != null && s.live_avg_net_pct > 0 ? "text-emerald-400" : s.live_avg_net_pct != null ? "text-red-400" : "text-zinc-600"
      }`}>
        {fmtPct(s.live_avg_net_pct)}
      </td>
      <td className="px-3 py-2 text-center text-xs">
        {hasBacktest && liveTotal > 0 ? (
          <span className={beating ? "text-emerald-500" : "text-yellow-600"}>{beating ? "▲" : "▼"}</span>
        ) : (
          <span className="text-zinc-700">—</span>
        )}
      </td>
    </tr>
  );
}

function ScorecardTable({ scorecard }: { scorecard: TradeAlertScorecard[] }) {
  if (scorecard.length === 0) return null;
  return (
    <div className="bg-[#0D1117] border border-zinc-800 rounded overflow-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-zinc-500 border-b border-zinc-800 text-xs uppercase tracking-widest">
            <th className="text-left  px-3 py-2.5">Strategy</th>
            <th className="text-left  px-3 py-2.5 hidden lg:table-cell">Rule</th>
            <th className="text-center px-3 py-2.5">Hold</th>
            <th className="text-right px-3 py-2.5">BT Win%</th>
            <th className="text-right px-3 py-2.5">BT Net</th>
            <th className="text-right px-3 py-2.5">BT N</th>
            <th className="text-right px-3 py-2.5">Open</th>
            <th className="text-right px-3 py-2.5">Live W/L</th>
            <th className="text-right px-3 py-2.5">Live Win%</th>
            <th className="text-right px-3 py-2.5">Live Net</th>
            <th className="text-center px-3 py-2.5">vs BT</th>
          </tr>
        </thead>
        <tbody>
          {scorecard.map(s => <ScorecardRow key={s.strategy} s={s} />)}
        </tbody>
      </table>
    </div>
  );
}

function ActiveRow({ a }: { a: TradeAlert }) {
  const isLong   = a.side === "LONG";
  const ret      = a.live_return_pct;
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
  const isWin  = a.status === "WIN";
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
        <span className={`text-xs font-bold px-2 py-0.5 rounded ${
          isWin ? "bg-emerald-900/60 text-emerald-300" : "bg-red-900/60 text-red-300"
        }`}>
          {a.status}
        </span>
      </td>
    </tr>
  );
}

export default function AlertsPage() {
  const { data: scorecardData } = useQuery({
    queryKey: ["trade-scorecard"],
    queryFn:  () => hlSignals.getTradeAlertsScorecard(),
    refetchInterval: 60_000,
  });
  const { data: activeData } = useQuery({
    queryKey: ["trade-alerts-active"],
    queryFn:  () => hlSignals.getTradeAlertsActive(),
    refetchInterval: 30_000,
  });
  const { data: historyData } = useQuery({
    queryKey: ["trade-alerts-history"],
    queryFn:  () => hlSignals.getTradeAlertsHistory(30),
    refetchInterval: 60_000,
  });

  const [historyFilter, setHistoryFilter] = useState("all");

  const scorecard = scorecardData?.data ?? [];
  const active    = (activeData?.data  ?? []).filter(a => a.strategy in STRATEGY_SHORT);
  const history   = (historyData?.data ?? []).filter(a => a.strategy in STRATEGY_SHORT);

  const totalWins   = history.filter(a => a.status === "WIN").length;
  const totalLosses = history.filter(a => a.status === "LOSS").length;
  const totalDone   = totalWins + totalLosses;
  const overallWinPct = totalDone > 0 ? Math.round(totalWins / totalDone * 100) : null;

  const filteredHistory = historyFilter === "all"
    ? history
    : history.filter(a => a.strategy === historyFilter);

  const filteredWins   = filteredHistory.filter(a => a.status === "WIN").length;
  const filteredLosses = filteredHistory.filter(a => a.status === "LOSS").length;

  return (
    <div>
      {/* Sub-header */}
      <div className="border-b border-zinc-800 px-4 py-2 flex items-center gap-4 flex-wrap">
        <span className="text-zinc-100 font-bold text-sm tracking-widest">
          {active.length} <span className="text-zinc-500 font-normal text-xs">OPEN ALERTS</span>
        </span>
        {overallWinPct != null && (
          <span className={`text-xs font-bold px-2.5 py-1 rounded border ${
            overallWinPct >= 60
              ? "bg-emerald-500/10 border-emerald-500/50 text-emerald-400"
              : "bg-yellow-500/10 border-yellow-500/50 text-yellow-400"
          }`}>
            {overallWinPct}% WIN RATE · {totalWins}W {totalLosses}L
          </span>
        )}
      </div>

      <div className="p-4 space-y-6">

        {/* Strategy Scorecards */}
        <section>
          <div className="text-zinc-500 text-xs font-bold tracking-widest mb-3 uppercase">Strategy Performance</div>
          <ScorecardTable scorecard={scorecard} />
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
                    <th className="text-left  px-4 py-2.5">Strategy</th>
                    <th className="text-left  px-4 py-2.5">Coin</th>
                    <th className="text-left  px-4 py-2.5">Side</th>
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

        {/* Completed History */}
        <section>
          {/* Header + strategy filter chips */}
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            <div className="text-zinc-500 text-xs font-bold tracking-widest uppercase">
              Completed (30d) — {totalWins}W · {totalLosses}L
            </div>
            <div className="flex gap-1 ml-auto flex-wrap">
              {(["all", ...Object.keys(STRATEGY_SHORT)] as string[]).map(s => (
                <button
                  key={s}
                  onClick={() => setHistoryFilter(s)}
                  className={`text-xs px-2 py-0.5 rounded border transition-colors ${
                    historyFilter === s
                      ? (STRATEGY_COLOR[s]?.badge ?? "text-zinc-100 bg-zinc-700 border-zinc-500")
                      : "text-zinc-500 bg-transparent border-zinc-800 hover:border-zinc-600 hover:text-zinc-300"
                  }`}
                >
                  {s === "all" ? "All" : STRATEGY_SHORT[s]}
                </button>
              ))}
            </div>
          </div>

          {/* Coin-level breakdown */}
          <div className="mb-3">
            <div className="text-zinc-600 text-[10px] uppercase tracking-widest mb-1.5">
              By Coin
              {historyFilter !== "all" && ` · ${STRATEGY_SHORT[historyFilter]}`}
              {" "}— {filteredHistory.length} trades · {filteredWins}W {filteredLosses}L
            </div>
            <CoinStatsTable trades={filteredHistory} />
          </div>

          {/* Trade rows */}
          {filteredHistory.length === 0 ? (
            <p className="text-zinc-700 text-sm py-4">No completed alerts yet.</p>
          ) : (
            <div className="bg-[#0D1117] border border-zinc-800 rounded overflow-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-zinc-500 border-b border-zinc-800 text-xs uppercase tracking-widest">
                    <th className="text-left  px-4 py-2.5">Date</th>
                    <th className="text-left  px-4 py-2.5">Strategy</th>
                    <th className="text-left  px-4 py-2.5">Coin</th>
                    <th className="text-left  px-4 py-2.5">Side</th>
                    <th className="text-right px-4 py-2.5">Entry L:S</th>
                    <th className="text-right px-4 py-2.5">Entry</th>
                    <th className="text-right px-4 py-2.5">Exit</th>
                    <th className="text-right px-4 py-2.5">Return</th>
                    <th className="text-center px-4 py-2.5">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredHistory.map((a, i) => <HistoryRow key={i} a={a} />)}
                </tbody>
              </table>
            </div>
          )}
        </section>

      </div>
    </div>
  );
}
