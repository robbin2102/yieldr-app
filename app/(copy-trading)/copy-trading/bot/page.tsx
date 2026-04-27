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
  allocAfter: number | null;
  active: boolean;
  tier: 'active' | 'paused' | 'stopped';
}

interface SystemStats {
  totalTraders: number;
  activeTraders: number;
  pausedTraders?: number;
  stoppedTraders?: number;
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
  traderPrice: number | null;
  copyBetUsdc: number;
  status: string;
  skipReason: string | null;
  createdAt: string;
  filledUsdc: number | null;
  avgFillPrice: number | null;
  totalLatencyMs: number | null;
}

interface OpenPosition {
  title: string;
  outcome: string;
  traderLabel: string;
  traderHolding: boolean;
  traderPrice: number | null;
  driftPct: number | null;
  avgFillPrice: number;
  totalFilledUsdc: number;
  totalFilledSize: number;
  curPrice: number;
  currentValue: number;
  estimatedPnl: number;
  tokenId: string | null;
  conditionId: string | null;
  negRisk: boolean;
  redeemable: boolean;
}

interface PortfolioSummary {
  openCount: number;
  openValue: number;
  unrealizedPnl: number;
  totalBotPnl: number | null;
  botROCE: number | null;
  trades24h: number;
}

interface ExecWindow {
  label: string;
  detected: number;
  filled: number;
  execSkips: number;
  convFilter: number;
  fillRate: number | null;
  skipBreakdown: Record<string, number>;
}

