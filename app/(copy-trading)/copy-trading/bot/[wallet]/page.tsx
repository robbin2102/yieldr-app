'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

// ── Types ─────────────────────────────────────────────────────────────────────

interface EdgeProfile {
  displayName: string | null;
  specialty: string;
  winRate: number;
  expectedWR: number;
  n: number;
  edge: number;
  pVal: number;
  confidence: string;
  overallRank: number | null;
  roce30d: number;
  pnl30d: number;
  pf: number;
  daysWonRate: number | null;
  sortino: number | null;
  actPerDay: number | null;
  lastActive: number | null;
  insider: string;
  insiderScore: number;
  spcWr: number | null;
}

interface CopyConfig {
  label: string;
  allocationUsdc: number;
  spentUsdc: number;
  active: boolean;
  avgBet: number;
  maxBetUsdc: number;
  allocAction: string;
  allocReason: string;
  allocFailureType: string;
  allocCheckedAt: string | null;
}

interface AllocEvent {
  _id: string;
  runAt: string;
  actionCode: string;
  action: string;
  failureType: string;
  reason: string;
  allocBefore: number;
  allocAfter: number | null;
  traderROCE: number;
  botROCE: number;
  edgeScore: number | null;
  tTotal: number;
  bPnl: number;
}

interface Market {
  conditionId: string | null;
  title: string;
  outcome: string;
  tEntry: number | null;
  tBought: number | null;
  tSold: number | null;
  bEntry: number | null;
  bFilledUsdc: number | null;
  bFilledSize: number | null;
  bPnl: number | null;
  curPrice: number | null;
  traderStillIn: boolean;
  skipCounts: Record<string, number>;
  totalSkips: number;
  totalDetected: number;
  totalFilled: number;
  lastActivity: string;
}

