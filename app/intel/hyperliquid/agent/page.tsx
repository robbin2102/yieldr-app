"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  hlSignals,
  type BotEnv,
  type BotPosition,
  type BotStrategySummary,
  type BotActivityEvent,
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

function fmtUsd(n: number | null | undefined) {
  if (n == null) return "—";
  return `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;
}

function fmtDateTime(ts: string | null | undefined) {
  if (!ts) return "—";
  const d = new Date(ts.endsWith("Z") ? ts : ts + "Z");
  const month = d.toLocaleString("en-US", { month: "short" });
  const day = d.getDate();
  const time = d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
  return `${month} ${day} · ${time}`;
}

function timeLeft(until: string | null) {
  if (!until) return "—";
  const diff = new Date(until.endsWith("Z") ? until : until + "Z").getTime() - Date.now();
  if (diff <= 0) return "expired";
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function timeAgo(ts: string | null) {
  if (!ts) return "—";
  const diff = Date.now() - new Date(ts.endsWith("Z") ? ts : ts + "Z").getTime();
  if (diff < 0) return "now";
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

const STRATEGY_COLOR: Record<string, string> = {
  WAKEUP_LS10_4H:           "text-violet-300 bg-violet-950/60 border-violet-800",
  WAKEUP_LS10:              "text-fuchsia-300 bg-fuchsia-950/60 border-fuchsia-800",
  WHALE_FLIP:               "text-orange-300 bg-orange-950/60 border-orange-800",
  WAKEUP_LS_LOW_24H:        "text-cyan-300 bg-cyan-950/60 border-cyan-800",
  WAKEUP_LS_LOW_SHORT_24H:  "text-sky-300 bg-sky-950/60 border-sky-800",
  WHALE_SCALEUP_4H:         "text-amber-300 bg-amber-950/60 border-amber-800",
};

const STRATEGY_SHORT: Record<string, string> = {
  WAKEUP_LS10_4H:           "WAKE 4h",
  WAKEUP_LS10:              "WAKE 24h",
  WHALE_FLIP:               "FLIP",
  WAKEUP_LS_LOW_24H:        "WAKE-LO 24h",
  WAKEUP_LS_LOW_SHORT_24H:  "WAKE-LO-S 24h",
  WHALE_SCALEUP_4H:         "SCALE 4h",
};

function strategyBadge(strategy: string) {
  const cls = STRATEGY_COLOR[strategy] ?? "text-zinc-400 bg-zinc-900 border-zinc-700";
  const label = STRATEGY_SHORT[strategy] ?? strategy;
  return (
    <span className={`text-xs font-bold px-1.5 py-0.5 rounded border ${cls}`}>
      {label}
    </span>
  );
}

const STATUS_COLOR: Record<string, string> = {
  OPEN:         "bg-emerald-900/60 text-emerald-300",
  PENDING:      "bg-zinc-800 text-zinc-400",
  PENDING_FILL: "bg-yellow-900/60 text-yellow-300",
  CLOSING:      "bg-yellow-900/60 text-yellow-300",
  CLOSED:       "bg-zinc-800 text-zinc-300",
  SKIPPED:      "bg-zinc-900 text-zinc-600",
  FAILED:       "bg-red-900/60 text-red-300",
};

// ── Summary cards ────────────────────────────────────────────────────────────
function SummaryCards({
  open, deployed, maxCapital, todayPnl, allTimePnl, winPct, wins, losses,
  signals24h, executed24h,
}: {
  open: number; deployed: number; maxCapital: number; todayPnl: number;
  allTimePnl: number; winPct: number | null; wins: number; losses: number;
  signals24h: number; executed24h: number;
}) {
  const cards = [
    { label: "OPEN POSITIONS", value: String(open) },
    { label: "CAPITAL DEPLOYED", value: `${fmtUsd(deployed)} / ${fmtUsd(maxCapital)}` },
    { label: "TODAY PNL", value: fmtUsd(todayPnl), color: todayPnl > 0 ? "text-emerald-400" : todayPnl < 0 ? "text-red-400" : undefined },
    { label: "ALL-TIME PNL", value: fmtUsd(allTimePnl), color: allTimePnl > 0 ? "text-emerald-400" : allTimePnl < 0 ? "text-red-400" : undefined },
    { label: "WIN RATE", value: winPct == null ? "—" : `${winPct}% (${wins}/${wins + losses})` },
    { label: "SIGNALS / EXEC (24h)", value: `${signals24h} / ${executed24h}` },
  ];
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
      {cards.map(c => (
        <div key={c.label} className="bg-[#0D1117] border border-zinc-800 rounded px-3 py-2.5">
          <div className="text-zinc-600 text-[10px] uppercase tracking-widest mb-1">{c.label}</div>
          <div className={`text-lg font-bold ${c.color ?? "text-zinc-100"}`}>{c.value}</div>
        </div>
      ))}
    </div>
  );
}

// ── Open positions table ──────────────────────────────────────────────────────
function OpenPositionsTable({ positions, onExit }: { positions: BotPosition[]; onExit: (id: string) => void }) {
  if (positions.length === 0) {
    return <p className="text-zinc-700 text-sm py-4">No open positions.</p>;
  }
  return (
    <div className="bg-[#0D1117] border border-zinc-800 rounded overflow-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-zinc-500 border-b border-zinc-800 text-xs uppercase tracking-widest">
            <th className="text-left  px-4 py-2.5">Coin</th>
            <th className="text-left  px-4 py-2.5">Side</th>
            <th className="text-left  px-4 py-2.5">Strategy</th>
            <th className="text-right px-4 py-2.5">Lev</th>
            <th className="text-right px-4 py-2.5">Entry</th>
            <th className="text-right px-4 py-2.5">Mark</th>
            <th className="text-right px-4 py-2.5">Size</th>
            <th className="text-right px-4 py-2.5">PnL</th>
            <th className="text-right px-4 py-2.5">Time Left</th>
            <th className="text-right px-4 py-2.5"></th>
          </tr>
        </thead>
        <tbody>
          {positions.map(p => {
            const isLong = p.side === "LONG";
            const retColor = p.live_return_pct == null ? "text-zinc-600"
              : p.live_return_pct > 0 ? "text-emerald-400" : "text-red-400";
            return (
              <tr key={p.id} className="border-b border-zinc-800/50 hover:bg-zinc-800/40">
                <td className="px-4 py-2">
                  <Link href={`/intel/hyperliquid/coin/${p.coin}`} className="text-sky-400 hover:text-orange-400 font-bold transition-colors">
                    {p.coin}
                  </Link>
                </td>
                <td className={`px-4 py-2 font-bold ${isLong ? "text-emerald-400" : "text-red-400"}`}>
                  {isLong ? "▲ LONG" : "▼ SHORT"}
                </td>
                <td className="px-4 py-2">{strategyBadge(p.strategy)}</td>
                <td className="px-4 py-2 text-right text-zinc-400">{p.leverage}x</td>
                <td className="px-4 py-2 text-right text-zinc-400">${fmtPx(p.entry_px)}</td>
                <td className="px-4 py-2 text-right text-zinc-300">${fmtPx(p.mark_px)}</td>
                <td className="px-4 py-2 text-right text-zinc-400">{fmtUsd(p.size_usdc)}</td>
                <td className={`px-4 py-2 text-right font-bold ${retColor}`}>
                  {p.live_return_pct == null ? "—" : `${fmtPct(p.live_return_pct)} (${fmtUsd(p.live_pnl_usdc)})`}
                </td>
                <td className="px-4 py-2 text-right text-zinc-500 text-xs">{timeLeft(p.hold_until)}</td>
                <td className="px-4 py-2 text-right">
                  <button
                    onClick={() => onExit(p.id)}
                    className="text-xs px-2 py-0.5 rounded border border-zinc-700 text-zinc-400 hover:border-red-700 hover:text-red-400 transition-colors"
                  >
                    Exit
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Strategy performance table ────────────────────────────────────────────────
function StrategyPerformanceTable({ rows }: { rows: BotStrategySummary[] }) {
  return (
    <div className="bg-[#0D1117] border border-zinc-800 rounded overflow-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-zinc-500 border-b border-zinc-800 text-xs uppercase tracking-widest">
            <th className="text-left  px-3 py-2.5">Strategy</th>
            <th className="text-center px-3 py-2.5">Hold</th>
            <th className="text-right px-3 py-2.5">Open</th>
            <th className="text-right px-3 py-2.5">Closed</th>
            <th className="text-right px-3 py-2.5">Win%</th>
            <th className="text-right px-3 py-2.5">Avg Ret</th>
            <th className="text-right px-3 py-2.5">Total PnL</th>
            <th className="text-right px-3 py-2.5">BT Win%</th>
            <th className="text-right px-3 py-2.5">BT Ret</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(s => (
            <tr key={s.strategy} className="border-b border-zinc-800/50 hover:bg-zinc-800/40">
              <td className="px-3 py-2">{strategyBadge(s.strategy)}</td>
              <td className="px-3 py-2 text-center text-zinc-400 text-xs">{s.hold_hours != null ? `${s.hold_hours}h` : "var"}</td>
              <td className="px-3 py-2 text-right text-zinc-400">{s.open}</td>
              <td className="px-3 py-2 text-right text-zinc-400">
                <span className="text-emerald-500">{s.wins}W</span>
                <span className="text-zinc-700"> / </span>
                <span className="text-red-500">{s.losses}L</span>
              </td>
              <td className={`px-3 py-2 text-right font-bold ${
                s.closed === 0 ? "text-zinc-600" : (s.win_pct ?? 0) >= 60 ? "text-emerald-400" : "text-yellow-400"
              }`}>
                {s.closed === 0 ? "—" : `${s.win_pct}%`}
              </td>
              <td className={`px-3 py-2 text-right ${
                s.avg_return_pct != null && s.avg_return_pct > 0 ? "text-emerald-400" : s.avg_return_pct != null ? "text-red-400" : "text-zinc-600"
              }`}>
                {fmtPct(s.avg_return_pct)}
              </td>
              <td className={`px-3 py-2 text-right font-bold ${
                s.total_pnl_usdc > 0 ? "text-emerald-400" : s.total_pnl_usdc < 0 ? "text-red-400" : "text-zinc-500"
              }`}>
                {fmtUsd(s.total_pnl_usdc)}
              </td>
              <td className="px-3 py-2 text-right text-zinc-500 text-xs">{s.backtest_win_pct != null ? `${s.backtest_win_pct}%` : "—"}</td>
              <td className="px-3 py-2 text-right text-zinc-500 text-xs">{fmtPct(s.backtest_return_pct)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Closed trades table ──────────────────────────────────────────────────────
function ClosedTradesTable({ positions }: { positions: BotPosition[] }) {
  if (positions.length === 0) {
    return <p className="text-zinc-700 text-sm py-4">No closed trades yet.</p>;
  }
  return (
    <div className="bg-[#0D1117] border border-zinc-800 rounded overflow-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-zinc-500 border-b border-zinc-800 text-xs uppercase tracking-widest">
            <th className="text-left  px-4 py-2.5">Coin</th>
            <th className="text-left  px-4 py-2.5">Strategy</th>
            <th className="text-left  px-4 py-2.5">Side</th>
            <th className="text-right px-4 py-2.5">Lev</th>
            <th className="text-right px-4 py-2.5">Entry</th>
            <th className="text-right px-4 py-2.5">Exit</th>
            <th className="text-right px-4 py-2.5">Return</th>
            <th className="text-right px-4 py-2.5">PnL</th>
            <th className="text-left  px-4 py-2.5">Reason</th>
            <th className="text-right px-4 py-2.5">Closed</th>
          </tr>
        </thead>
        <tbody>
          {positions.map(p => {
            const isLong = p.side === "LONG";
            const isWin = (p.pnl_usdc ?? 0) > 0;
            return (
              <tr key={p.id} className="border-b border-zinc-800/50 hover:bg-zinc-800/40">
                <td className="px-4 py-2">
                  <Link href={`/intel/hyperliquid/coin/${p.coin}`} className="text-sky-400 hover:text-orange-400 font-bold transition-colors">
                    {p.coin}
                  </Link>
                </td>
                <td className="px-4 py-2">{strategyBadge(p.strategy)}</td>
                <td className={`px-4 py-2 font-bold ${isLong ? "text-emerald-400" : "text-red-400"}`}>
                  {isLong ? "▲" : "▼"} {p.side}
                </td>
                <td className="px-4 py-2 text-right text-zinc-400">{p.leverage}x</td>
                <td className="px-4 py-2 text-right text-zinc-400">${fmtPx(p.entry_px)}</td>
                <td className="px-4 py-2 text-right text-zinc-400">${fmtPx(p.exit_px)}</td>
                <td className={`px-4 py-2 text-right font-bold ${isWin ? "text-emerald-400" : "text-red-400"}`}>
                  {fmtPct(p.return_pct)}
                </td>
                <td className={`px-4 py-2 text-right font-bold ${isWin ? "text-emerald-400" : "text-red-400"}`}>
                  {fmtUsd(p.pnl_usdc)}
                </td>
                <td className="px-4 py-2 text-zinc-500 text-xs">{p.exit_reason ?? "—"}</td>
                <td className="px-4 py-2 text-right text-zinc-600 text-xs">{fmtDateTime(p.exit_ts)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Activity feed ────────────────────────────────────────────────────────────
function ActivityFeed({ events }: { events: BotActivityEvent[] }) {
  if (events.length === 0) {
    return <p className="text-zinc-700 text-sm py-4">No activity yet.</p>;
  }
  return (
    <div className="bg-[#0D1117] border border-zinc-800 rounded overflow-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-zinc-500 border-b border-zinc-800 text-xs uppercase tracking-widest">
            <th className="text-left  px-4 py-2.5">Time</th>
            <th className="text-left  px-4 py-2.5">Strategy</th>
            <th className="text-left  px-4 py-2.5">Coin</th>
            <th className="text-left  px-4 py-2.5">Side</th>
            <th className="text-left  px-4 py-2.5">Action</th>
          </tr>
        </thead>
        <tbody>
          {events.map((e, i) => {
            const isLong = e.side === "LONG";
            const executed = e.action === "executed";
            return (
              <tr key={i} className="border-b border-zinc-800/50 hover:bg-zinc-800/40">
                <td className="px-4 py-2 text-zinc-500 text-xs">{fmtDateTime(e.ts)}</td>
                <td className="px-4 py-2">{strategyBadge(e.strategy)}</td>
                <td className="px-4 py-2">
                  <Link href={`/intel/hyperliquid/coin/${e.coin}`} className="text-sky-400 hover:text-orange-400 font-bold transition-colors">
                    {e.coin}
                  </Link>
                </td>
                <td className={`px-4 py-2 font-bold ${isLong ? "text-emerald-400" : "text-red-400"}`}>
                  {isLong ? "▲" : "▼"} {e.side}
                </td>
                <td className="px-4 py-2 text-xs">
                  {executed ? (
                    <span className={`font-bold px-2 py-0.5 rounded ${STATUS_COLOR[e.status ?? ""] ?? "bg-zinc-800 text-zinc-300"}`}>
                      EXECUTED → {e.status}
                    </span>
                  ) : (
                    <span className="text-zinc-600">SKIPPED — {e.skip_reason}</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Service health panel ─────────────────────────────────────────────────────
function fmtUptime(s: number) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function ServiceHealthPanel() {
  const { data, isError } = useQuery({
    queryKey: ["bot-health"],
    queryFn: () => hlSignals.getBotHealth(),
    refetchInterval: 15_000,
  });

  if (isError || !data) {
    return (
      <div className="bg-[#0D1117] border border-red-900/60 rounded px-4 py-3 text-red-400 text-sm">
        Service unreachable
      </div>
    );
  }

  const ws = data.ws_monitor;
  const issues = data.recent_issues ?? [];

  return (
    <div className="bg-[#0D1117] border border-zinc-800 rounded px-4 py-3 space-y-3">
      <div className="flex items-center gap-4 flex-wrap text-sm">
        <span className={`font-bold px-2 py-0.5 rounded text-xs ${
          data.status === "ok" ? "bg-emerald-900/60 text-emerald-300" : "bg-red-900/60 text-red-300"
        }`}>
          {data.status === "ok" ? "● RUNNING" : "● DEGRADED"}
        </span>
        <span className="text-zinc-500 text-xs">uptime {fmtUptime(data.uptime_s)}</span>
        <span className="text-zinc-500 text-xs">db: {data.db}</span>
        <span className="text-zinc-500 text-xs">bot: {data.bot_enabled ? "enabled" : "disabled"} ({data.bot_testnet ? "testnet" : "mainnet"})</span>
        {ws && (
          <span className={`text-xs font-bold px-2 py-0.5 rounded ${
            ws.connected ? "bg-emerald-900/60 text-emerald-300" : "bg-yellow-900/60 text-yellow-300"
          }`}>
            WS {ws.connected ? "LIVE" : "RECONNECTING"}{ws.reconnect_count > 0 ? ` · ${ws.reconnect_count} reconnects` : ""}
          </span>
        )}
      </div>

      {issues.length > 0 && (
        <div>
          <div className="text-zinc-600 text-[10px] uppercase tracking-widest mb-1.5">Recent Issues</div>
          <div className="space-y-1 max-h-40 overflow-auto">
            {issues.map((iss, i) => (
              <div key={i} className="text-xs flex gap-2">
                <span className="text-zinc-600 shrink-0">{timeAgo(iss.ts)}</span>
                <span className={`shrink-0 font-bold ${iss.level === "ERROR" ? "text-red-400" : "text-yellow-400"}`}>
                  {iss.level}
                </span>
                <span className="text-zinc-500 truncate">{iss.logger}: {iss.message}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function AgentPage() {
  const [env, setEnv] = useState<BotEnv>("testnet");

  const { data: summaryData } = useQuery({
    queryKey: ["bot-summary", env],
    queryFn: () => hlSignals.getBotSummary(env),
    refetchInterval: 30_000,
  });
  const { data: openData, refetch: refetchOpen } = useQuery({
    queryKey: ["bot-positions-open", env],
    queryFn: () => hlSignals.getBotPositions("OPEN", env),
    refetchInterval: 15_000,
  });
  const { data: closedData } = useQuery({
    queryKey: ["bot-positions-closed", env],
    queryFn: () => hlSignals.getBotPositions("CLOSED", env),
    refetchInterval: 60_000,
  });
  const { data: strategyData } = useQuery({
    queryKey: ["bot-strategy-summary", env],
    queryFn: () => hlSignals.getBotStrategySummary(env),
    refetchInterval: 60_000,
  });
  const { data: activityData } = useQuery({
    queryKey: ["bot-activity", env],
    queryFn: () => hlSignals.getBotActivity(30, env),
    refetchInterval: 30_000,
  });

  const summary = summaryData;
  const open = openData?.data ?? [];
  const closed = closedData?.data ?? [];
  const strategies = strategyData?.data ?? [];
  const activity = activityData?.data ?? [];

  const winPct = summary && summary.all_time_closed > 0
    ? Math.round(summary.all_time_wins / summary.all_time_closed * 100)
    : null;

  const since24h = Date.now() - 24 * 3_600_000;
  const recent24h = activity.filter(e => new Date(e.ts.endsWith("Z") ? e.ts : e.ts + "Z").getTime() >= since24h);
  const executed24h = recent24h.filter(e => e.action === "executed").length;

  const handleExit = async (id: string) => {
    await hlSignals.botExit(id);
    refetchOpen();
  };

  return (
    <div>
      <div className="border-b border-zinc-800 px-4 py-2 flex items-center gap-4 flex-wrap">
        <span className="text-zinc-100 font-bold text-sm tracking-widest">AGENT</span>
        <div className="flex gap-1 ml-auto">
          {(["testnet", "mainnet"] as BotEnv[]).map(e => (
            <button
              key={e}
              onClick={() => setEnv(e)}
              className={`text-xs px-2.5 py-1 rounded border font-bold uppercase tracking-widest transition-colors ${
                env === e
                  ? "text-orange-400 bg-orange-950/40 border-orange-800"
                  : "text-zinc-500 bg-transparent border-zinc-800 hover:border-zinc-600 hover:text-zinc-300"
              }`}
            >
              {e}
            </button>
          ))}
        </div>
      </div>

      <div className="p-4 space-y-6">
        <SummaryCards
          open={summary?.open_positions ?? 0}
          deployed={summary?.capital_deployed_usdc ?? 0}
          maxCapital={summary?.max_capital_usdc ?? 0}
          todayPnl={summary?.today.pnl_usdc ?? 0}
          allTimePnl={summary?.all_time_pnl_usdc ?? 0}
          winPct={winPct}
          wins={summary?.all_time_wins ?? 0}
          losses={(summary?.all_time_closed ?? 0) - (summary?.all_time_wins ?? 0)}
          signals24h={recent24h.length}
          executed24h={executed24h}
        />

        <section>
          <div className="text-zinc-500 text-xs font-bold tracking-widest mb-2 uppercase">
            Open Positions ({open.length})
          </div>
          <OpenPositionsTable positions={open} onExit={handleExit} />
        </section>

        <section>
          <div className="text-zinc-500 text-xs font-bold tracking-widest mb-2 uppercase">
            Strategy Performance
          </div>
          <StrategyPerformanceTable rows={strategies} />
        </section>

        <section>
          <div className="text-zinc-500 text-xs font-bold tracking-widest mb-2 uppercase">
            Closed Trades ({closed.length})
          </div>
          <ClosedTradesTable positions={closed} />
        </section>

        <section>
          <div className="text-zinc-500 text-xs font-bold tracking-widest mb-2 uppercase">
            Activity Feed
          </div>
          <ActivityFeed events={activity} />
        </section>

        <section>
          <div className="text-zinc-500 text-xs font-bold tracking-widest mb-2 uppercase">
            Service Status
          </div>
          <ServiceHealthPanel />
        </section>
      </div>
    </div>
  );
}
