'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

// ── Types ─────────────────────────────────────────────────────────────────────

interface TraderRow {
  wallet: string;
  label: string;
  tTotal: number;
  bPnl: number;
  traderROCE: number;
  botROCE: number;
  tAct24h: number;
  bAct24h: number;
  edgeScore: number | null;
  edgeConfidence: string | null;
  detected: number;
  filled: number;
  execSkipRate: number;
  missedPnl: number;
  actionCode: string;
  failureType: 'EXEC_FAIL' | 'TRADER_FAIL' | 'NONE';
  reason: string;
  spentUsdc: number;
  allocationUsdc: number;
  active: boolean;
}

interface SystemStats {
  totalTraders: number;
  activeTraders: number;
  totalDetected: number;
  totalFilled: number;
  fillRate: number;
  totalMissedPnl: number;
  totalBotPnl: number;
  aggSkipCounts: Record<string, number>;
}

interface ActivityItem {
  _id: string;
  traderLabel: string;
  title: string;
  outcome: string;
  side: 'BUY' | 'SELL';
  traderBetUsdc: number;
  copyBetUsdc: number;
  status: string;
  skipReason: string | null;
  createdAt: string;
  filledUsdc: number | null;
  totalLatencyMs: number | null;
}

interface OpenPosition {
  title: string;
  outcome: string;
  traderLabel: string;
  sourceWallet: string;
  avgFillPrice: number;
  totalFilledUsdc: number;
  totalFilledSize: number;
  tradeCount: number;
  lastFilled: number | null;
  curPrice: number | null;
  traderStillIn: boolean;
  traderSize: number | null;
  estimatedPnl: number | null;
}

interface PositionSummary {
  totalPositions: number;
  totalDeployed: number;
  traderExitedCount: number;
  estimatedPnl: number | null;
  pipelineAge: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const ACTION_COLORS: Record<string, string> = {
  HARD_STOP:    '#FF4757',
  SOFT_STOP:    '#FF6B6B',
  SCALE_DOWN:   '#FF8C00',
  SCALE_UP:     '#00C805',
  CONTINUE:     '#00C805',
  HOLD:         '#9E9E9E',
  WATCH:        '#FFD000',
  EXEC_FAIL:    '#6BA3F5',
  FIX_ENTRY:    '#6BA3F5',
  INCREASE_ALLOC: '#6BA3F5',
};

function actionColor(code: string): string {
  if (!code) return '#9E9E9E';
  for (const [key, color] of Object.entries(ACTION_COLORS)) {
    if (code.toUpperCase().includes(key)) return color;
  }
  return '#9E9E9E';
}

function statusColor(s: string): string {
  switch (s) {
    case 'FILLED':    return '#00C805';
    case 'SKIPPED':   return '#6E6E6E';
    case 'FAILED':    return '#FF4757';
    case 'EXECUTING': return '#FFD000';
    case 'PARTIAL':   return '#FF8C00';
    default:          return '#9E9E9E';
  }
}

function fmt$(n: number, decimals = 0): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1000) return `${sign}$${(abs / 1000).toFixed(1)}k`;
  return `${sign}$${abs.toFixed(decimals)}`;
}

