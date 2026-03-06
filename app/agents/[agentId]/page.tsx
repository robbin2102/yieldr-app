'use client';

import { useState, useEffect } from 'react';
import { useAccount } from 'wagmi';
import { useRouter, useParams } from 'next/navigation';
import s from './agent.module.css';

interface IndicatorRead {
  name: string;
  value: string;
  dot: 'green' | 'yellow' | 'red' | 'blue' | 'purple';
  note: string;
}

interface Signal {
  id: string;
  title: string;
  message: string;
  severity: 'info' | 'warning' | 'critical';
  isSignal: boolean;
  indicators: IndicatorRead[];
  cycleNumber: number;
  read: boolean;
  createdAt: string;
}

interface AgentDetail {
  agent: {
    agentId: string;
    name: string;
    ownerWallet: string;
    markets: string[];
    status: string;
    alertsSent: number;
    insightsGenerated: number;
    createdAt: string;
  };
  task: {
    id: string;
    title: string;
    intervalSeconds: number;
    status: string;
    nextRunAt: string | null;
    lastRunAt: string | null;
    cycleCount: number;
    alertCount: number;
    signalCount: number;
    createdAt: string;
  } | null;
  latestRead: {
    timestamp: string | null;
    summary: string | null;
    indicators: IndicatorRead[];
  };
  signals: Signal[];
}

const MARKET_ICONS: Record<string, string> = {
  perps: '⚡',
  predictions: '🎲',
  liquidity: '💧',
};

function intervalLabel(seconds: number): string {
  if (seconds < 3600) return `Every ${seconds / 60}m`;
  if (seconds < 86400) return `Every ${seconds / 3600}h`;
  return `Every ${seconds / 86400}d`;
}

