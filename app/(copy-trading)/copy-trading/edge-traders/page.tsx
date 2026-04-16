'use client';

import { useEffect, useState } from 'react';

// ── Types ─────────────────────────────────────────────────────────────────────

interface EdgeTrader {
  wallet: string;
  displayName: string | null;
  specialty: string;
  winRate: number;
  expectedWR: number;
  n: number;
  edge: number;
  pVal: number;
  confidence: string;
  rankScore: number;
  overallRank: number;
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
  updatedAt: string;
  isNewInRun: boolean;

  isCopying: boolean;
  allocationUsdc: number;
  spentUsdc: number;
  allocAction: string;
  allocReason: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtPval(p: number): string {
  if (p < 0.0001) return p.toExponential(1);
  if (p < 0.001)  return p.toFixed(4);
  return p.toFixed(3);
}

function fmtLast(days: number | null): string {
  if (days == null) return '—';
  if (days < 1) return `${Math.max(1, Math.round(days * 24))}h`;
  return `${Math.round(days)}d`;
}

function fmtPct(n: number | null, decimals = 1): string {
  if (n == null) return '—';
  return `${n.toFixed(decimals)}%`;
}

function confidenceBadge(conf: string): { label: string; color: string } {
  switch (conf) {
    case 'confirmed': return { label: 'CONF', color: '#00C805' };
    case 'likely':    return { label: 'LIKE', color: '#FFD000' };
    default:          return { label: 'WTCH', color: '#6E6E6E' };
  }
}

function insiderColor(level: string): string {
  switch (level) {
    case 'high':   return '#FF4757';
    case 'medium': return '#FF8C00';
    case 'low':    return '#FFD000';
    default:       return '#6E6E6E';
  }
}

function fmt$(n: number): string {
  if (Math.abs(n) >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function EdgeTradersPage() {
  const [traders, setTraders] = useState<EdgeTrader[]>([]);
  const [pipelineRunAt, setPipelineRunAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'confirmed' | 'likely'>('all');
  const [showCopyOnly, setShowCopyOnly] = useState(false);

  async function fetchTraders() {
    try {
      const res = await fetch('/api/copy-trading/edge-ranked');
      const data = await res.json();
      if (data.success) {
        setTraders(data.traders);
        setPipelineRunAt(data.pipelineRunAt);
      }
    } catch (e) {
      console.error('fetch error', e);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchTraders();
    const interval = setInterval(fetchTraders, 60_000);
    return () => clearInterval(interval);
  }, []);

  async function toggleCopy(wallet: string, currentlyActive: boolean) {
    setToggling(wallet);
    try {
      const res = await fetch('/api/copy-trading/edge-ranked', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet, action: currentlyActive ? 'stop' : 'start' }),
      });
      const data = await res.json();
      if (data.success) {
        setTraders(prev => prev.map(t =>
          t.wallet === wallet ? { ...t, isCopying: !currentlyActive } : t
        ));
      }
    } catch (e) {
      console.error('toggle error', e);
    } finally {
      setToggling(null);
    }
  }

  const newCount = traders.filter(t => t.isNewInRun).length;

  const displayed = traders.filter(t => {
    if (showCopyOnly && !t.isCopying) return false;
    if (filter === 'confirmed' && t.confidence !== 'confirmed') return false;
    if (filter === 'likely' && t.confidence !== 'likely') return false;
    return true;
  });

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 font-mono text-[#6E6E6E]">
        LOADING...
      </div>
    );
  }

