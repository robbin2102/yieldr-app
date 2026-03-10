'use client';

import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import s from './agent.module.css';
import TopNav from '../../components/TopNav';

interface IndicatorRead {
  name: string;
  value: string;
  dot: 'green' | 'yellow' | 'red' | 'blue' | 'purple';
  note: string;
}

interface TaskAlpha {
  id: string;
  title: string;
  alphaTitle: string | null;
  alphaDescription: string | null;
  intervalSeconds: number;
  status: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  cycleCount: number;
  alertCount: number;
  latestRead: {
    timestamp: string | null;
    summary: string | null;
    indicators: IndicatorRead[];
  };
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
    alphaTitle: string | null;
    alphaDescription: string | null;
    intervalSeconds: number;
    status: string;
    nextRunAt: string | null;
    lastRunAt: string | null;
    cycleCount: number;
    alertCount: number;
    signalCount: number;
    createdAt: string;
  } | null;
  taskAlphas: TaskAlpha[];
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
  const router = useRouter();
  const [address, setAddress] = useState<string | null>(null);

  useEffect(() => {
    setAddress(localStorage.getItem('yieldr_auth_wallet'));
  }, []);
  const params = useParams();
  const agentId = params?.agentId as string;

  const [data, setData] = useState<AgentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedMonitors, setExpandedMonitors] = useState<Set<string>>(new Set());

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
        const json = await res.json();
        setData(json);
        // Open the first monitor by default
        if (json.taskAlphas?.length > 0) {
          setExpandedMonitors(new Set([json.taskAlphas[0].id]));
        }
      }
    } catch (e) {
      console.error('Failed to fetch agent detail', e);
    } finally {
      setLoading(false);
    }
  }

  function toggleMonitor(id: string) {
    setExpandedMonitors(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (loading) {
    return (
      <div style={{ background: '#000', minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
        <TopNav activePage="agents" />
        <div className={s.page}>
          <div className={s.loadingState}>Loading agent...</div>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div style={{ background: '#000', minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
        <TopNav activePage="agents" />
        <div className={s.page}>
          <div className={s.loadingState}>Agent not found</div>
        </div>
      </div>
    );
  }

  const { agent, task, taskAlphas, signals } = data;
  const isActive = task?.status === 'active';
  const marketIcons = agent.markets.map(m => MARKET_ICONS[m] ?? '🔧').join('');

  return (
    <div style={{ background: '#000', minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <TopNav activePage="agents" />
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
              <div className={s.heroTags}>
                {agent.markets.map(m => (
                  <span key={m} className={`${s.htag} ${s[`htag_${m}`] ?? ''}`}>
                    {m === 'perps' ? 'Perpetuals' : m === 'predictions' ? 'Predictions' : 'Liquidity'}
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
              <div className={s.hsVal}>{timeUntil(task?.nextRunAt ?? null)}</div>
              <div className={s.hsLbl}>Next Scan</div>
            </div>
          </div>
        </div>
      </div>

      {/* ── SECTION 1: ALPHA INTELLIGENCE ── */}
      <div className={s.section}>
        <div className={s.secHdr}>
          <div className={s.secHdrLeft}>
            <div className={s.secEyebrow}>Section 01</div>
            <div className={s.secTitle}>Alpha Intelligence</div>
            <div className={s.secSub}>What this agent is hunting — alpha thesis and live indicator reads</div>
          </div>
          <div className={s.secHdrRight}>
            {taskAlphas.some(t => t.latestRead.timestamp) ? (
              <div className={s.secBadgeLive}>
                <div className={s.secBadgeDot} />
                Live
              </div>
            ) : (
              <div className={s.secBadge}>No data yet</div>
            )}
          </div>
        </div>

        <div className={s.secBody}>
            {taskAlphas.length > 0 ? (
              taskAlphas.map((ta, idx) => {
                const isExpanded = expandedMonitors.has(ta.id);
                return (
                <div key={ta.id} className={s.alphaBlock}>
                  {/* Accordion header — always visible, click to expand/collapse */}
                  <div
                    className={s.alphaThesis}
                    onClick={() => toggleMonitor(ta.id)}
                    style={{ cursor: 'pointer', userSelect: 'none' }}
                  >
                    <div className={s.alphaThesisLeft}>
                      <div className={`${s.atStatusDot} ${ta.status === 'active' ? s.atDotActive : s.atDotPaused}`} />
                    </div>
                    <div className={s.alphaThesisBody}>
                      <div className={s.atTitle}>{ta.alphaTitle ?? ta.title}</div>
                      <div className={s.atMeta}>
                        <span className={s.atMetaItem}>{intervalLabel(ta.intervalSeconds)}</span>
                        <span className={s.atMetaDot}>·</span>
                        <span className={s.atMetaItem}>{ta.cycleCount} cycles</span>
                        <span className={s.atMetaDot}>·</span>
                        <span className={s.atMetaItem}>{ta.alertCount} alerts</span>
                        {ta.latestRead.timestamp && (
                          <>
                            <span className={s.atMetaDot}>·</span>
                            <span className={s.atMetaItem}>Updated {timeAgo(ta.latestRead.timestamp)}</span>
                          </>
                        )}
                      </div>
                    </div>
                    <span style={{ marginLeft: 'auto', fontSize: '0.7rem', color: '#4A4A4A', flexShrink: 0, paddingLeft: 8, transition: 'transform 0.18s', display: 'inline-block', transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)' }}>▾</span>
                  </div>

                  {/* Accordion body — only visible when expanded */}
                  {isExpanded && (
                    <div>
                      {ta.alphaDescription && (
                        <div className={s.atDesc} style={{ marginBottom: 10 }}>{ta.alphaDescription}</div>
                      )}

                      {ta.latestRead.indicators.length > 0 ? (
                        <div className={s.indicatorBlock}>
                          {ta.latestRead.indicators.map((ind, i) => (
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
                                <span className={s.srTime}>{timeAgo(ta.latestRead.timestamp)}</span>
                              </div>
                            </div>
                          ))}
                          {ta.latestRead.summary && (
                            <div className={s.readSummary}>{ta.latestRead.summary}</div>
                          )}
                        </div>
                      ) : (
                        <div className={s.emptySection}>
                          {ta.status === 'active'
                            ? 'Waiting for first cycle — indicator reads will appear here shortly'
                            : '⏸ Paused — resume to restart monitoring'}
                        </div>
                      )}
                    </div>
                  )}

                  {idx < taskAlphas.length - 1 && <div className={s.alphaBlockDivider} />}
                </div>
                );
              })
            ) : (
              <div className={s.emptySection}>
                {isActive
                  ? 'Waiting for first cycle to complete — alpha intelligence will appear shortly'
                  : 'No monitors set up yet — activate the agent to start monitoring'}
              </div>
            )}
          </div>
      </div>

      {/* ── SECTION 2: SIGNALS SURFACED ── */}
      <div className={s.section}>
        <div className={s.secHdr}>
          <div className={s.secHdrLeft}>
            <div className={s.secEyebrow}>Section 02</div>
            <div className={s.secTitle}>Signals Surfaced</div>
            <div className={s.secSub}>Every alert and signal this agent has fired — the alpha it has produced</div>
          </div>
          <div className={s.secHdrRight}>
            <span className={s.secBadge}>
              {signals.length} total · {signals.filter(s => !s.read).length} new
            </span>
          </div>
        </div>

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
      </div>
      </div>
    </div>
  );
}