function fmtPct(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60)    return `${s}s`;
  if (s < 3600)  return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function skipLabel(code: string | null): string {
  if (!code) return '';
  const m: Record<string, string> = {
    BELOW_AVG: 'below avg', ALLOCATION_FULL: 'alloc', POSITION_CAP_FULL: 'pos cap',
    NO_ORDERBOOK: 'no book', SELL_NO_POSITION: 'no pos', DUPLICATE: 'dup',
    ORDER_FAILED: 'fail', NON_TRADE: 'non-trade', WIDE_SPREAD: 'spread',
    PRICEDRIFT_FAILED: 'drift', GROUPED_BELOW_AVG: 'grouped',
  };
  return m[code] ?? code.toLowerCase();
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function BotDashboard() {
  const [traders,      setTraders]      = useState<TraderRow[]>([]);
  const [systemStats,  setSystemStats]  = useState<SystemStats | null>(null);
  const [activity,     setActivity]     = useState<ActivityItem[]>([]);
  const [positions,    setPositions]    = useState<OpenPosition[]>([]);
  const [posSummary,   setPosSummary]   = useState<PositionSummary | null>(null);
  const [loading,      setLoading]      = useState(true);
  const [lastUpdated,  setLastUpdated]  = useState<Date | null>(null);

  async function fetchAll() {
    try {
      const [statsRes, actRes, posRes] = await Promise.all([
        fetch('/api/copy-trading/bot-stats'),
        fetch('/api/copy-trading/activity'),
        fetch('/api/copy-trading/open-positions'),
      ]);
      const [statsData, actData, posData] = await Promise.all([
        statsRes.json(), actRes.json(), posRes.json(),
      ]);
      if (statsData.success) { setTraders(statsData.traders); setSystemStats(statsData.systemStats); }
      if (actData.success)   setActivity(actData.activity);
      if (posData.success)   { setPositions(posData.positions); setPosSummary(posData.summary); }
      setLastUpdated(new Date());
    } catch (e) { console.error('fetch error', e); }
    finally { setLoading(false); }
  }

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, 60_000);
    return () => clearInterval(interval);
  }, []);

  // ── skip breakdown ────────────────────────────────────────────────────────
  const execSkipNames = ['ALLOCATION_FULL','POSITION_CAP_FULL','NO_ORDERBOOK',
    'SELL_NO_POSITION','DUPLICATE','ORDER_FAILED','NON_TRADE','WIDE_SPREAD','PRICEDRIFT_FAILED'];
  const aggSkip     = systemStats?.aggSkipCounts ?? {};
  const belowAvg    = (aggSkip['BELOW_AVG'] ?? 0) + (aggSkip['GROUPED_BELOW_AVG'] ?? 0);
  const execSkips   = execSkipNames.reduce((s, k) => s + (aggSkip[k] ?? 0), 0);
  const totalFilled = systemStats?.totalFilled ?? 0;
  const execBase    = totalFilled + execSkips;
  const topExecSkips = execSkipNames
    .map(k => ({ k, n: aggSkip[k] ?? 0 }))
    .filter(x => x.n > 0)
    .sort((a, b) => b.n - a.n)
    .slice(0, 5);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 font-mono text-[#6E6E6E]">
        LOADING...
      </div>
    );
  }

  return (
    <div className="space-y-4 font-mono">

      {/* ── System Status Strip ── */}
      <div className="grid grid-cols-6 gap-2">
        {[
          { label: 'TRADERS',    value: `${systemStats?.activeTraders ?? 0} active` },
          { label: 'DET/FILL',   value: `${systemStats?.totalFilled ?? 0}/${systemStats?.totalDetected ?? 0}` },
          { label: 'FILL RATE',  value: `${((systemStats?.fillRate ?? 0) * 100).toFixed(0)}%` },
          { label: 'BOT PnL',    value: fmt$(systemStats?.totalBotPnl ?? 0, 2),
            color: (systemStats?.totalBotPnl ?? 0) >= 0 ? '#00C805' : '#FF4757' },
          { label: 'MISSED',     value: fmt$(systemStats?.totalMissedPnl ?? 0, 2),
            color: (systemStats?.totalMissedPnl ?? 0) > 0 ? '#FF4757' : '#6E6E6E' },
          { label: 'UPDATED',    value: lastUpdated ? timeAgo(lastUpdated.toISOString()) : '—' },
        ].map(({ label, value, color }) => (
          <div key={label} className="bg-[#0A0A0A] border border-[#1A1A1A] rounded px-3 py-2">
            <div className="text-[9px] text-[#6E6E6E] tracking-widest mb-1">{label}</div>
            <div className="text-sm font-bold" style={{ color: color ?? '#E0E0E0' }}>{value}</div>
          </div>
        ))}
      </div>

      {/* ── Trader Summary Table ── */}
      <div className="bg-[#0A0A0A] border border-[#1A1A1A] rounded overflow-hidden">
        <div className="px-4 py-2 border-b border-[#1A1A1A] flex items-center justify-between">
          <span className="text-[10px] text-[#00C805] tracking-widest font-bold">TRADER SUMMARY</span>
          <span className="text-[10px] text-[#6E6E6E]">{traders.length} tracked</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-[#1A1A1A]">
                {['Trader','T.PnL','B.PnL','tROCE','bROCE','T.Act','B.Act','Det/Fill','Edge','Missed','Alloc','Action'].map(h => (
                  <th key={h} className="px-2 py-1.5 text-left text-[10px] text-[#6E6E6E] tracking-wider whitespace-nowrap font-normal">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {traders.length === 0 && (
                <tr><td colSpan={12} className="px-4 py-6 text-center text-[#6E6E6E] text-xs">
                  No allocation data yet
                </td></tr>
              )}
              {traders.map(t => {
                const aColor  = actionColor(t.actionCode);
                const bPnlClr = t.bPnl    >= 0 ? '#00C805' : '#FF4757';
                const tPnlClr = t.tTotal  >= 0 ? '#00C805' : '#FF4757';
                return (
                  <tr key={t.wallet} className="border-b border-[#0F0F0F] hover:bg-[#111] transition-colors">
                    {/* Trader (clickable) */}
                    <td className="px-2 py-1.5 whitespace-nowrap">
                      <Link href={`/copy-trading/bot/${t.wallet}`} className="flex items-center gap-1.5 hover:text-white group">
                        <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${t.active ? 'bg-[#00C805]' : 'bg-[#FF4757]'}`} />
                        <span className="text-[#E0E0E0] group-hover:text-[#00C805] transition-colors font-medium">{t.label}</span>
                      </Link>
                    </td>
                    {/* T.PnL */}
                    <td className="px-2 py-1.5 font-bold" style={{ color: tPnlClr }}>
                      {fmt$(t.tTotal, 2)}
                    </td>
                    {/* B.PnL */}
                    <td className="px-2 py-1.5 font-bold" style={{ color: bPnlClr }}>
                      {fmt$(t.bPnl, 2)}
                    </td>
                    {/* tROCE */}
                    <td className="px-2 py-1.5" style={{ color: t.traderROCE >= 0 ? '#00C805' : '#FF4757' }}>
                      {fmtPct(t.traderROCE)}
                    </td>
                    {/* bROCE */}
                    <td className="px-2 py-1.5" style={{ color: t.botROCE >= 0 ? '#00C805' : '#FF4757' }}>
                      {fmtPct(t.botROCE)}
                    </td>
                    {/* T.Act */}
                    <td className="px-2 py-1.5 text-[#9E9E9E]">{t.tAct24h}</td>
                    {/* B.Act */}
                    <td className="px-2 py-1.5 text-[#9E9E9E]">{t.bAct24h}</td>
                    {/* Det/Fill */}
                    <td className="px-2 py-1.5 text-[#9E9E9E] whitespace-nowrap">
                      {t.detected > 0 ? `${t.filled}/${t.detected}` : '—'}
                      {t.execSkipRate > 0.3 && (
                        <span className="ml-1 text-[#FF8C00]">
                          ({(t.execSkipRate * 100).toFixed(0)}%)
                        </span>
                      )}
                    </td>
                    {/* Edge */}
                    <td className="px-2 py-1.5 text-[#9E9E9E]">
                      {t.edgeScore != null ? t.edgeScore.toFixed(3) : '—'}
                      {t.edgeConfidence === 'confirmed' && (
                        <span className="ml-0.5 text-[8px] text-[#00C805]">✓</span>
                      )}
                    </td>
                    {/* Missed */}
                    <td className="px-2 py-1.5" style={{ color: t.missedPnl > 0 ? '#FF8C00' : '#6E6E6E' }}>
                      {t.missedPnl > 0 ? fmt$(t.missedPnl, 2) : '—'}
                    </td>
                    {/* Alloc */}
                    <td className="px-2 py-1.5 text-[#9E9E9E] whitespace-nowrap">
                      {fmt$(t.spentUsdc)}<span className="text-[#444]">/</span>{fmt$(t.allocationUsdc)}
                    </td>
                    {/* Action */}
                    <td className="px-2 py-1.5 whitespace-nowrap">
                      <span className="font-bold text-[10px]" style={{ color: aColor }}>
                        {t.actionCode || '—'}
                      </span>
                      {t.failureType !== 'NONE' && (
                        <span className="ml-1 text-[9px] text-[#6BA3F5]">
                          [{t.failureType === 'EXEC_FAIL' ? 'EXC' : 'TRD'}]
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Exec Health (compact) + Open Positions Summary ── */}
      <div className="grid grid-cols-2 gap-4">

        {/* Exec health */}
        <div className="bg-[#0A0A0A] border border-[#1A1A1A] rounded overflow-hidden">
          <div className="px-4 py-2 border-b border-[#1A1A1A]">
            <span className="text-[10px] text-[#00C805] tracking-widest font-bold">EXECUTION HEALTH</span>
          </div>
          <div className="p-4 space-y-2">
            <div className="flex justify-between text-xs">
              <span className="text-[#9E9E9E]">Exec gate fill</span>
              <span className="text-[#E0E0E0] font-mono">
                {execBase > 0
                  ? `${((totalFilled / execBase) * 100).toFixed(1)}%`
                  : '—'}
                <span className="text-[#6E6E6E] ml-2 text-[11px]">
                  {totalFilled} filled / {execSkips} exec-skipped / {belowAvg} conviction-filtered
                </span>
              </span>
            </div>
            {topExecSkips.length > 0 && (
              <div className="border-t border-[#1A1A1A] pt-2 space-y-1">
                {topExecSkips.map(({ k, n }) => (
                  <div key={k} className="flex justify-between text-[11px]">
                    <span className="text-[#6E6E6E]">{skipLabel(k)}</span>
                    <span className="text-[#9E9E9E]">{n}</span>
                  </div>
                ))}
              </div>
            )}
            {topExecSkips.length === 0 && (
              <div className="text-[11px] text-[#6E6E6E]">No execution failures</div>
            )}
          </div>
        </div>

        {/* Portfolio summary */}
        <div className="bg-[#0A0A0A] border border-[#1A1A1A] rounded overflow-hidden">
          <div className="px-4 py-2 border-b border-[#1A1A1A] flex items-center justify-between">
            <span className="text-[10px] text-[#00C805] tracking-widest font-bold">BOT PORTFOLIO</span>
            {posSummary?.pipelineAge && (
              <span className="text-[10px] text-[#6E6E6E]">
                pipeline {timeAgo(posSummary.pipelineAge)}
              </span>
            )}
          </div>
          <div className="p-4 grid grid-cols-2 gap-3">
            {[
              { label: 'Positions',    value: String(posSummary?.totalPositions ?? 0) },
              { label: 'Deployed',     value: fmt$(posSummary?.totalDeployed ?? 0) },
              { label: 'Est. PnL',     value: posSummary?.estimatedPnl != null
                  ? fmt$(posSummary.estimatedPnl, 2)
                  : '—',
                color: (posSummary?.estimatedPnl ?? 0) >= 0 ? '#00C805' : '#FF4757' },
              { label: 'Trader Exited', value: String(posSummary?.traderExitedCount ?? 0),
                color: (posSummary?.traderExitedCount ?? 0) > 0 ? '#FF8C00' : '#6E6E6E' },
            ].map(({ label, value, color }) => (
              <div key={label}>
                <div className="text-[10px] text-[#6E6E6E] mb-0.5">{label}</div>
                <div className="text-sm font-bold" style={{ color: color ?? '#E0E0E0' }}>{value}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Open Positions Table ── */}
      {positions.length > 0 && (
        <div className="bg-[#0A0A0A] border border-[#1A1A1A] rounded overflow-hidden">
          <div className="px-4 py-2 border-b border-[#1A1A1A]">
            <span className="text-[10px] text-[#00C805] tracking-widest font-bold">OPEN POSITIONS</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-[#1A1A1A]">
                  {['Market','Out','Trader','B.Entry','Deployed','Cur Price','Est PnL','Trader'].map(h => (
                    <th key={h} className="px-2 py-1.5 text-left text-[10px] text-[#6E6E6E] tracking-wider whitespace-nowrap font-normal">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {positions.map((p, i) => (
                  <tr key={i}
                    className={`border-b border-[#0F0F0F] hover:bg-[#111] transition-colors ${
                      !p.traderStillIn ? 'bg-[#FF8C00]/5' : ''
                    }`}>
                    <td className="px-2 py-1.5 max-w-[220px] truncate text-[#E0E0E0]">{p.title}</td>
                    <td className="px-2 py-1.5">
                      <span className={`font-bold ${p.outcome?.toLowerCase() === 'yes' ? 'text-[#00C805]' : 'text-[#FF4757]'}`}>
                        {p.outcome?.toUpperCase()}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 text-[#9E9E9E]">{p.traderLabel}</td>
                    <td className="px-2 py-1.5 text-[#9E9E9E]">{p.avgFillPrice.toFixed(3)}</td>
                    <td className="px-2 py-1.5 text-[#9E9E9E]">{fmt$(p.totalFilledUsdc)}</td>
                    <td className="px-2 py-1.5 text-[#9E9E9E]">
                      {p.curPrice != null ? p.curPrice.toFixed(3) : '—'}
                    </td>
                    <td className="px-2 py-1.5 font-bold"
                      style={{ color: (p.estimatedPnl ?? 0) >= 0 ? '#00C805' : '#FF4757' }}>
                      {p.estimatedPnl != null ? fmt$(p.estimatedPnl, 2) : '—'}
                    </td>
                    {/* Trader still in */}
                    <td className="px-2 py-1.5">
                      {p.traderStillIn
                        ? <span className="text-[10px] text-[#00C805]">HOLDING</span>
                        : <span className="text-[10px] font-bold text-[#FF8C00]">EXITED</span>
                      }
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Live Activity Log ── */}
      <div className="bg-[#0A0A0A] border border-[#1A1A1A] rounded overflow-hidden">
        <div className="px-4 py-2 border-b border-[#1A1A1A] flex items-center justify-between">
          <span className="text-[10px] text-[#00C805] tracking-widest font-bold">LIVE ACTIVITY</span>
          <span className="text-[10px] text-[#6E6E6E]">last {activity.length}</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-[#1A1A1A]">
                {['Time','Trader','Market','Dir','Trader $','Bot $','Status','Note'].map(h => (
                  <th key={h} className="px-2 py-1.5 text-left text-[10px] text-[#6E6E6E] tracking-wider font-normal whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {activity.length === 0 && (
                <tr><td colSpan={8} className="px-4 py-6 text-center text-[#6E6E6E] text-xs">
                  No activity logged yet
                </td></tr>
              )}
              {activity.map(a => (
                <tr key={a._id} className="border-b border-[#0F0F0F] hover:bg-[#111] transition-colors">
                  <td className="px-2 py-1.5 text-[#6E6E6E] whitespace-nowrap">{timeAgo(a.createdAt)}</td>
                  <td className="px-2 py-1.5 text-[#9E9E9E] whitespace-nowrap">{a.traderLabel}</td>
                  <td className="px-2 py-1.5 text-[#E0E0E0] max-w-[240px] truncate">{a.title || '—'}</td>
                  <td className="px-2 py-1.5 whitespace-nowrap">
                    <span className={`font-bold ${a.outcome?.toLowerCase() === 'yes' ? 'text-[#00C805]' : 'text-[#FF4757]'}`}>
                      {a.outcome?.toUpperCase()}
                    </span>
                    <span className="ml-1 text-[#6E6E6E]">{a.side}</span>
                  </td>
                  <td className="px-2 py-1.5 text-[#9E9E9E]">{fmt$(a.traderBetUsdc)}</td>
                  <td className="px-2 py-1.5 text-[#9E9E9E]">
                    {a.status === 'FILLED' && a.filledUsdc != null ? fmt$(a.filledUsdc) : a.copyBetUsdc > 0 ? fmt$(a.copyBetUsdc) : '—'}
                  </td>
                  <td className="px-2 py-1.5">
                    <span className="font-bold text-[10px]" style={{ color: statusColor(a.status) }}>{a.status}</span>
                  </td>
                  <td className="px-2 py-1.5 text-[#6E6E6E] text-[10px]">
                    {a.skipReason ? skipLabel(a.skipReason) : ''}
                    {a.totalLatencyMs != null && a.status === 'FILLED' ? `${(a.totalLatencyMs / 1000).toFixed(1)}s` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

    </div>
  );
}