function timeAgo(iso: string | null): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function timeUntil(iso: string | null): string {
  if (!iso) return '—';
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return 'Imminent';
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

function dotClass(dot: string): string {
  switch (dot) {
    case 'green':  return s.dotG;
    case 'yellow': return s.dotY;
    case 'red':    return s.dotR;
    case 'purple': return s.dotP;
    default:       return s.dotB;
  }
}

function severityClass(severity: string): string {
  switch (severity) {
    case 'critical': return s.sigCrit;
    case 'warning':  return s.sigWarn;
    default:         return s.sigInfo;
  }
}

function severityLabel(severity: string, isSignal: boolean): string {
  if (!isSignal) return 'Nominal';
  if (severity === 'critical') return 'Alert';
  if (severity === 'warning') return 'Watch';
  return 'Signal';
}

export default function AgentDetailPage() {
  const { address } = useAccount();
  const router = useRouter();
  const params = useParams();
  const agentId = params?.agentId as string;

  const [data, setData] = useState<AgentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [readOpen, setReadOpen] = useState(true);
  const [signalsOpen, setSignalsOpen] = useState(true);

  useEffect(() => {
    if (!agentId) return;
    fetchDetail();
  }, [agentId, address]);

  async function fetchDetail() {
    setLoading(true);
    try {
      const walletParam = address ? `&wallet=${address}` : '';
      const res = await fetch(`/api/demo/agents/${agentId}/detail?${walletParam}`);
      if (res.ok) {
        setData(await res.json());
      }
    } catch (e) {
      console.error('Failed to fetch agent detail', e);
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <div className={s.page}>
        <div className={s.loadingState}>Loading agent...</div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className={s.page}>
        <div className={s.loadingState}>Agent not found</div>
      </div>
    );
  }

  const { agent, task, latestRead, signals } = data;
  const isActive = task?.status === 'active';
  const marketIcons = agent.markets.map(m => MARKET_ICONS[m] ?? '🔧').join('');

  return (
    <div className={s.page}>
      {/* Breadcrumb */}
      <div className={s.breadcrumb}>
        <span className={s.bcLink} onClick={() => router.push('/agents')}>← Agents</span>
        <span className={s.bcSep}>/</span>
        <span className={s.bcCur}>{agent.name}</span>
      </div>

      {/* ── HERO ── */}
      <div className={s.hero}>
        <div className={s.heroAccent} />
        <div className={s.heroBody}>
          <div className={s.heroTop}>
            <div className={s.heroIcon} style={{ background: 'linear-gradient(145deg,#0d1f3c,#162d52)' }}>
              {marketIcons || '🤖'}
            </div>
            <div className={s.heroMeta}>
              <div className={s.heroName}>{agent.name}</div>
              <div className={s.heroMandate}>{task?.title ?? 'Monitoring agent'}</div>
              <div className={s.heroTags}>
                {agent.markets.map(m => (
                  <span key={m} className={`${s.htag} ${s[`htag_${m}`] ?? ''}`}>
                    {m === 'perps' ? 'Perpetuals' : m === 'predictions' ? 'Polymarket' : 'Liquidity'}
                  </span>
                ))}
                {task && <span className={s.htagInterval}>{intervalLabel(task.intervalSeconds)}</span>}
              </div>
            </div>
            <div className={s.heroControls}>
              <div className={`${s.statusPill} ${isActive ? s.pillActive : s.pillPaused}`}>
                <div className={`${s.spDot} ${isActive ? s.spDotActive : s.spDotPaused}`} />
                <span className={`${s.spLabel} ${isActive ? s.spLabelActive : s.spLabelPaused}`}>
                  {task?.status ?? 'Unknown'}
                </span>
              </div>
            </div>
          </div>

          {/* Stats bar */}
          <div className={s.heroStats}>
            <div className={s.hs}>
              <div className={s.hsVal}>{task?.cycleCount ?? 0}</div>
              <div className={s.hsLbl}>Total Cycles</div>
              <div className={s.hsSub}>last run {timeAgo(task?.lastRunAt ?? null)}</div>
            </div>
            <div className={s.hs}>
              <div className={s.hsVal}>{task?.alertCount ?? 0}</div>
              <div className={s.hsLbl}>Alerts Fired</div>
            </div>
            <div className={s.hs}>
              <div className={s.hsVal}>{task?.signalCount ?? agent.insightsGenerated}</div>
              <div className={s.hsLbl}>Signals</div>
            </div>
            <div className={s.hs}>
              <div className={`${s.hsVal} ${s.hsValY}`}>{agent.insightsGenerated}</div>
              <div className={s.hsLbl}>Insights</div>
            </div>
            <div className={s.hs}>
              <div className={s.hsVal}>{timeUntil(task?.nextRunAt ?? null)}</div>
              <div className={s.hsLbl}>Next Scan</div>
            </div>
          </div>

          {/* Creator */}
          <div className={s.heroCreator}>
            <span className={s.hcLbl}>Created by</span>
            <span className={s.hcWallet}>
              {agent.ownerWallet.slice(0, 6)}...{agent.ownerWallet.slice(-4)}
            </span>
            <span className={s.hcSince}>
              Deployed {new Date(agent.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
            </span>
          </div>
        </div>
      </div>

      {/* ── SECTION 1: CURRENT MARKET READ ── */}
      <div className={s.section}>
        <div className={s.secHdr} onClick={() => setReadOpen(o => !o)}>
          <div className={s.secHdrLeft}>
            <div className={s.secEyebrow}>Section 01</div>
            <div className={s.secTitle}>Current Market Read</div>
            <div className={s.secSub}>Live signal state from the last completed scan cycle</div>
          </div>
          <div className={s.secHdrRight}>
            {latestRead.timestamp ? (
              <div className={s.secBadgeLive}>
                <div className={s.secBadgeDot} />
                Updated {timeAgo(latestRead.timestamp)}
              </div>
            ) : (
              <div className={s.secBadge}>No data yet</div>
            )}
            <span className={`${s.secChev} ${readOpen ? s.secChevOpen : ''}`}>▾</span>
          </div>
        </div>

        {readOpen && (
          <div className={s.secBody}>
            {latestRead.indicators.length > 0 ? (
              <>
                {latestRead.indicators.map((ind, i) => (
                  <div key={i} className={s.signalRow}>
                    <div className={`${s.srDot} ${dotClass(ind.dot)}`} />
                    <div className={s.srBody}>
                      <div className={s.srTop}>
                        <span className={s.srName}>{ind.name}</span>
                        <span className={`${s.srVal} ${s[`srVal_${ind.dot}`] ?? s.srValN}`}>{ind.value}</span>
                      </div>
                      <div className={s.srNote}>{ind.note}</div>
                    </div>
                    <div className={s.srRight}>
                      <span className={s.srTime}>{timeAgo(latestRead.timestamp)}</span>
                    </div>
                  </div>
                ))}
                {latestRead.summary && (
                  <div className={s.readSummary}>{latestRead.summary}</div>
                )}
              </>
            ) : (
              <div className={s.emptySection}>
                {isActive
                  ? 'Waiting for first cycle to complete — check back shortly'
                  : 'No market data yet — activate the agent to start monitoring'}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── SECTION 2: SIGNALS SURFACED ── */}
      <div className={s.section}>
        <div className={s.secHdr} onClick={() => setSignalsOpen(o => !o)}>
          <div className={s.secHdrLeft}>
            <div className={s.secEyebrow}>Section 02</div>
            <div className={s.secTitle}>Signals Surfaced</div>
            <div className={s.secSub}>Every alert and signal this agent has fired — the alpha it has produced</div>
          </div>
          <div className={s.secHdrRight}>
            <span className={s.secBadge}>
              {signals.length} total · {signals.filter(s => !s.read).length} new
            </span>
            <span className={`${s.secChev} ${signalsOpen ? s.secChevOpen : ''}`}>▾</span>
          </div>
        </div>

        {signalsOpen && (
          <div className={s.secBody}>
            {signals.length > 0 ? (
              signals.map(sig => (
                <div key={sig.id} className={`${s.alertRow} ${severityClass(sig.severity)}`}>
                  <div className={s.arTop}>
                    <div className={s.arDot} />
                    <span className={s.arSeverity}>{severityLabel(sig.severity, sig.isSignal)}</span>
                    <span className={s.arTitle}>{sig.title}</span>
                    <span className={s.arTime}>
                      {new Date(sig.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ·{' '}
                      {new Date(sig.createdAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                  <div className={s.arBody}>{sig.message}</div>

                  {/* Show per-indicator snapshot if available */}
                  {sig.indicators && sig.indicators.length > 0 && (
                    <div className={s.arIndicators}>
                      {sig.indicators.slice(0, 3).map((ind, i) => (
                        <div key={i} className={s.arIndItem}>
                          <span className={`${s.arIndDot} ${dotClass(ind.dot)}`} />
                          <span className={s.arIndName}>{ind.name}</span>
                          <span className={s.arIndVal}>{ind.value}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))
            ) : (
              <div className={s.emptySection}>
                {isActive
                  ? 'No signals yet — agent is monitoring and will surface signals when conditions are met'
                  : 'No signals recorded — activate the agent to start monitoring'}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