interface ExecHealth {
  windows: ExecWindow[];
  trend: 'improving' | 'degrading' | 'stable' | 'insufficient';
  trendDelta: number;
  issues: { reason: string; count: number; suggestion: string }[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const ACTION_COLORS: Record<string, string> = {
  HARD_STOP: '#FF4757', SOFT_STOP: '#FF6B6B', SCALE_DOWN: '#FF8C00',
  SCALE_UP: '#00C805', CONTINUE: '#00C805', HOLD: '#9E9E9E',
  WATCH: '#FFD000', FIX_ENTRY: '#6BA3F5', INCREASE_ALLOC: '#6BA3F5',
};
function actionColor(code: string): string {
  for (const [k, c] of Object.entries(ACTION_COLORS)) {
    if ((code ?? '').toUpperCase().includes(k)) return c;
  }
  return '#9E9E9E';
}

function failureColor(t: string) {
  if (t === 'EXEC_FAIL')   return '#6BA3F5';
  if (t === 'TRADER_FAIL') return '#FF8C00';
  return '#444';
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

function fmt$(n: number, dec = 0): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1000) return `${sign}$${(abs / 1000).toFixed(1)}k`;
  return `${sign}$${abs.toFixed(dec)}`;
}

function fmtSigned$(n: number): string {
  const abs = Math.abs(n);
  const sign = n >= 0 ? '+' : '-';
  if (abs >= 1000) return `${sign}$${(abs / 1000).toFixed(1)}k`;
  return `${sign}$${abs.toFixed(2)}`;
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
  const m: Record<string, string> = {
    BELOW_AVG: 'below avg', ALLOCATION_FULL: 'alloc', POSITION_CAP_FULL: 'pos cap',
    NO_ORDERBOOK: 'no book', SELL_NO_POSITION: 'no pos', DUPLICATE: 'dup',
    ORDER_FAILED: 'fail', NON_TRADE: 'non-trade', WIDE_SPREAD: 'spread',
    PRICEDRIFT_FAILED: 'drift', GROUPED_BELOW_AVG: 'grouped',
  };
  return code ? (m[code] ?? code.toLowerCase()) : '';
}

function trendLabel(t: string, delta: number): { text: string; color: string } {
  if (t === 'improving') return { text: `↑ improving (+${(delta * 100).toFixed(1)}% vs 7d)`, color: '#00C805' };
  if (t === 'degrading') return { text: `↓ degrading (${(delta * 100).toFixed(1)}% vs 7d)`,  color: '#FF4757' };
  if (t === 'stable')    return { text: '→ stable vs 7d', color: '#9E9E9E' };
  return { text: 'insufficient data', color: '#6E6E6E' };
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function BotDashboard() {
  const [traders,     setTraders]     = useState<TraderRow[]>([]);
  const [systemStats, setSystemStats] = useState<SystemStats | null>(null);
  const [activity,    setActivity]    = useState<ActivityItem[]>([]);
  const [positions,   setPositions]   = useState<OpenPosition[]>([]);
  const [portSummary, setPortSummary] = useState<PortfolioSummary | null>(null);
  const [execHealth,  setExecHealth]  = useState<ExecHealth | null>(null);
  const [loading,     setLoading]     = useState(true);
  const [stopping,    setStopping]    = useState<string | null>(null);
  const [actStatus,   setActStatus]   = useState<string>('ALL');
  const [actTrader,   setActTrader]   = useState<string>('ALL');
  const [showStopped, setShowStopped] = useState(false);
  const [adminBusy,      setAdminBusy]      = useState<string | null>(null);
  const [adminLog,       setAdminLog]       = useState<string | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<string | null>(null);
  const [botRunning,     setBotRunning]     = useState<boolean | null>(null);
  const [botCtrlBusy,    setBotCtrlBusy]    = useState(false);
  const [editingAlloc,   setEditingAlloc]   = useState<string | null>(null);
  const [allocInput,     setAllocInput]     = useState('');
  const [allocSaving,    setAllocSaving]    = useState<string | null>(null);

  async function fetchAll() {
    try {
      const [statsRes, actRes, posRes, execRes, botStatusRes] = await Promise.all([
        fetch('/api/copy-trading/bot-stats'),
        fetch('/api/copy-trading/activity'),
        fetch('/api/copy-trading/open-positions'),
        fetch('/api/copy-trading/exec-health'),
        fetch('/api/copy-trading/admin/bot-status'),
      ]);
      const [s, a, p, e, bs] = await Promise.all([
        statsRes.json(), actRes.json(), posRes.json(), execRes.json(), botStatusRes.json(),
      ]);
      if (s.success) { setTraders(s.traders); setSystemStats(s.systemStats); }
      if (a.success) setActivity(a.activity);
      if (p.success) { setPositions(p.positions); setPortSummary(p.summary); }
      if (e.success) setExecHealth(e);
      setBotRunning(bs.running ?? false);
    } catch (err) { console.error(err); }
    finally { setLoading(false); }
  }

  async function controlBot(action: 'start' | 'stop') {
    setBotCtrlBusy(true);
    try {
      const res  = await fetch(`/api/copy-trading/admin/bot-${action}`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        setBotRunning(action === 'start');
      } else {
        setAdminLog(`[BOT ${action.toUpperCase()}] ${data.error ?? data.message ?? 'Failed'}`);
      }
    } catch (e: any) {
      setAdminLog(`[BOT ${action.toUpperCase()}] error: ${e.message}`);
    } finally { setBotCtrlBusy(false); }
  }

  useEffect(() => {
    fetchAll();
    const iv = setInterval(fetchAll, 60_000);
    return () => clearInterval(iv);
  }, []);

  async function redeemAll() {
    if (pendingConfirm !== 'redeem-all') { setPendingConfirm('redeem-all'); return; }
    setPendingConfirm(null);
    setAdminBusy('redeem-all');
    setAdminLog('[REDEEM ALL] running…');
    try {
      const res  = await fetch('/api/copy-trading/admin/redeem-all', { method: 'POST' });
      const data = await res.json();
      setAdminLog(`[REDEEM ALL] exit=${data.exitCode ?? '?'}\n\n${data.stdout || ''}${data.stderr ? '\n--- STDERR ---\n' + data.stderr : ''}`);
      fetchAll();
    } catch (e: any) {
      setAdminLog(`[REDEEM ALL] error: ${e.message}`);
    } finally { setAdminBusy(null); }
  }

  async function sellPosition(p: OpenPosition) {
    if (!p.tokenId) { setAdminLog('No tokenId available for this position'); return; }
    if (pendingConfirm !== p.tokenId) { setPendingConfirm(p.tokenId); return; }
    setPendingConfirm(null);
    setAdminBusy(p.tokenId);
    const header = `[SELL ${p.title.slice(0, 40)}]`;
    const lines: string[] = [`${header} connecting…`];
    setAdminLog(lines.join('\n'));
    try {
      const res = await fetch('/api/copy-trading/admin/sell-position', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ tokenId: p.tokenId, size: p.totalFilledSize }),
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({})) as any;
        setAdminLog(`${header} error: ${data.error ?? res.statusText}`);
        return;
      }
      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split('\n\n');
        buffer = chunks.pop() ?? '';
        for (const chunk of chunks) {
          const match = chunk.match(/^data: (.+)$/m);
          if (!match) continue;
          try {
            const ev = JSON.parse(match[1]);
            if (ev.line) { lines.push(ev.line); setAdminLog(lines.join('\n')); }
            if (ev.done) { lines.push(`\n${header} exit=${ev.exitCode}`); setAdminLog(lines.join('\n')); }
          } catch { /* ignore malformed SSE */ }
        }
      }
      fetchAll();
    } catch (e: any) {
      setAdminLog(`${header} error: ${e.message}`);
    } finally { setAdminBusy(null); }
  }

  async function sellAll() {
    const sellable = positions.filter(p => !p.redeemable && p.tokenId && (p.totalFilledSize ?? 0) > 0);
    if (sellable.length === 0) return;
    if (pendingConfirm !== 'sell-all') { setPendingConfirm('sell-all'); return; }
    setPendingConfirm(null);
    setAdminBusy('sell-all');
    const lines: string[] = [`[SELL ALL] closing ${sellable.length} position(s)…`];
    setAdminLog(lines.join('\n'));

    for (const p of sellable) {
      lines.push(`\n[SELL] ${p.title.slice(0, 50)}`);
      setAdminLog(lines.join('\n'));
      try {
        const res = await fetch('/api/copy-trading/admin/sell-position', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ tokenId: p.tokenId, size: p.totalFilledSize }),
        });
        if (!res.ok || !res.body) {
          const data = await res.json().catch(() => ({})) as any;
          lines.push(`  ✗ ${data.error ?? res.statusText}`);
          setAdminLog(lines.join('\n'));
          continue;
        }
        const reader  = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const chunks = buffer.split('\n\n');
          buffer = chunks.pop() ?? '';
          for (const chunk of chunks) {
            const match = chunk.match(/^data: (.+)$/m);
            if (!match) continue;
            try {
              const ev = JSON.parse(match[1]);
              if (ev.line) { lines.push(`  ${ev.line}`); setAdminLog(lines.join('\n')); }
              if (ev.done) { lines.push(`  exit=${ev.exitCode}`); setAdminLog(lines.join('\n')); }
            } catch { /* ignore */ }
          }
        }
      } catch (e: any) {
        lines.push(`  ✗ ${e.message}`);
        setAdminLog(lines.join('\n'));
      }
    }

    lines.push('\n[SELL ALL] done');
    setAdminLog(lines.join('\n'));
    setAdminBusy(null);
    fetchAll();
  }

  async function patchTrader(wallet: string, action: 'start' | 'stop' | 'remove') {
    if (action === 'remove' && !confirm('Remove this trader from the detector? They will be hidden from the summary. Open positions will remain — use REDEEM/SELL to exit them.')) return;
    setStopping(wallet);
    try {
      await fetch('/api/copy-trading/edge-ranked', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet, action }),
      });
      if (action === 'remove') {
        setTraders(prev => prev.filter(t => t.wallet !== wallet));
      } else {
        await fetchAll();
      }
    } finally { setStopping(null); }
  }

  async function saveAlloc(wallet: string, inputStr: string) {
    const newAlloc = parseFloat(inputStr);
    if (!Number.isFinite(newAlloc) || newAlloc < 0) return;
    setAllocSaving(wallet);
    try {
      const res = await fetch('/api/copy-trading/edge-ranked', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet, action: 'alloc', allocationUsdc: newAlloc }),
      });
      const data = await res.json();
      if (data.success) {
        setTraders(prev => prev.map(t => t.wallet === wallet ? { ...t, allocationUsdc: newAlloc } : t));
        setEditingAlloc(null);
      }
    } finally { setAllocSaving(null); }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 font-mono text-[#6E6E6E]">
        LOADING...
      </div>
    );
  }

  const trend = execHealth
    ? trendLabel(execHealth.trend, execHealth.trendDelta)
    : null;

  return (
    <div className="space-y-4 font-mono">

      {/* ── Bot Control Bar ── */}
      <div className="bg-[#0A0A0A] border border-[#1A1A1A] rounded px-4 py-2.5 flex items-center gap-3">
        <div className={`w-2 h-2 rounded-full flex-shrink-0 ${
          botRunning === null ? 'bg-[#444]' :
          botRunning ? 'bg-[#00C805] shadow-[0_0_6px_#00C805]' : 'bg-[#FF4757]'
        }`} />
        <span className="text-[10px] text-[#6E6E6E] tracking-widest">TRADING BOT</span>
        <span className="text-[11px] font-bold" style={{
          color: botRunning === null ? '#444' : botRunning ? '#00C805' : '#FF4757'
        }}>
          {botRunning === null ? 'CHECKING…' : botRunning ? 'RUNNING' : 'STOPPED'}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {!botRunning && (
            <button
              disabled={botCtrlBusy || botRunning === null}
              onClick={() => controlBot('start')}
              className="px-3 py-1 text-[10px] font-bold rounded border border-[#00C805] text-[#00C805] hover:bg-[#00C80515] disabled:opacity-40 transition-colors">
              {botCtrlBusy ? 'STARTING…' : 'START BOT'}
            </button>
          )}
          {botRunning && (
            <button
              disabled={botCtrlBusy}
              onClick={() => controlBot('stop')}
              className="px-3 py-1 text-[10px] font-bold rounded border border-[#FF4757] text-[#FF4757] hover:bg-[#FF475715] disabled:opacity-40 transition-colors">
              {botCtrlBusy ? 'STOPPING…' : 'STOP BOT'}
            </button>
          )}
        </div>
      </div>

      {/* ── System Strip (4 boxes) ── */}
      <div className="grid grid-cols-4 gap-2">
        {[
          { label: 'TRADERS',  value: `${systemStats?.activeTraders ?? 0} active / ${systemStats?.totalTraders ?? 0}` },
          { label: 'DET/FILL', value: `${systemStats?.totalFilled ?? 0} / ${systemStats?.totalDetected ?? 0}` },
          { label: 'BOT PnL',  value: fmtSigned$(systemStats?.totalBotPnl ?? 0),
            color: (systemStats?.totalBotPnl ?? 0) >= 0 ? '#00C805' : '#FF4757' },
          { label: 'MISSED',   value: fmtSigned$(systemStats?.totalMissedPnl ?? 0),
            color: (systemStats?.totalMissedPnl ?? 0) > 0 ? '#FF8C00' : '#6E6E6E' },
        ].map(({ label, value, color }) => (
          <div key={label} className="bg-[#0A0A0A] border border-[#1A1A1A] rounded px-4 py-3">
            <div className="text-[9px] text-[#6E6E6E] tracking-widest mb-1">{label}</div>
            <div className="text-sm font-bold" style={{ color: color ?? '#E0E0E0' }}>{value}</div>
          </div>
        ))}
      </div>

      {/* ── Trader Summary (three-tier) ── */}
      {(() => {
        const activeRows  = traders.filter(t => t.tier === 'active');
        const pausedRows  = traders.filter(t => t.tier === 'paused');
        const stoppedRows = traders.filter(t => t.tier === 'stopped');

        const HEADERS = ['Trader','T.PnL','B.PnL','tROCE','bROCE','T.Act','B.Act','Det/Fill',
          'Edge','Missed','Alloc','Action','Failure',''];

        function renderRow(t: TraderRow) {
          const aC    = actionColor(t.actionCode);
          const dimmed = t.tier !== 'active';
          return (
            <tr key={t.wallet}
              className={`border-b border-[#0F0F0F] hover:bg-[#111] transition-colors ${dimmed ? 'opacity-60' : ''}`}>
              <td className="px-2 py-1.5 whitespace-nowrap">
                <Link href={`/copy-trading/bot/${t.wallet}`} className="flex items-center gap-1.5 group">
                  <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                    t.tier === 'active' ? 'bg-[#00C805]' :
                    t.tier === 'paused' ? 'bg-[#FFD000]' : 'bg-[#FF4757]'
                  }`} />
                  <span className="text-[#E0E0E0] group-hover:text-[#00C805] transition-colors font-medium">
                    {t.label}
                  </span>
                </Link>
              </td>
              <td className="px-2 py-1.5 font-bold" style={{ color: t.tTotal >= 0 ? '#00C805' : '#FF4757' }}>{fmtSigned$(t.tTotal)}</td>
              <td className="px-2 py-1.5 font-bold" style={{ color: t.bPnl >= 0 ? '#00C805' : '#FF4757' }}>{fmtSigned$(t.bPnl)}</td>
              <td className="px-2 py-1.5" style={{ color: t.traderROCE >= 0 ? '#00C805' : '#FF4757' }}>{fmtPct(t.traderROCE)}</td>
              <td className="px-2 py-1.5" style={{ color: t.botROCE >= 0 ? '#00C805' : '#FF4757' }}>{fmtPct(t.botROCE)}</td>
              <td className="px-2 py-1.5 text-[#9E9E9E]">{t.tAct24h}</td>
              <td className="px-2 py-1.5 text-[#9E9E9E]">{t.bAct24h}</td>
              <td className="px-2 py-1.5 text-[#9E9E9E] whitespace-nowrap">
                {t.detected > 0 ? `${t.filled}/${t.detected}` : '—'}
                {t.execSkipRate > 0.3 && (
                  <span className="ml-1 text-[#FF8C00]">({(t.execSkipRate * 100).toFixed(0)}%)</span>
                )}
              </td>
              <td className="px-2 py-1.5 text-[#9E9E9E]">
                {t.edgeScore != null ? t.edgeScore.toFixed(3) : '—'}
                {t.edgeConfidence === 'confirmed' && <span className="ml-0.5 text-[8px] text-[#00C805]">✓</span>}
              </td>
              <td className="px-2 py-1.5" style={{ color: t.missedPnl > 0 ? '#FF8C00' : '#6E6E6E' }}>
                {t.missedPnl > 0 ? fmtSigned$(t.missedPnl) : '—'}
              </td>
              <td className="px-2 py-1.5 whitespace-nowrap">
                {editingAlloc === t.wallet ? (
                  <div className="flex items-center gap-1">
                    <span className="text-[#444] text-[10px]">$</span>
                    <input
                      type="number"
                      min="0"
                      value={allocInput}
                      onChange={e => setAllocInput(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') saveAlloc(t.wallet, allocInput);
                        if (e.key === 'Escape') setEditingAlloc(null);
                      }}
                      className="w-14 bg-[#1A1A1A] border border-[#333] rounded px-1 py-0.5 text-[11px] text-[#E0E0E0] focus:outline-none focus:border-[#00C805]"
                      autoFocus
                    />
                    <button
                      disabled={allocSaving === t.wallet}
                      onClick={() => saveAlloc(t.wallet, allocInput)}
                      className="px-1.5 py-0.5 text-[9px] rounded border border-[#00C805]/40 text-[#00C805] hover:bg-[#00C805]/10 disabled:opacity-40 transition-colors">
                      {allocSaving === t.wallet ? '…' : '✓'}
                    </button>
                    <button onClick={() => setEditingAlloc(null)}
                      className="text-[#6E6E6E] hover:text-[#E0E0E0] text-[10px] transition-colors">✕</button>
                  </div>
                ) : (
                  <div className="flex items-center gap-1">
                    <span className="text-[#9E9E9E]">
                      {fmt$(t.spentUsdc)}<span className="text-[#444]">/</span>{fmt$(t.allocationUsdc)}
                    </span>
                    {t.allocAfter != null && t.allocAfter !== t.allocationUsdc && (
                      <span className="text-[9px]" style={{ color: t.allocAfter > t.allocationUsdc ? '#00C805' : '#FF8C00' }}>
                        →{fmt$(t.allocAfter)}
                      </span>
                    )}
                    <button
                      onClick={() => { setEditingAlloc(t.wallet); setAllocInput(String(t.allocationUsdc)); }}
                      className="text-[#444] hover:text-[#9E9E9E] text-[11px] leading-none transition-colors"
                      title="Edit allocation">
                      ✎
                    </button>
                  </div>
                )}
              </td>
              <td className="px-2 py-1.5">
                <span className="font-bold text-[10px]" style={{ color: aC }}>{t.actionCode || '—'}</span>
              </td>
              <td className="px-2 py-1.5 whitespace-nowrap">
                {t.failureType !== 'NONE' ? (
                  <span className="text-[10px] font-bold" style={{ color: failureColor(t.failureType) }}>
                    {t.failureType === 'EXEC_FAIL' ? 'EXEC' : 'TRADER'}
                  </span>
                ) : <span className="text-[#444] text-[10px]">—</span>}
              </td>
              <td className="px-2 py-1.5 whitespace-nowrap">
                <div className="flex items-center gap-1">
                  {t.tier !== 'stopped' && (
                    <button
                      disabled={stopping === t.wallet}
                      onClick={() => patchTrader(t.wallet, 'stop')}
                      className="px-2 py-0.5 text-[10px] rounded border border-[#FF4757]/30 text-[#FF4757] hover:bg-[#FF4757]/10 transition-colors disabled:opacity-40">
                      {stopping === t.wallet ? '…' : 'STOP'}
                    </button>
                  )}
                  {t.tier === 'stopped' && (
                    <>
                      <button
                        disabled={stopping === t.wallet}
                        onClick={() => patchTrader(t.wallet, 'start')}
                        className="px-2 py-0.5 text-[10px] rounded border border-[#00C805]/40 text-[#00C805] hover:bg-[#00C805]/10 transition-colors disabled:opacity-40">
                        RESUME
                      </button>
                      <button
                        disabled={stopping === t.wallet}
                        onClick={() => patchTrader(t.wallet, 'remove')}
                        className="px-2 py-0.5 text-[10px] rounded border border-[#6E6E6E]/40 text-[#6E6E6E] hover:bg-[#6E6E6E]/10 transition-colors disabled:opacity-40">
                        REMOVE
                      </button>
                    </>
                  )}
                </div>
              </td>
            </tr>
          );
        }

        function renderTable(rows: TraderRow[]) {
          return (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-[#1A1A1A]">
                    {HEADERS.map(h => (
                      <th key={h} className="px-2 py-1.5 text-left text-[10px] text-[#6E6E6E] tracking-wider whitespace-nowrap font-normal">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>{rows.map(renderRow)}</tbody>
              </table>
            </div>
          );
        }

        return (
          <div className="space-y-3">
            {/* Active + Paused — single table, visually grouped */}
            <div className="bg-[#0A0A0A] border border-[#1A1A1A] rounded overflow-hidden">
              <div className="px-4 py-2 border-b border-[#1A1A1A] flex items-center justify-between">
                <span className="text-[10px] text-[#00C805] tracking-widest font-bold">TRADER SUMMARY</span>
                <span className="text-[10px] text-[#6E6E6E]">
                  {activeRows.length} active
                  {pausedRows.length > 0 && <span className="text-[#FFD000]"> · {pausedRows.length} paused</span>}
                  {stoppedRows.length > 0 && <span className="text-[#6E6E6E]"> · {stoppedRows.length} stopped</span>}
                </span>
              </div>
              {activeRows.length + pausedRows.length === 0 ? (
                <div className="px-4 py-6 text-center text-[#6E6E6E] text-xs">No active or paused traders</div>
              ) : (
                renderTable([...activeRows, ...pausedRows])
              )}
            </div>

            {/* Stopped — collapsed by default */}
            {stoppedRows.length > 0 && (
              <div className="bg-[#0A0A0A] border border-[#1A1A1A] rounded overflow-hidden">
                <button
                  onClick={() => setShowStopped(v => !v)}
                  className="w-full px-4 py-2 border-b border-[#1A1A1A] flex items-center justify-between hover:bg-[#111] transition-colors">
                  <span className="text-[10px] text-[#6E6E6E] tracking-widest font-bold">
                    {showStopped ? '▼' : '▶'} STOPPED ({stoppedRows.length})
                  </span>
                  <span className="text-[10px] text-[#6E6E6E]">RESUME or REMOVE</span>
                </button>
                {showStopped && renderTable(stoppedRows)}
              </div>
            )}
          </div>
        );
      })()}

      {/* ── Portfolio Strip + Open Positions ── */}
      {portSummary && (
        <div className="bg-[#0A0A0A] border border-[#1A1A1A] rounded overflow-hidden">
          <div className="px-4 py-2 border-b border-[#1A1A1A] flex items-center justify-between">
            <span className="text-[10px] text-[#00C805] tracking-widest font-bold">BOT PORTFOLIO</span>
            <div className="flex items-center gap-2">
              {positions.some(p => !p.redeemable && p.tokenId && (p.totalFilledSize ?? 0) > 0) && (
                <button
                  disabled={!!adminBusy}
                  onClick={sellAll}
                  className={`px-2 py-0.5 text-[10px] rounded border transition-colors disabled:opacity-40 font-bold ${
                    pendingConfirm === 'sell-all'
                      ? 'border-[#FF4757]/70 text-[#FF4757] bg-[#FF4757]/10'
                      : 'border-[#FF8C00]/40 text-[#FF8C00] hover:bg-[#FF8C00]/10'
                  }`}>
                  {adminBusy === 'sell-all' ? 'SELLING…' : pendingConfirm === 'sell-all' ? 'CONFIRM?' : 'SELL ALL'}
                </button>
              )}
              {positions.some(p => p.redeemable) && (
                <button
                  disabled={adminBusy === 'redeem-all'}
                  onClick={redeemAll}
                  className={`px-2 py-0.5 text-[10px] rounded border transition-colors disabled:opacity-40 font-bold ${
                    pendingConfirm === 'redeem-all'
                      ? 'border-[#FF4757]/70 text-[#FF4757] bg-[#FF4757]/10'
                      : 'border-[#00C805]/40 text-[#00C805] hover:bg-[#00C805]/10'
                  }`}>
                  {adminBusy === 'redeem-all' ? 'REDEEMING…' : pendingConfirm === 'redeem-all' ? 'CONFIRM?' : 'REDEEM ALL'}
                </button>
              )}
            </div>
          </div>
          {/* Summary strip */}
          <div className="grid grid-cols-6 gap-0 border-b border-[#1A1A1A]">
            {[
              { label: 'OPEN POS',      value: String(portSummary.openCount) },
              { label: 'OPEN VALUE',    value: fmt$(portSummary.openValue, 2) },
              { label: 'UNREAL. PnL',  value: fmtSigned$(portSummary.unrealizedPnl),
                color: portSummary.unrealizedPnl >= 0 ? '#00C805' : '#FF4757' },
              { label: 'TOTAL PnL',    value: portSummary.totalBotPnl != null
                  ? fmtSigned$(portSummary.totalBotPnl) : '—',
                color: (portSummary.totalBotPnl ?? 0) >= 0 ? '#00C805' : '#FF4757' },
              { label: 'BOT ROCE',     value: portSummary.botROCE != null
                  ? fmtPct(portSummary.botROCE) : '—',
                color: (portSummary.botROCE ?? 0) >= 0 ? '#00C805' : '#FF4757' },
              { label: 'TRADES 24h',   value: String(portSummary.trades24h) },
            ].map(({ label, value, color }) => (
              <div key={label} className="px-4 py-3 border-r border-[#1A1A1A] last:border-r-0">
                <div className="text-[9px] text-[#6E6E6E] tracking-widest mb-1">{label}</div>
                <div className="text-sm font-bold" style={{ color: color ?? '#E0E0E0' }}>{value}</div>
              </div>
            ))}
          </div>
          {/* Positions table */}
          {positions.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-[#1A1A1A]">
                    {['Market','Out','Trader','T.Price','B.Entry','Drift%','Cur Price','Cur Value','Est PnL','T.Hold','Action'].map(h => (
                      <th key={h} className="px-2 py-1.5 text-left text-[10px] text-[#6E6E6E] tracking-wider whitespace-nowrap font-normal">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {positions.map((p, i) => (
                    <tr key={i} className="border-b border-[#0F0F0F] hover:bg-[#111] transition-colors">
                      <td className="px-2 py-1.5 max-w-[240px] truncate text-[#E0E0E0]">{p.title}</td>
                      <td className="px-2 py-1.5">
                        <span className={`font-bold ${p.outcome?.toLowerCase() === 'yes' ? 'text-[#00C805]' : 'text-[#FF4757]'}`}>
                          {p.outcome?.toUpperCase()}
                        </span>
                      </td>
                      <td className="px-2 py-1.5 text-[#9E9E9E]">{p.traderLabel}</td>
                      <td className="px-2 py-1.5 text-[#9E9E9E]">
                        {p.traderPrice != null ? p.traderPrice.toFixed(3) : '—'}
                      </td>
                      <td className="px-2 py-1.5 text-[#9E9E9E]">{p.avgFillPrice.toFixed(3)}</td>
                      <td className="px-2 py-1.5 font-bold"
                        style={{ color: p.driftPct == null ? '#6E6E6E' : p.driftPct > 2 ? '#FF8C00' : p.driftPct < -2 ? '#00C805' : '#9E9E9E' }}>
                        {p.driftPct != null ? `${p.driftPct >= 0 ? '+' : ''}${p.driftPct.toFixed(1)}%` : '—'}
                      </td>
                      <td className="px-2 py-1.5 text-[#9E9E9E]">{p.curPrice.toFixed(3)}</td>
                      <td className="px-2 py-1.5 text-[#9E9E9E]">{fmt$(p.currentValue, 2)}</td>
                      <td className="px-2 py-1.5 font-bold"
                        style={{ color: p.estimatedPnl >= 0 ? '#00C805' : '#FF4757' }}>
                        {fmtSigned$(p.estimatedPnl)}
                      </td>
                      <td className="px-2 py-1.5">
                        <span className="text-[10px] font-bold"
                          style={{ color: p.traderHolding ? '#00C805' : '#FF4757' }}>
                          {p.traderHolding ? 'HOLD' : 'EXIT'}
                        </span>
                      </td>
                      <td className="px-2 py-1.5 whitespace-nowrap">
                        {!p.traderHolding && !p.redeemable && p.tokenId && (
                          <button
                            disabled={adminBusy === p.tokenId}
                            onClick={() => sellPosition(p)}
                            className={`px-2 py-0.5 text-[10px] rounded border transition-colors disabled:opacity-40 font-bold ${
                              pendingConfirm === p.tokenId
                                ? 'border-[#FF4757]/70 text-[#FF4757] bg-[#FF4757]/10'
                                : 'border-[#FF8C00]/40 text-[#FF8C00] hover:bg-[#FF8C00]/10'
                            }`}>
                            {adminBusy === p.tokenId ? '…' : pendingConfirm === p.tokenId ? 'CONFIRM?' : 'SELL'}
                          </button>
                        )}
                        {p.redeemable && (
                          <span className="text-[9px] text-[#00C805]">resolved</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="px-4 py-5 text-xs text-[#6E6E6E]">
              No confirmed open positions — either no fills yet, or pipeline data is stale.
              Run the pipeline to refresh position data.
            </div>
          )}
        </div>
      )}

      {/* ── Admin action log (modal overlay) ── */}
      {adminLog && (
        <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4"
          onClick={() => { if (!adminBusy) { setAdminLog(null); setPendingConfirm(null); } }}>
          <div className="bg-[#0A0A0A] border border-[#1A1A1A] rounded max-w-3xl w-full max-h-[80vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}>
            <div className="px-4 py-2 border-b border-[#1A1A1A] flex items-center justify-between">
              <span className="text-[10px] text-[#00C805] tracking-widest font-bold">
                ADMIN OUTPUT {adminBusy && <span className="ml-2 text-[#FFD000]">● RUNNING</span>}
              </span>
              <button
                disabled={!!adminBusy}
                onClick={() => setAdminLog(null)}
                className="text-[10px] text-[#6E6E6E] hover:text-[#E0E0E0] transition-colors disabled:opacity-40">
                close ✕
              </button>
            </div>
            <pre className="flex-1 px-4 py-3 text-[10px] text-[#9E9E9E] whitespace-pre-wrap overflow-auto">{adminLog}</pre>
          </div>
        </div>
      )}

      {/* ── Live Activity Log ── */}
      <div className="bg-[#0A0A0A] border border-[#1A1A1A] rounded overflow-hidden">
        <div className="px-4 py-2 border-b border-[#1A1A1A] flex items-center gap-3 flex-wrap">
          <span className="text-[10px] text-[#00C805] tracking-widest font-bold">LIVE ACTIVITY</span>
          {/* Status filter */}
          <div className="flex items-center gap-1">
            {['ALL','FILLED','SKIPPED','FAILED'].map(s => (
              <button key={s} onClick={() => setActStatus(s)}
                className="px-2 py-0.5 text-[9px] rounded border transition-colors"
                style={{
                  borderColor: actStatus === s ? '#00C805' : '#1A1A1A',
                  color: actStatus === s ? '#00C805' : '#6E6E6E',
                  background: actStatus === s ? '#00C80510' : 'transparent',
                }}>
                {s}
              </button>
            ))}
          </div>
          {/* Trader filter */}
          {traders.length > 0 && (
            <div className="flex items-center gap-1 flex-wrap">
              <button onClick={() => setActTrader('ALL')}
                className="px-2 py-0.5 text-[9px] rounded border transition-colors"
                style={{
                  borderColor: actTrader === 'ALL' ? '#00C805' : '#1A1A1A',
                  color: actTrader === 'ALL' ? '#00C805' : '#6E6E6E',
                  background: actTrader === 'ALL' ? '#00C80510' : 'transparent',
                }}>
                ALL TRADERS
              </button>
              {[...new Set(activity.map(a => a.traderLabel))].filter(Boolean).map(label => (
                <button key={label} onClick={() => setActTrader(label)}
                  className="px-2 py-0.5 text-[9px] rounded border transition-colors"
                  style={{
                    borderColor: actTrader === label ? '#00C805' : '#1A1A1A',
                    color: actTrader === label ? '#00C805' : '#6E6E6E',
                    background: actTrader === label ? '#00C80510' : 'transparent',
                  }}>
                  {label}
                </button>
              ))}
            </div>
          )}
          <span className="ml-auto text-[10px] text-[#6E6E6E]">last {activity.length}</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-[#1A1A1A]">
                {['Time','Trader','Market','Dir','Trader $','T.Price','Bot $','B.Price','Status','Note'].map(h => (
                  <th key={h} className="px-2 py-1.5 text-left text-[10px] text-[#6E6E6E] tracking-wider font-normal whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {activity.length === 0 && (
                <tr><td colSpan={10} className="px-4 py-6 text-center text-[#6E6E6E]">No activity</td></tr>
              )}
              {activity.filter(a =>
                (actStatus === 'ALL' || a.status === actStatus) &&
                (actTrader === 'ALL' || a.traderLabel === actTrader)
              ).map(a => (
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
                    {a.traderPrice != null ? a.traderPrice.toFixed(3) : '—'}
                  </td>
                  <td className="px-2 py-1.5 text-[#9E9E9E]">
                    {a.status === 'FILLED' && a.filledUsdc != null ? fmt$(a.filledUsdc, 2) : a.copyBetUsdc > 0 ? fmt$(a.copyBetUsdc) : '—'}
                  </td>
                  <td className="px-2 py-1.5 text-[#9E9E9E]">
                    {a.status === 'FILLED' && a.avgFillPrice != null ? a.avgFillPrice.toFixed(3) : '—'}
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

      {/* ── Exec Health by Timeframe ── */}
      {execHealth && (
        <div className="bg-[#0A0A0A] border border-[#1A1A1A] rounded overflow-hidden">
          <div className="px-4 py-2 border-b border-[#1A1A1A] flex items-center justify-between">
            <span className="text-[10px] text-[#00C805] tracking-widest font-bold">EXECUTION HEALTH</span>
            {trend && (
              <span className="text-[10px] font-bold" style={{ color: trend.color }}>
                {trend.text}
              </span>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-[#1A1A1A]">
                  {['Period','Detected','Filled','Fill%','Exec Skips','Conv Filter','Trend vs 7d'].map(h => (
                    <th key={h} className="px-3 py-1.5 text-left text-[10px] text-[#6E6E6E] tracking-wider font-normal whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {execHealth.windows.map((w, i) => {
                  const fillPct = w.fillRate != null ? (w.fillRate * 100).toFixed(1) + '%' : '—';
                  const base7d  = execHealth.windows[1]?.fillRate;
                  let trendCell = '—';
                  let trendClr  = '#6E6E6E';
                  if (i > 0 && w.fillRate != null && base7d != null) {
                    const d = w.fillRate - base7d;
                    trendCell = d >= 0 ? `+${(d * 100).toFixed(1)}%` : `${(d * 100).toFixed(1)}%`;
                    trendClr  = d > 0.02 ? '#00C805' : d < -0.02 ? '#FF4757' : '#9E9E9E';
                  }
                  if (i === 1) { trendCell = '(base)'; trendClr = '#6E6E6E'; }
                  return (
                    <tr key={w.label} className="border-b border-[#0F0F0F]">
                      <td className="px-3 py-1.5 text-[#9E9E9E] font-bold">{w.label}</td>
                      <td className="px-3 py-1.5 text-[#9E9E9E]">{w.detected}</td>
                      <td className="px-3 py-1.5 text-[#9E9E9E]">{w.filled}</td>
                      <td className="px-3 py-1.5 font-bold"
                        style={{ color: w.fillRate != null && w.fillRate > 0.5 ? '#00C805' : '#FF8C00' }}>
                        {fillPct}
                      </td>
                      <td className="px-3 py-1.5 text-[#9E9E9E]">{w.execSkips}</td>
                      <td className="px-3 py-1.5 text-[#6E6E6E]">{w.convFilter}</td>
                      <td className="px-3 py-1.5" style={{ color: trendClr }}>{trendCell}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

    </div>
  );
}
