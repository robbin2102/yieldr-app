'use client';

import { useEffect, useState } from 'react';

// ── Types ─────────────────────────────────────────────────────────────────────

interface TraderRow {
  wallet: string;
  label: string;
  runAt: string;
  tBought: number;
  tRealized: number;
  tOpenVal: number;
  tTotal: number;
  bCost: number;
  bPnl: number;
  traderROCE: number;
  botROCE: number;
  edgeScore: number | null;
  edgeSpecialty: string | null;
  edgeConfidence: string | null;
  detected: number;
  filled: number;
  execSkipRate: number;
  belowAvgRate: number;
  skipCounts: Record<string, number>;
  missedPnl: number;
  action: string;
  actionCode: string;
  failureType: 'EXEC_FAIL' | 'TRADER_FAIL' | 'NONE';
  reason: string;
  allocBefore: number;
  allocAfter: number | null;
  positionCap: number;
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
  skipDetail: string | null;
  createdAt: string;
  filledUsdc: number | null;
  avgFillPrice: number | null;
  totalLatencyMs: number | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const ACTION_COLORS: Record<string, string> = {
  HARD_STOP:    '#FF4757',
  SOFT_STOP:    '#FF6B6B',
  SCALE_DOWN:   '#FF8C00',
  SCALE_DOWN_L1:'#FF8C00',
  SCALE_DOWN_L2:'#FF8C00',
  SCALE_UP:     '#00C805',
  SCALE_UP_L1:  '#00C805',
  SCALE_UP_L2:  '#00C805',
  HOLD:         '#9E9E9E',
  WATCH:        '#FFD000',
  EXEC_FAIL:    '#6BA3F5',
  NEW:          '#00C805',
};

function actionColor(code: string): string {
  if (!code) return '#9E9E9E';
  for (const [key, color] of Object.entries(ACTION_COLORS)) {
    if (code.toUpperCase().includes(key)) return color;
  }
  return '#9E9E9E';
}

function statusColor(status: string): string {
  switch (status) {
    case 'FILLED':    return '#00C805';
    case 'SKIPPED':   return '#6E6E6E';
    case 'FAILED':    return '#FF4757';
    case 'EXECUTING': return '#FFD000';
    case 'PARTIAL':   return '#FF8C00';
    default:          return '#9E9E9E';
  }
}

function fmt$(n: number): string {
  if (Math.abs(n) >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

function fmtPct(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
}

function fmtFill(detected: number, filled: number): string {
  if (detected === 0) return '—';
  return `${filled}/${detected}`;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function skipLabel(code: string | null): string {
  if (!code) return '';
  const labels: Record<string, string> = {
    BELOW_AVG:         'below avg',
    ALLOCATION_FULL:   'alloc full',
    POSITION_CAP_FULL: 'pos cap',
    NO_ORDERBOOK:      'no book',
    SELL_NO_POSITION:  'no pos',
    DUPLICATE:         'dup',
    ORDER_FAILED:      'order fail',
    NON_TRADE:         'non-trade',
    WIDE_SPREAD:       'spread',
    PRICEDRIFT_FAILED: 'drift',
    GROUPED_BELOW_AVG: 'grouped',
  };
  return labels[code] ?? code.toLowerCase();
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function BotDashboard() {
  const [traders, setTraders] = useState<TraderRow[]>([]);
  const [systemStats, setSystemStats] = useState<SystemStats | null>(null);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  async function fetchAll() {
    try {
      const [statsRes, actRes] = await Promise.all([
        fetch('/api/copy-trading/bot-stats'),
        fetch('/api/copy-trading/activity'),
      ]);
      const statsData = await statsRes.json();
      const actData   = await actRes.json();

      if (statsData.success) {
        setTraders(statsData.traders);
        setSystemStats(statsData.systemStats);
      }
      if (actData.success) {
        setActivity(actData.activity);
      }
      setLastUpdated(new Date());
    } catch (e) {
      console.error('fetch error', e);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, 60_000);
    return () => clearInterval(interval);
  }, []);

  // ── Exec health: non-below-avg skips only (exec gate failures)
  const execSkipNames = ['ALLOCATION_FULL', 'POSITION_CAP_FULL', 'NO_ORDERBOOK',
    'SELL_NO_POSITION', 'DUPLICATE', 'ORDER_FAILED', 'NON_TRADE', 'WIDE_SPREAD', 'PRICEDRIFT_FAILED'];
  const aggSkip = systemStats?.aggSkipCounts ?? {};
  const belowAvg   = (aggSkip['BELOW_AVG'] ?? 0) + (aggSkip['GROUPED_BELOW_AVG'] ?? 0);
  const execSkips  = execSkipNames.reduce((s, k) => s + (aggSkip[k] ?? 0), 0);
  const totalFilled = systemStats?.totalFilled ?? 0;
  const totalDet    = systemStats?.totalDetected ?? 0;
  const execBase    = totalFilled + execSkips;

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
      <div className="grid grid-cols-7 gap-2">
        {[
          { label: 'TRADERS',    value: `${systemStats?.activeTraders ?? 0}/${systemStats?.totalTraders ?? 0}` },
          { label: 'DETECTED',   value: String(systemStats?.totalDetected ?? 0) },
          { label: 'FILLED',     value: String(systemStats?.totalFilled ?? 0) },
          { label: 'FILL RATE',  value: `${((systemStats?.fillRate ?? 0) * 100).toFixed(0)}%` },
          { label: 'BOT PnL',    value: fmt$(systemStats?.totalBotPnl ?? 0),
            color: (systemStats?.totalBotPnl ?? 0) >= 0 ? '#00C805' : '#FF4757' },
          { label: 'MISSED PnL', value: fmt$(systemStats?.totalMissedPnl ?? 0),
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
          <span className="text-[10px] text-[#6E6E6E]">{traders.length} traders</span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-[#1A1A1A]">
                {['Trader','T.Bought','T.OpenVal','T.Realized','T.Total',
                  'Det/Fill','B.Cost','B.PnL','tROCE','bROCE',
                  'Edge','Missed','Alloc','Action'].map(h => (
                  <th key={h}
                    className="px-2 py-1.5 text-left text-[10px] text-[#6E6E6E] tracking-wider whitespace-nowrap font-normal">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {traders.length === 0 && (
                <tr>
                  <td colSpan={14} className="px-4 py-6 text-center text-[#6E6E6E] text-xs">
                    No allocation data yet — run analyze-allocations.ts
                  </td>
                </tr>
              )}
              {traders.map(t => {
                const aColor = actionColor(t.actionCode);
                const bPnlColor = t.bPnl >= 0 ? '#00C805' : '#FF4757';
                const tTotalColor = t.tTotal >= 0 ? '#00C805' : '#FF4757';
                const detFill = fmtFill(t.detected, t.filled);
                return (
                  <tr key={t.wallet}
                    className="border-b border-[#0F0F0F] hover:bg-[#111] transition-colors">
                    {/* Trader */}
                    <td className="px-2 py-1.5 whitespace-nowrap">
                      <div className="flex items-center gap-1.5">
                        <div className={`w-1.5 h-1.5 rounded-full ${t.active ? 'bg-[#00C805]' : 'bg-[#FF4757]'}`} />
                        <span className="text-[#E0E0E0] font-medium">{t.label}</span>
                      </div>
                    </td>
                    {/* T.Bought */}
                    <td className="px-2 py-1.5 text-[#9E9E9E]">{fmt$(t.tBought)}</td>
                    {/* T.OpenVal */}
                    <td className="px-2 py-1.5 text-[#9E9E9E]">{fmt$(t.tOpenVal)}</td>
                    {/* T.Realized */}
                    <td className="px-2 py-1.5"
                      style={{ color: t.tRealized >= 0 ? '#00C805' : '#FF4757' }}>
                      {fmt$(t.tRealized)}
                    </td>
                    {/* T.Total */}
                    <td className="px-2 py-1.5 font-bold" style={{ color: tTotalColor }}>
                      {fmt$(t.tTotal)}
                    </td>
                    {/* Det/Fill */}
                    <td className="px-2 py-1.5 text-[#9E9E9E] whitespace-nowrap">
                      {detFill}
                      {t.execSkipRate > 0 && (
                        <span className="ml-1 text-[#FF8C00]">
                          ({(t.execSkipRate * 100).toFixed(0)}%)
                        </span>
                      )}
                    </td>
                    {/* B.Cost */}
                    <td className="px-2 py-1.5 text-[#9E9E9E]">{fmt$(t.bCost)}</td>
                    {/* B.PnL */}
                    <td className="px-2 py-1.5 font-bold" style={{ color: bPnlColor }}>
                      {fmt$(t.bPnl)}
                    </td>
                    {/* tROCE */}
                    <td className="px-2 py-1.5"
                      style={{ color: t.traderROCE >= 0 ? '#00C805' : '#FF4757' }}>
                      {fmtPct(t.traderROCE)}
                    </td>
                    {/* bROCE */}
                    <td className="px-2 py-1.5"
                      style={{ color: t.botROCE >= 0 ? '#00C805' : '#FF4757' }}>
                      {fmtPct(t.botROCE)}
                    </td>
                    {/* Edge */}
                    <td className="px-2 py-1.5 text-[#9E9E9E]">
                      {t.edgeScore != null ? t.edgeScore.toFixed(3) : '—'}
                      {t.edgeConfidence === 'confirmed' && (
                        <span className="ml-1 text-[8px] text-[#00C805]">✓</span>
                      )}
                    </td>
                    {/* Missed PnL */}
                    <td className="px-2 py-1.5"
                      style={{ color: t.missedPnl > 0 ? '#FF8C00' : '#6E6E6E' }}>
                      {t.missedPnl > 0 ? fmt$(t.missedPnl) : '—'}
                    </td>
                    {/* Alloc */}
                    <td className="px-2 py-1.5 text-[#9E9E9E] whitespace-nowrap">
                      {fmt$(t.spentUsdc)}<span className="text-[#444]">/</span>{fmt$(t.allocationUsdc)}
                    </td>
                    {/* Action */}
                    <td className="px-2 py-1.5">
                      <span className="text-[10px] font-bold" style={{ color: aColor }}>
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

      {/* ── Execution Health ── */}
      <div className="grid grid-cols-2 gap-4">

        {/* Skip breakdown */}
        <div className="bg-[#0A0A0A] border border-[#1A1A1A] rounded overflow-hidden">
          <div className="px-4 py-2 border-b border-[#1A1A1A]">
            <span className="text-[10px] text-[#00C805] tracking-widest font-bold">EXECUTION HEALTH</span>
          </div>
          <div className="p-4 space-y-2">
            {/* Exec gate row */}
            <div className="flex justify-between text-xs">
              <span className="text-[#9E9E9E]">Exec gate</span>
              <span className="text-[#E0E0E0]">
                {execBase > 0 ? `${((totalFilled / execBase) * 100).toFixed(1)}% fill` : '—'}
                <span className="text-[#6E6E6E] ml-2">({totalFilled} filled / {execSkips} skipped)</span>
              </span>
            </div>
            {/* Below avg filter */}
            <div className="flex justify-between text-xs">
              <span className="text-[#9E9E9E]">Conviction filter</span>
              <span className="text-[#6E6E6E]">{belowAvg} below-avg skipped</span>
            </div>
            <div className="border-t border-[#1A1A1A] pt-2 mt-2 space-y-1">
              {execSkipNames.map(k => {
                const count = aggSkip[k] ?? 0;
                if (count === 0) return null;
                const pct = execBase > 0 ? (count / execBase * 100).toFixed(1) : '0';
                return (
                  <div key={k} className="flex justify-between text-[11px]">
                    <span className="text-[#6E6E6E]">{skipLabel(k)}</span>
                    <span className="text-[#9E9E9E]">{count} <span className="text-[#444]">({pct}%)</span></span>
                  </div>
                );
              })}
              {execSkips === 0 && (
                <div className="text-[11px] text-[#6E6E6E]">No execution failures logged</div>
              )}
            </div>
          </div>
        </div>

        {/* Trader health flags */}
        <div className="bg-[#0A0A0A] border border-[#1A1A1A] rounded overflow-hidden">
          <div className="px-4 py-2 border-b border-[#1A1A1A]">
            <span className="text-[10px] text-[#00C805] tracking-widest font-bold">TRADER SIGNALS</span>
          </div>
          <div className="p-4 space-y-1.5">
            {traders.filter(t => t.actionCode && t.actionCode !== 'HOLD').map(t => {
              const aColor = actionColor(t.actionCode);
              return (
                <div key={t.wallet} className="flex items-center justify-between text-xs">
                  <span className="text-[#9E9E9E]">{t.label}</span>
                  <div className="flex items-center gap-2">
                    {t.failureType !== 'NONE' && (
                      <span className="text-[10px] text-[#6BA3F5]">
                        {t.failureType === 'EXEC_FAIL' ? 'EXEC ISSUE' : 'TRADER ISSUE'}
                      </span>
                    )}
                    <span className="font-bold text-[10px]" style={{ color: aColor }}>
                      {t.actionCode}
                    </span>
                  </div>
                </div>
              );
            })}
            {traders.filter(t => t.actionCode && t.actionCode !== 'HOLD').length === 0 && (
              <div className="text-[11px] text-[#6E6E6E]">All traders in HOLD — no action needed</div>
            )}
          </div>
        </div>
      </div>

      {/* ── Live Activity Log ── */}
      <div className="bg-[#0A0A0A] border border-[#1A1A1A] rounded overflow-hidden">
        <div className="px-4 py-2 border-b border-[#1A1A1A] flex items-center justify-between">
          <span className="text-[10px] text-[#00C805] tracking-widest font-bold">LIVE ACTIVITY</span>
          <span className="text-[10px] text-[#6E6E6E]">last {activity.length} trades</span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-[#1A1A1A]">
                {['Time','Trader','Market','Dir','Trader $','Bot $','Status','Note'].map(h => (
                  <th key={h}
                    className="px-2 py-1.5 text-left text-[10px] text-[#6E6E6E] tracking-wider font-normal whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {activity.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-6 text-center text-[#6E6E6E] text-xs">
                    No activity logged yet
                  </td>
                </tr>
              )}
              {activity.map(a => (
                <tr key={a._id}
                  className="border-b border-[#0F0F0F] hover:bg-[#111] transition-colors">
                  {/* Time */}
                  <td className="px-2 py-1.5 text-[#6E6E6E] whitespace-nowrap">
                    {timeAgo(a.createdAt)}
                  </td>
                  {/* Trader */}
                  <td className="px-2 py-1.5 text-[#9E9E9E] whitespace-nowrap">
                    {a.traderLabel || '—'}
                  </td>
                  {/* Market */}
                  <td className="px-2 py-1.5 text-[#E0E0E0] max-w-[260px] truncate">
                    {a.title || '—'}
                  </td>
                  {/* Direction: outcome YES/NO */}
                  <td className="px-2 py-1.5 whitespace-nowrap">
                    <span className={`font-bold ${a.outcome === 'Yes' ? 'text-[#00C805]' : 'text-[#FF4757]'}`}>
                      {a.outcome?.toUpperCase() ?? '—'}
                    </span>
                    <span className="ml-1 text-[#6E6E6E]">{a.side}</span>
                  </td>
                  {/* Trader $ */}
                  <td className="px-2 py-1.5 text-[#9E9E9E]">{fmt$(a.traderBetUsdc)}</td>
                  {/* Bot $ */}
                  <td className="px-2 py-1.5 text-[#9E9E9E]">
                    {a.status === 'FILLED' && a.filledUsdc != null
                      ? fmt$(a.filledUsdc)
                      : a.copyBetUsdc > 0 ? fmt$(a.copyBetUsdc) : '—'}
                  </td>
                  {/* Status */}
                  <td className="px-2 py-1.5">
                    <span className="font-bold text-[10px]" style={{ color: statusColor(a.status) }}>
                      {a.status}
                    </span>
                  </td>
                  {/* Note */}
                  <td className="px-2 py-1.5 text-[#6E6E6E] text-[10px]">
                    {a.skipReason ? skipLabel(a.skipReason) : ''}
                    {a.totalLatencyMs != null && a.status === 'FILLED'
                      ? `${(a.totalLatencyMs / 1000).toFixed(1)}s`
                      : ''}
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