  return (
    <div className="space-y-4 font-mono">

      {/* ── Pipeline banner ── */}
      {newCount > 0 && (
        <div className="bg-[#00C805]/10 border border-[#00C805]/30 rounded px-4 py-2 flex items-center gap-3">
          <span className="text-[#00C805] font-bold text-xs">+{newCount} NEW</span>
          <span className="text-[#9E9E9E] text-xs">traders added in the latest pipeline run</span>
          {pipelineRunAt && (
            <span className="text-[#6E6E6E] text-xs ml-auto">
              pipeline: {new Date(pipelineRunAt).toLocaleString()}
            </span>
          )}
        </div>
      )}

      {/* ── Controls ── */}
      <div className="flex items-center gap-3">
        <span className="text-[10px] text-[#6E6E6E] tracking-widest">FILTER</span>
        {(['all', 'confirmed', 'likely'] as const).map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-1 text-xs rounded transition-colors ${
              filter === f
                ? 'bg-[#00C805]/10 text-[#00C805] border border-[#00C805]/30'
                : 'text-[#6E6E6E] border border-[#1A1A1A] hover:text-[#9E9E9E]'
            }`}>
            {f.toUpperCase()}
          </button>
        ))}
        <button
          onClick={() => setShowCopyOnly(v => !v)}
          className={`px-3 py-1 text-xs rounded transition-colors ${
            showCopyOnly
              ? 'bg-[#00C805]/10 text-[#00C805] border border-[#00C805]/30'
              : 'text-[#6E6E6E] border border-[#1A1A1A] hover:text-[#9E9E9E]'
          }`}>
          COPYING ONLY
        </button>
        <span className="ml-auto text-[10px] text-[#6E6E6E]">
          {displayed.length}/{traders.length} traders
        </span>
      </div>

      {/* ── Table ── */}
      <div className="bg-[#0A0A0A] border border-[#1A1A1A] rounded overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-[#1A1A1A]">
                {[
                  'Rank','Wallet','WinRate','ExpWR','n','Edge','P-val','Conf',
                  'ROCE30','PnL30','PF','DaysW%','Sortino','SpcWR%',
                  'Act/d','Last','Insider','Specialty','Copy','Alloc','Action',
                ].map(h => (
                  <th key={h}
                    className="px-2 py-2 text-left text-[10px] text-[#6E6E6E] tracking-wider whitespace-nowrap font-normal">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {displayed.length === 0 && (
                <tr>
                  <td colSpan={21} className="px-4 py-6 text-center text-[#6E6E6E] text-xs">
                    No edge-ranked traders found. Run the pipeline to populate data.
                  </td>
                </tr>
              )}
              {displayed.map(t => {
                const conf = confidenceBadge(t.confidence);
                const isBusy = toggling === t.wallet;
                return (
                  <tr key={t.wallet}
                    className={`border-b border-[#0F0F0F] hover:bg-[#111] transition-colors ${
                      t.isNewInRun ? 'bg-[#00C805]/5' : ''
                    }`}>

                    {/* Rank */}
                    <td className="px-2 py-1.5 text-[#6E6E6E]">{t.overallRank}</td>

                    {/* Wallet */}
                    <td className="px-2 py-1.5 whitespace-nowrap">
                      <div className="flex items-center gap-1">
                        {t.isNewInRun && (
                          <span className="text-[8px] text-[#00C805] font-bold">NEW</span>
                        )}
                        <span className="text-[#9E9E9E] font-mono text-[10px]">
                          {t.displayName
                            ? t.displayName
                            : `${t.wallet.slice(0, 6)}…${t.wallet.slice(-4)}`}
                        </span>
                      </div>
                    </td>

                    {/* WinRate */}
                    <td className="px-2 py-1.5 text-[#00C805]">{fmtPct(t.winRate)}</td>

                    {/* ExpWR */}
                    <td className="px-2 py-1.5 text-[#6E6E6E]">
                      {fmtPct(t.expectedWR * 100)}
                    </td>

                    {/* n */}
                    <td className="px-2 py-1.5 text-[#9E9E9E]">{t.n}</td>

                    {/* Edge */}
                    <td className="px-2 py-1.5">
                      <span className={t.edge > 0 ? 'text-[#00C805]' : 'text-[#FF4757]'}>
                        {t.edge > 0 ? '+' : ''}{t.edge.toFixed(3)}
                      </span>
                    </td>

                    {/* P-val */}
                    <td className="px-2 py-1.5 text-[#9E9E9E]">{fmtPval(t.pVal)}</td>

                    {/* Conf */}
                    <td className="px-2 py-1.5">
                      <span className="text-[10px] font-bold" style={{ color: conf.color }}>
                        {conf.label}
                      </span>
                    </td>

                    {/* ROCE30 */}
                    <td className="px-2 py-1.5"
                      style={{ color: t.roce30d >= 0 ? '#00C805' : '#FF4757' }}>
                      {fmtPct(t.roce30d, 0)}
                    </td>

                    {/* PnL30 */}
                    <td className="px-2 py-1.5"
                      style={{ color: t.pnl30d >= 0 ? '#00C805' : '#FF4757' }}>
                      {fmt$(t.pnl30d)}
                    </td>

                    {/* PF */}
                    <td className="px-2 py-1.5 text-[#9E9E9E]">{t.pf.toFixed(2)}</td>

                    {/* DaysW% */}
                    <td className="px-2 py-1.5 text-[#9E9E9E]">{fmtPct(t.daysWonRate)}</td>

                    {/* Sortino */}
                    <td className="px-2 py-1.5 text-[#9E9E9E]">
                      {t.sortino != null ? t.sortino.toFixed(2) : '—'}
                    </td>

                    {/* SpcWR% */}
                    <td className="px-2 py-1.5 text-[#9E9E9E]">{fmtPct(t.spcWr)}</td>

                    {/* Act/d */}
                    <td className="px-2 py-1.5 text-[#9E9E9E]">
                      {t.actPerDay != null ? t.actPerDay.toFixed(1) : '—'}
                    </td>

                    {/* Last */}
                    <td className="px-2 py-1.5 text-[#9E9E9E]">{fmtLast(t.lastActive)}</td>

                    {/* Insider */}
                    <td className="px-2 py-1.5">
                      <span className="text-[10px]" style={{ color: insiderColor(t.insider) }}>
                        {t.insider === 'none' ? '—' : t.insider.toUpperCase()}
                      </span>
                    </td>

                    {/* Specialty */}
                    <td className="px-2 py-1.5 text-[#9E9E9E] whitespace-nowrap text-[10px]">
                      {t.specialty}
                    </td>

                    {/* Copy toggle */}
                    <td className="px-2 py-1.5">
                      <button
                        disabled={isBusy}
                        onClick={() => toggleCopy(t.wallet, t.isCopying)}
                        className={`px-2 py-0.5 text-[10px] rounded border transition-colors font-bold ${
                          t.isCopying
                            ? 'border-[#FF4757]/40 text-[#FF4757] hover:bg-[#FF4757]/10'
                            : 'border-[#00C805]/40 text-[#00C805] hover:bg-[#00C805]/10'
                        } disabled:opacity-40`}>
                        {isBusy ? '…' : t.isCopying ? 'STOP' : 'START'}
                      </button>
                    </td>

                    {/* Alloc */}
                    <td className="px-2 py-1.5 text-[#6E6E6E] whitespace-nowrap">
                      {t.allocationUsdc > 0
                        ? `${fmt$(t.spentUsdc)}/${fmt$(t.allocationUsdc)}`
                        : '—'}
                    </td>

                    {/* Action */}
                    <td className="px-2 py-1.5">
                      {t.allocAction ? (
                        <span className="text-[10px] text-[#9E9E9E]">{t.allocAction}</span>
                      ) : '—'}
                    </td>

                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

    </div>
  );
}