interface TraderDetail {
  wallet: string;
  label: string;
  edgeProfile: EdgeProfile | null;
  config: CopyConfig | null;
  allocHistory: AllocEvent[];
  markets: Market[];
  tradeCount: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt$(n: number | null | undefined, dec = 2): string {
  if (n == null || !isFinite(n)) return '—';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '+';
  if (abs >= 1000) return `${sign}$${(abs / 1000).toFixed(1)}k`;
  return `${sign}$${abs.toFixed(dec)}`;
}
function fmtDollar(n: number | null | undefined): string {
  if (n == null || !isFinite(n)) return '—';
  if (Math.abs(n) >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

function fmtPct(n: number | null, dec = 1): string {
  if (n == null) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(dec)}%`;
}

function fmtPval(p: number): string {
  if (p < 0.0001) return p.toExponential(1);
  if (p < 0.001)  return p.toFixed(4);
  return p.toFixed(3);
}

function fmtAge(days: number | null): string {
  if (days == null) return '—';
  if (days < 1) return `${Math.max(1, Math.round(days * 24))}h`;
  return `${Math.round(days)}d`;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60)    return `${s}s ago`;
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const ACTION_COLORS: Record<string, string> = {
  HARD_STOP: '#FF4757', SOFT_STOP: '#FF6B6B',
  SCALE_DOWN: '#FF8C00', SCALE_UP: '#00C805', CONTINUE: '#00C805',
  HOLD: '#9E9E9E', WATCH: '#FFD000', FIX_ENTRY: '#6BA3F5',
  INCREASE_ALLOC: '#6BA3F5', EXEC_FAIL: '#6BA3F5',
};
function actionColor(code: string): string {
  for (const [k, c] of Object.entries(ACTION_COLORS)) {
    if (code?.toUpperCase().includes(k)) return c;
  }
  return '#9E9E9E';
}

function confBadge(conf: string) {
  switch (conf) {
    case 'confirmed': return { label: 'CONFIRMED', color: '#00C805' };
    case 'likely':    return { label: 'LIKELY',    color: '#FFD000' };
    default:          return { label: 'WATCH',     color: '#6E6E6E' };
  }
}

function skipSummary(counts: Record<string, number>): string {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => {
      const short: Record<string, string> = {
        BELOW_AVG: 'BA', ALLOCATION_FULL: 'ALLOC', POSITION_CAP_FULL: 'CAP',
        NO_ORDERBOOK: 'BOOK', ORDER_FAILED: 'FAIL', WIDE_SPREAD: 'SPREAD',
        PRICEDRIFT_FAILED: 'DRIFT', GROUPED_BELOW_AVG: 'GRP',
        SELL_NO_POSITION: 'SNP', DUPLICATE: 'DUP', NON_TRADE: 'NT',
      };
      return `${short[k] ?? k}:${n}`;
    })
    .join(' ');
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function TraderDetailPage({ params }: { params: { wallet: string } }) {
  const [data,    setData]    = useState<TraderDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);
  const [minUsdc, setMinUsdc] = useState(5);

  useEffect(() => {
    async function fetchDetail() {
      try {
        const res = await fetch(`/api/copy-trading/trader-detail/${params.wallet}`);
        const json = await res.json();
        if (json.success) setData(json);
        else setError(json.error ?? 'Unknown error');
      } catch (e: any) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    }
    fetchDetail();
  }, [params.wallet]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 font-mono text-[#6E6E6E]">
        LOADING...
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="font-mono p-8 text-center text-[#FF4757]">
        {error ?? 'Trader not found'}
      </div>
    );
  }

  const { edgeProfile: ep, config: cfg, allocHistory, markets } = data;
  const conf = ep ? confBadge(ep.confidence) : null;
  const latestAlloc = allocHistory[0];

  const visibleMarkets = markets.filter(m =>
    (m.tBought ?? 0) >= minUsdc || (m.bFilledUsdc ?? 0) > 0
  );

  return (
    <div className="space-y-4 font-mono">

      {/* ── Back nav ── */}
      <Link href="/copy-trading/bot"
        className="inline-flex items-center gap-2 text-[10px] text-[#6E6E6E] hover:text-[#00C805] transition-colors">
        ← BACK TO BOT
      </Link>

      {/* ── Header ── */}
      <div className="bg-[#0A0A0A] border border-[#1A1A1A] rounded px-5 py-4">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-3">
              <div className={`w-2 h-2 rounded-full ${cfg?.active ? 'bg-[#00C805]' : 'bg-[#FF4757]'}`} />
              <span className="text-lg font-bold text-[#E0E0E0]">{data.label}</span>
              {conf && (
                <span className="text-[10px] font-bold px-2 py-0.5 rounded border"
                  style={{ color: conf.color, borderColor: conf.color + '40' }}>
                  {conf.label}
                </span>
              )}
              {ep && (
                <span className="text-[10px] text-[#6E6E6E]">{ep.specialty}</span>
              )}
            </div>
            <div className="mt-1 text-[10px] text-[#6E6E6E] font-mono">{data.wallet}</div>
          </div>
          <div className="text-right">
            {latestAlloc && (
              <div className="text-xs" style={{ color: actionColor(latestAlloc.actionCode) }}>
                {latestAlloc.actionCode}
              </div>
            )}
            {cfg && (
              <div className="text-[10px] text-[#6E6E6E] mt-1">
                alloc: {fmtDollar(cfg.allocationUsdc)} | spent: {fmtDollar(cfg.spentUsdc)}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Edge Profile + Allocation ── */}
      <div className="grid grid-cols-2 gap-4">

        {/* Edge stats */}
        <div className="bg-[#0A0A0A] border border-[#1A1A1A] rounded overflow-hidden">
          <div className="px-4 py-2 border-b border-[#1A1A1A]">
            <span className="text-[10px] text-[#00C805] tracking-widest font-bold">EDGE PROFILE</span>
          </div>
          {ep ? (
            <div className="p-4 grid grid-cols-2 gap-x-6 gap-y-2">
              {[
                { label: 'Win Rate',    value: fmtPct(ep.winRate) },
                { label: 'Exp WR',      value: fmtPct(ep.expectedWR * 100) },
                { label: 'Edge',        value: ep.edge.toFixed(3),
                  color: ep.edge > 0 ? '#00C805' : '#FF4757' },
                { label: 'P-val',       value: fmtPval(ep.pVal) },
                { label: 'Sample (n)',  value: String(ep.n) },
                { label: 'Rank',        value: ep.overallRank ? `#${ep.overallRank}` : '—' },
                { label: 'ROCE 30d',    value: fmtPct(ep.roce30d, 0),
                  color: ep.roce30d >= 0 ? '#00C805' : '#FF4757' },
                { label: 'PnL 30d',     value: fmtDollar(ep.pnl30d),
                  color: ep.pnl30d >= 0 ? '#00C805' : '#FF4757' },
                { label: 'Profit Factor', value: ep.pf.toFixed(2) },
                { label: 'Days Won %',  value: fmtPct(ep.daysWonRate) },
                { label: 'Sortino',     value: ep.sortino?.toFixed(2) ?? '—' },
                { label: 'Spc WR',      value: fmtPct(ep.spcWr) },
                { label: 'Act/Day',     value: ep.actPerDay?.toFixed(1) ?? '—' },
                { label: 'Last Active', value: fmtAge(ep.lastActive) },
                { label: 'Insider',     value: ep.insider === 'none' ? '—' : ep.insider.toUpperCase(),
                  color: ep.insider === 'high' ? '#FF4757' : ep.insider === 'medium' ? '#FF8C00' : undefined },
              ].map(({ label, value, color }) => (
                <div key={label} className="flex justify-between text-xs">
                  <span className="text-[#6E6E6E]">{label}</span>
                  <span className="font-mono" style={{ color: color ?? '#E0E0E0' }}>{value}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="p-4 text-xs text-[#6E6E6E]">Not in edge rank — may not meet confidence threshold</div>
          )}
        </div>

        {/* Allocation history */}
        <div className="bg-[#0A0A0A] border border-[#1A1A1A] rounded overflow-hidden">
          <div className="px-4 py-2 border-b border-[#1A1A1A]">
            <span className="text-[10px] text-[#00C805] tracking-widest font-bold">ALLOCATION HISTORY</span>
          </div>
          <div className="overflow-y-auto max-h-72">
            {allocHistory.length === 0 && (
              <div className="p-4 text-xs text-[#6E6E6E]">No allocation events yet</div>
            )}
            {allocHistory.map((ev, i) => (
              <div key={i} className="px-4 py-2 border-b border-[#0F0F0F] flex items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-bold" style={{ color: actionColor(ev.actionCode) }}>
                      {ev.actionCode}
                    </span>
                    {ev.failureType !== 'NONE' && (
                      <span className="text-[9px] text-[#6BA3F5]">[{ev.failureType}]</span>
                    )}
                  </div>
                  <div className="text-[10px] text-[#6E6E6E] mt-0.5 max-w-xs truncate" title={ev.reason}>
                    {ev.reason}
                  </div>
                </div>
                <div className="text-right flex-shrink-0">
                  <div className="text-[10px] text-[#9E9E9E]">
                    {fmtDollar(ev.allocBefore)} → {ev.allocAfter != null ? fmtDollar(ev.allocAfter) : '?'}
                  </div>
                  <div className="text-[9px] text-[#6E6E6E]">
                    {new Date(ev.runAt).toLocaleDateString()} {new Date(ev.runAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Per-Market Breakdown ── */}
      <div className="bg-[#0A0A0A] border border-[#1A1A1A] rounded overflow-hidden">
        <div className="px-4 py-2 border-b border-[#1A1A1A] flex items-center justify-between">
          <span className="text-[10px] text-[#00C805] tracking-widest font-bold">MARKET BREAKDOWN</span>
          <div className="flex items-center gap-3">
            <span className="text-[10px] text-[#6E6E6E]">{visibleMarkets.length} markets</span>
            <label className="flex items-center gap-1.5 text-[10px] text-[#6E6E6E]">
              min $
              <input
                type="number"
                value={minUsdc}
                onChange={e => setMinUsdc(Number(e.target.value))}
                className="w-10 bg-[#111] border border-[#1A1A1A] rounded px-1 py-0.5 text-[10px] text-[#9E9E9E] font-mono"
              />
            </label>
          </div>
        </div>

        {/* Summary row */}
        {latestAlloc && (
          <div className="px-4 py-2 border-b border-[#1A1A1A] flex gap-6 text-xs">
            <span className="text-[#9E9E9E]">
              T.Total: <span className="font-bold"
                style={{ color: latestAlloc.tTotal >= 0 ? '#00C805' : '#FF4757' }}>
                {fmt$(latestAlloc.tTotal)}
              </span>
            </span>
            <span className="text-[#9E9E9E]">
              Bot PnL: <span className="font-bold"
                style={{ color: latestAlloc.bPnl >= 0 ? '#00C805' : '#FF4757' }}>
                {fmt$(latestAlloc.bPnl)}
              </span>
            </span>
            <span className="text-[#9E9E9E]">
              tROCE: <span style={{ color: latestAlloc.traderROCE >= 0 ? '#00C805' : '#FF4757' }}>
                {fmtPct(latestAlloc.traderROCE * 100)}
              </span>
            </span>
            <span className="text-[#9E9E9E]">
              bROCE: <span style={{ color: latestAlloc.botROCE >= 0 ? '#00C805' : '#FF4757' }}>
                {fmtPct(latestAlloc.botROCE * 100)}
              </span>
            </span>
            {ep && (
              <span className="text-[#9E9E9E]">
                Edge: <span className="text-[#E0E0E0]">{ep.edge.toFixed(3)}</span>
              </span>
            )}
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-[#1A1A1A]">
                {['Market','Out','Cur','T.Entry','T.Bought','T.Sold','B.Entry','B.PnL','Trader','Skips'].map(h => (
                  <th key={h} className="px-2 py-1.5 text-left text-[10px] text-[#6E6E6E] tracking-wider whitespace-nowrap font-normal">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleMarkets.length === 0 && (
                <tr><td colSpan={10} className="px-4 py-6 text-center text-[#6E6E6E]">
                  No market data — lower the min $ filter or check trade history
                </td></tr>
              )}
              {visibleMarkets.map((m, i) => (
                <tr key={i} className={`border-b border-[#0F0F0F] hover:bg-[#111] transition-colors ${
                  m.bFilledUsdc != null && !m.traderStillIn && m.bFilledUsdc > 0
                    ? 'bg-[#FF8C00]/5' : ''
                }`}>
                  {/* Market */}
                  <td className="px-2 py-1.5 max-w-[200px]">
                    <span className="text-[#E0E0E0]" title={m.title}>
                      {m.title.length > 42 ? m.title.slice(0, 42) + '…' : m.title}
                    </span>
                  </td>
                  {/* Outcome */}
                  <td className="px-2 py-1.5">
                    <span className={`font-bold ${m.outcome?.toLowerCase() === 'yes' ? 'text-[#00C805]' : 'text-[#FF4757]'}`}>
                      {m.outcome?.slice(0, 3).toUpperCase()}
                    </span>
                  </td>
                  {/* Cur price */}
                  <td className="px-2 py-1.5 text-[#9E9E9E]">
                    {m.curPrice != null ? m.curPrice.toFixed(3) : '—'}
                  </td>
                  {/* T.Entry */}
                  <td className="px-2 py-1.5 text-[#9E9E9E]">
                    {m.tEntry != null ? m.tEntry.toFixed(3) : '—'}
                  </td>
                  {/* T.Bought */}
                  <td className="px-2 py-1.5 text-[#9E9E9E]">
                    {m.tBought != null ? fmtDollar(m.tBought) : '—'}
                  </td>
                  {/* T.Sold */}
                  <td className="px-2 py-1.5 text-[#6E6E6E]">
                    {m.tSold != null ? fmtDollar(m.tSold) : '—'}
                  </td>
                  {/* B.Entry */}
                  <td className="px-2 py-1.5 text-[#9E9E9E]">
                    {m.bEntry != null ? m.bEntry.toFixed(3) : '—'}
                  </td>
                  {/* B.PnL */}
                  <td className="px-2 py-1.5 font-bold"
                    style={{ color: m.bPnl != null ? (m.bPnl >= 0 ? '#00C805' : '#FF4757') : '#6E6E6E' }}>
                    {m.bPnl != null ? fmt$(m.bPnl) : (m.bFilledUsdc != null ? '?' : '—')}
                  </td>
                  {/* Trader still in */}
                  <td className="px-2 py-1.5">
                    {m.bFilledUsdc != null && m.bFilledUsdc > 0
                      ? m.traderStillIn
                        ? <span className="text-[10px] text-[#00C805]">HOLD</span>
                        : <span className="text-[10px] font-bold text-[#FF8C00]">EXIT</span>
                      : <span className="text-[10px] text-[#444]">—</span>
                    }
                  </td>
                  {/* Skips */}
                  <td className="px-2 py-1.5 text-[#6E6E6E] text-[10px] whitespace-nowrap">
                    {m.totalSkips > 0 ? skipSummary(m.skipCounts) : '—'}
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
