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
  firstActivityAt: string | null;
  updatedAt: string;
  isNewInRun: boolean;
  qualificationStatus: 'qualified' | 'fallen';

  isCopying: boolean;
  allocationUsdc: number;
  spentUsdc: number;
  allocAction: string;
  allocReason: string;
}

interface Filters {
  qual: 'qualified' | 'all' | 'fallen';
  conf: 'all' | 'confirmed' | 'likely';
  copyOnly: boolean;
  specialty: string;
  minWinRate: string;
  minN: string;
  minEdge: string;
  minRoce: string;
  minPnl: string;
  minPf: string;
  minDaysWon: string;
  minSortino: string;
  minActPerDay: string;
  maxActPerDay: string;
  minAgeDays: string;
}

const defaultFilters: Filters = {
  qual: 'qualified', conf: 'all', copyOnly: false, specialty: '',
  minWinRate: '', minN: '', minEdge: '', minRoce: '', minPnl: '',
  minPf: '', minDaysWon: '', minSortino: '', minActPerDay: '', maxActPerDay: '',
  minAgeDays: '',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtPval(p: number): string {
  if (p < 0.01) return p.toExponential(2);
  return p.toFixed(3);
}

function fmtLast(days: number | null): string {
  if (days == null) return '—';
  if (days < 1) return `${Math.max(1, Math.round(days * 24))}h`;
  return `${Math.round(days)}d`;
}

function ageDays(firstActivityAt: string | null): number | null {
  if (!firstActivityAt) return null;
  const t = new Date(firstActivityAt).getTime();
  if (isNaN(t)) return null;
  return (Date.now() - t) / 86_400_000;
}

function fmtAge(firstActivityAt: string | null): string {
  const d = ageDays(firstActivityAt);
  if (d == null) return '—';
  if (d < 30)  return `${Math.round(d)}d`;
  if (d < 365) return `${Math.round(d)}d`;
  return `${(d / 365).toFixed(1)}y`;
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

function num(s: string): number | null {
  const v = parseFloat(s);
  return isNaN(v) ? null : v;
}

function applyFilters(traders: EdgeTrader[], f: Filters): EdgeTrader[] {
  return traders.filter(t => {
    if (f.qual !== 'all' && t.qualificationStatus !== f.qual) return false;
    if (f.copyOnly && !t.isCopying) return false;
    if (f.conf !== 'all') {
      if (f.conf === 'confirmed' && t.confidence !== 'confirmed') return false;
      if (f.conf === 'likely'    && t.confidence !== 'likely')    return false;
    }
    if (f.specialty && t.specialty !== f.specialty) return false;
    const minWR = num(f.minWinRate);   if (minWR    != null && t.winRate    < minWR)    return false;
    const minN  = num(f.minN);         if (minN     != null && t.n          < minN)     return false;
    const minE  = num(f.minEdge);      if (minE     != null && t.edge       < minE)     return false;
    const minR  = num(f.minRoce);      if (minR     != null && t.roce30d    < minR)     return false;
    const minP  = num(f.minPnl);       if (minP     != null && t.pnl30d     < minP)     return false;
    const minPf = num(f.minPf);        if (minPf    != null && t.pf         < minPf)    return false;
    const minDW = num(f.minDaysWon);   if (minDW    != null && (t.daysWonRate ?? 0) < minDW) return false;
    const minS  = num(f.minSortino);   if (minS     != null && (t.sortino   ?? 0) < minS)    return false;
    const minAc = num(f.minActPerDay); if (minAc    != null && (t.actPerDay ?? 0) < minAc)   return false;
    const maxAc = num(f.maxActPerDay); if (maxAc    != null && (t.actPerDay ?? 0) > maxAc)   return false;
    const minAg = num(f.minAgeDays);
    if (minAg != null) {
      const a = ageDays(t.firstActivityAt);
      if (a == null || a < minAg) return false;
    }
    return true;
  });
}

// ── NumInput helper ───────────────────────────────────────────────────────────

function NumInput({ label, value, onChange, placeholder }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string;
}) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-[9px] text-[#6E6E6E] tracking-wider">{label}</span>
      <input
        type="number"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder ?? '—'}
        className="w-16 px-1.5 py-0.5 text-[10px] bg-[#111] border border-[#1A1A1A] rounded text-[#9E9E9E] placeholder-[#333] focus:outline-none focus:border-[#333]"
      />
    </label>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function EdgeTradersPage() {
  const [traders, setTraders]         = useState<EdgeTrader[]>([]);
  const [pipelineRunAt, setPipelineRunAt] = useState<string | null>(null);
  const [loading, setLoading]         = useState(true);
  const [toggling, setToggling]       = useState<string | null>(null);
  const [filters, setFilters]         = useState<Filters>(defaultFilters);
  const [showFilters, setShowFilters] = useState(false);

  async function fetchTraders() {
    try {
      const res = await fetch('/api/copy-trading/edge-ranked');
      const data = await res.json();
      if (data.success) {
        setTraders(data.traders);
        setPipelineRunAt(data.pipelineRunAt);
      }
    } catch (e) { console.error('fetch error', e); }
    finally { setLoading(false); }
  }

  useEffect(() => {
    fetchTraders();
    const interval = setInterval(fetchTraders, 60_000);
    return () => clearInterval(interval);
  }, []);

  async function toggleCopy(wallet: string, currentlyActive: boolean) {
    setToggling(wallet);
    try {
      const action = currentlyActive ? 'remove' : 'start';
      const res = await fetch('/api/copy-trading/edge-ranked', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet, action }),
      });
      const data = await res.json();
      if (data.success) {
        setTraders(prev => prev.map(t =>
          t.wallet === wallet ? { ...t, isCopying: !currentlyActive } : t
        ));
      }
    } catch (e) { console.error('toggle error', e); }
    finally { setToggling(null); }
  }

  function setFilter<K extends keyof Filters>(k: K, v: Filters[K]) {
    setFilters(prev => ({ ...prev, [k]: v }));
  }

  const specialties = [...new Set(traders.map(t => t.specialty))].filter(Boolean).sort();
  const newCount    = traders.filter(t => t.isNewInRun).length;
  const qualCount   = traders.filter(t => t.qualificationStatus === 'qualified').length;
  const fallenCount = traders.filter(t => t.qualificationStatus === 'fallen').length;
  const displayed   = applyFilters(traders, filters);

  const hasActiveFilters = Object.entries(filters).some(([k, v]) =>
    k !== 'qual' && k !== 'conf' && k !== 'copyOnly' && v !== '' && v !== defaultFilters[k as keyof Filters]
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 font-mono text-[#6E6E6E]">
        LOADING...
      </div>
    );
  }

  return (
    <div className="space-y-3 font-mono">

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

      {/* ── Controls row ── */}
      <div className="flex flex-wrap items-center gap-2">

        {/* Qualification toggle */}
        <div className="flex items-center gap-1 border border-[#1A1A1A] rounded p-0.5">
          {([
            ['qualified', `QUALIFIED (${qualCount})`],
            ['all',       `ALL (${traders.length})`],
            ['fallen',    `FALLEN (${fallenCount})`],
          ] as const).map(([k, label]) => (
            <button key={k} onClick={() => setFilter('qual', k)}
              className={`px-2 py-0.5 text-[10px] rounded transition-colors ${
                filters.qual === k
                  ? k === 'fallen'
                    ? 'bg-[#FF4757]/15 text-[#FF4757]'
                    : 'bg-[#00C805]/10 text-[#00C805]'
                  : 'text-[#6E6E6E] hover:text-[#9E9E9E]'
              }`}>
              {label}
            </button>
          ))}
        </div>

        {/* Confidence toggle */}
        <div className="flex items-center gap-1 border border-[#1A1A1A] rounded p-0.5">
          {(['all', 'confirmed', 'likely'] as const).map(f => (
            <button key={f} onClick={() => setFilter('conf', f)}
              className={`px-2 py-0.5 text-[10px] rounded transition-colors ${
                filters.conf === f
                  ? 'bg-[#00C805]/10 text-[#00C805]'
                  : 'text-[#6E6E6E] hover:text-[#9E9E9E]'
              }`}>
              {f === 'all' ? 'ALL' : f === 'confirmed' ? 'CONF' : 'LIKE'}
            </button>
          ))}
        </div>

        {/* Copying only */}
        <button onClick={() => setFilter('copyOnly', !filters.copyOnly)}
          className={`px-2 py-1 text-[10px] rounded border transition-colors ${
            filters.copyOnly
              ? 'bg-[#00C805]/10 text-[#00C805] border-[#00C805]/30'
              : 'text-[#6E6E6E] border-[#1A1A1A] hover:text-[#9E9E9E]'
          }`}>
          COPYING ONLY
        </button>

        {/* Filter expand */}
        <button onClick={() => setShowFilters(v => !v)}
          className={`px-2 py-1 text-[10px] rounded border transition-colors ${
            showFilters || hasActiveFilters
              ? 'bg-[#FFD000]/10 text-[#FFD000] border-[#FFD000]/30'
              : 'text-[#6E6E6E] border-[#1A1A1A] hover:text-[#9E9E9E]'
          }`}>
          FILTERS {showFilters ? '▲' : '▼'}
        </button>

        {hasActiveFilters && (
          <button onClick={() => setFilters(prev => ({
            ...defaultFilters, qual: prev.qual, conf: prev.conf, copyOnly: prev.copyOnly,
          }))}
            className="px-2 py-1 text-[10px] text-[#6E6E6E] hover:text-[#FF4757] transition-colors">
            RESET
          </button>
        )}

        <span className="ml-auto text-[10px] text-[#6E6E6E]">
          {displayed.length}/{traders.length} traders
        </span>
      </div>

      {/* ── Expanded numeric filters ── */}
      {showFilters && (
        <div className="bg-[#0A0A0A] border border-[#1A1A1A] rounded px-4 py-3">
          <div className="flex flex-wrap gap-4 items-end">
            {/* Specialty */}
            <label className="flex flex-col gap-0.5">
              <span className="text-[9px] text-[#6E6E6E] tracking-wider">SPECIALTY</span>
              <select
                value={filters.specialty}
                onChange={e => setFilter('specialty', e.target.value)}
                className="px-1.5 py-0.5 text-[10px] bg-[#111] border border-[#1A1A1A] rounded text-[#9E9E9E] focus:outline-none focus:border-[#333]">
                <option value="">All</option>
                {specialties.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>

            <NumInput label="MIN WIN%" value={filters.minWinRate} onChange={v => setFilter('minWinRate', v)} placeholder="50" />
            <NumInput label="MIN N"    value={filters.minN}       onChange={v => setFilter('minN', v)}       placeholder="20" />
            <NumInput label="MIN EDGE" value={filters.minEdge}    onChange={v => setFilter('minEdge', v)}    placeholder="0.15" />
            <NumInput label="MIN ROCE30%" value={filters.minRoce} onChange={v => setFilter('minRoce', v)}    placeholder="50" />
            <NumInput label="MIN PNL30$"  value={filters.minPnl}  onChange={v => setFilter('minPnl', v)}     placeholder="1000" />
            <NumInput label="MIN PF"   value={filters.minPf}      onChange={v => setFilter('minPf', v)}      placeholder="1.05" />
            <NumInput label="MIN DAYSW%" value={filters.minDaysWon} onChange={v => setFilter('minDaysWon', v)} placeholder="60" />
            <NumInput label="MIN SORTINO" value={filters.minSortino} onChange={v => setFilter('minSortino', v)} placeholder="1.0" />
            <NumInput label="MIN ACT/D" value={filters.minActPerDay} onChange={v => setFilter('minActPerDay', v)} placeholder="5" />
            <NumInput label="MAX ACT/D" value={filters.maxActPerDay} onChange={v => setFilter('maxActPerDay', v)} placeholder="500" />
            <NumInput label="MIN AGE D" value={filters.minAgeDays}   onChange={v => setFilter('minAgeDays', v)}   placeholder="90" />
          </div>
        </div>
      )}

      {/* ── Table ── */}
      <div className="bg-[#0A0A0A] border border-[#1A1A1A] rounded overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-[#1A1A1A]">
                {[
                  'Rank','Wallet','WinRate','ExpWR','n','Edge','P-val','Conf',
                  'ROCE30','PnL30','PF','DaysW%','Sortino','SpcWR%',
                  'Act/d','Age','Last','Insider','Specialty','Copy','Alloc','Action',
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
                  <td colSpan={22} className="px-4 py-6 text-center text-[#6E6E6E] text-xs">
                    No traders match the current filters.
                  </td>
                </tr>
              )}
              {displayed.map(t => {
                const conf  = confidenceBadge(t.confidence);
                const isBusy = toggling === t.wallet;
                const isFallen = t.qualificationStatus === 'fallen';
                return (
                  <tr key={t.wallet}
                    className={`border-b border-[#0F0F0F] hover:bg-[#111] transition-colors ${
                      t.isNewInRun ? 'bg-[#00C805]/5' : isFallen ? 'opacity-60' : ''
                    }`}>

                    {/* Rank */}
                    <td className="px-2 py-1.5 text-[#6E6E6E]">{t.overallRank}</td>

                    {/* Wallet */}
                    <td className="px-2 py-1.5 whitespace-nowrap">
                      <div className="flex items-center gap-1">
                        {t.isNewInRun && (
                          <span className="text-[8px] text-[#00C805] font-bold">NEW</span>
                        )}
                        {isFallen && (
                          <span className="text-[8px] text-[#FF4757] font-bold">▼</span>
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
                    <td className="px-2 py-1.5 text-[#6E6E6E]">{fmtPct(t.expectedWR * 100)}</td>

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

                    {/* Age */}
                    <td className="px-2 py-1.5 text-[#9E9E9E]">{fmtAge(t.firstActivityAt)}</td>

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
                      {t.allocAction
                        ? <span className="text-[10px] text-[#9E9E9E]">{t.allocAction}</span>
                        : '—'}
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
