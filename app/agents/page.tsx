'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import s from './agents.module.css';
import TopNav from '../components/TopNav';

interface AgentTask {
  id: string;
  agentId: string | null;
  taskTitle: string;
  alphaTitle: string | null;
  alphaDescription: string | null;
  assetSymbol: string;
  status: 'active' | 'paused' | 'error';
  intervalSeconds: number;
  cycleCount: number;
  alertCount: number;
  nextRunAt: string | null;
  lastRunAt: string | null;
  signalPills: { label: string; color: string }[];
}

interface AgentInfo {
  agentId: string;
  name: string;
  markets: string[];
  status: string;
  alertsSent: number;
  insightsGenerated: number;
}

interface AgentSignal {
  id: string;
  taskId?: string;
  agentId?: string;
  title: string;
  message: string;
  severity: 'info' | 'warning' | 'critical';
  isSignal: boolean;
  createdAt: string;
}

// One card per monitoring task (alpha)
interface AlphaCard {
  taskId: string;
  agentId: string;
  agentName: string;
  markets: string[];
  alphaTitle: string | null;
  alphaDescription: string | null;
  taskTitle: string;
  assetSymbol: string;
  status: 'active' | 'paused' | 'error';
  intervalSeconds: number;
  cycleCount: number;
  alertCount: number;
  lastRunAt: string | null;
  latestSignal?: AgentSignal;
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
  if (!iso) return 'Never';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function AlphaCardComponent({ card, onClick }: { card: AlphaCard; onClick: () => void }) {
  const isActive = card.status === 'active';
  const isError = card.status === 'error';

  const marketIcons = card.markets.map(m => MARKET_ICONS[m] ?? '🔧').join('');

  return (
    <div
      className={`${s.card} ${isActive ? s.cardActive : ''} ${isError ? s.cardError : ''} ${!isActive && !isError ? s.cardPaused : ''}`}
      onClick={onClick}
    >
      <div className={`${s.cardBar} ${isActive ? s.barActive : isError ? s.barError : s.barPaused}`} />
      <div className={s.cardInner}>
        {/* Top row: status + last run */}
        <div className={s.cardTopRow}>
          <div className={`${s.statusBadge} ${isActive ? s.badgeActive : isError ? s.badgeError : s.badgePaused}`}>
            <div className={`${s.statusDot} ${isActive ? s.dotActive : isError ? s.dotError : s.dotPaused}`} />
            <span className={`${s.statusTxt} ${isActive ? s.txtActive : isError ? s.txtError : s.txtPaused}`}>
              {isActive ? 'Active' : isError ? 'Error' : 'Paused'}
            </span>
          </div>
          <span className={s.lastRun}>{timeAgo(card.lastRunAt)}</span>
        </div>

        {/* Alpha identity — PRIMARY content */}
        <div className={s.alphaIdentity}>
          <div className={s.agentIcon} style={{ background: isActive ? 'linear-gradient(145deg,#0d1f3c,#162d52)' : 'linear-gradient(145deg,#141414,#1a1a1a)' }}>
            {marketIcons || '🤖'}
          </div>
          <div className={s.alphaIdentityText}>
            <div className={s.alphaCardTitle}>
              {card.alphaTitle ?? card.taskTitle}
            </div>
            {card.alphaDescription ? (
              <div className={s.alphaCardDesc}>{card.alphaDescription}</div>
            ) : (
              <div className={s.alphaCardDescPending}>
                {isActive ? 'Alpha thesis generating after first cycle...' : 'Resume to define alpha thesis'}
              </div>
            )}
            <div className={s.alphaAgentLine}>by {card.agentName}</div>
          </div>
        </div>

        {/* Market / interval tags */}
        <div className={s.cardMarkets}>
          {card.markets.map(m => (
            <span key={m} className={`${s.mktTag} ${s[`mkt_${m}`] ?? ''}`}>
              {m === 'perps' ? 'Perpetuals' : m === 'predictions' ? 'Polymarket' : 'Liquidity'}
            </span>
          ))}
          {card.assetSymbol && <span className={s.mktTag}>{card.assetSymbol}</span>}
          <span className={s.mktTagInterval}>{intervalLabel(card.intervalSeconds)}</span>
        </div>

        {/* Latest signal strip */}
        {card.latestSignal ? (
          <div className={s.alphaStrip}>
            <div className={`${s.alphaDot} ${card.latestSignal.severity === 'critical' ? s.dotR : card.latestSignal.severity === 'warning' ? s.dotY : s.dotG}`} />
            <div>
              <div className={s.alphaLabel}>Latest Signal</div>
              <div className={s.alphaText}>{card.latestSignal.title}</div>
            </div>
          </div>
        ) : (
          <div className={s.alphaNone}>
            {isActive ? 'Monitoring — no signals yet' : '⏸ Paused — resume to restart monitoring'}
          </div>
        )}

        {/* Stats */}
        <div className={s.cardStats}>
          <div className={s.cs}>
            <div className={s.csVal}>{card.cycleCount}</div>
            <div className={s.csLbl}>Cycles</div>
          </div>
          <div className={s.cs}>
            <div className={`${s.csVal} ${card.alertCount > 0 ? s.csValG : ''}`}>{card.alertCount}</div>
            <div className={s.csLbl}>Alerts</div>
          </div>
          <div className={s.cs}>
            <div className={s.csVal}>{card.assetSymbol || '—'}</div>
            <div className={s.csLbl}>Asset</div>
          </div>
          <div className={s.cs}>
            <div className={s.csVal}>{card.markets[0] === 'perps' ? 'Perps' : card.markets[0] === 'predictions' ? 'Predict' : 'LP'}</div>
            <div className={s.csLbl}>Market</div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function AgentsPage() {
  const router = useRouter();
  const [address, setAddress] = useState<string | null>(null);
  const [agentInfo, setAgentInfo] = useState<AgentInfo | null>(null);
  const [alphaCards, setAlphaCards] = useState<AlphaCard[]>([]);
  const [filter, setFilter] = useState('all');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const wallet = localStorage.getItem('yieldr_auth_wallet');
    setAddress(wallet);
  }, []);

  useEffect(() => {
    if (!address) return;
    fetchData();
  }, [address]);

  async function fetchData() {
    if (!address) return;
    setLoading(true);
    try {
      const [agentRes, taskRes, alertRes] = await Promise.all([
        fetch(`/api/demo/agents?wallet=${address}`),
        fetch(`/api/demo/monitoring-tasks?wallet=${address}`),
        fetch(`/api/demo/alerts?wallet=${address}`),
      ]);

      const agentData = agentRes.ok ? await agentRes.json() : null;
      const taskData = taskRes.ok ? await taskRes.json() : { tasks: [] };
      const alertData = alertRes.ok ? await alertRes.json() : { alerts: [] };

      const taskList: AgentTask[] = taskData.tasks ?? [];
      const alertList: AgentSignal[] = alertData.alerts ?? [];

      // Build latest signal per task
      const latestByTask: Record<string, AgentSignal> = {};
      for (const a of alertList) {
        const key = (a as any).taskId ?? '';
        if (key && !latestByTask[key]) latestByTask[key] = a;
      }
      // Fallback: latest by agent
      const latestByAgent: Record<string, AgentSignal> = {};
      for (const a of alertList) {
        const key = (a as any).agentId ?? '';
        if (key && !latestByAgent[key]) latestByAgent[key] = a;
      }

      const info: AgentInfo | null = agentData?.agent
        ? {
            agentId: agentData.agent.agentId,
            name: agentData.agent.name,
            markets: agentData.agent.markets ?? ['perps'],
            status: agentData.agent.status,
            alertsSent: agentData.agent.alertsSent ?? 0,
            insightsGenerated: agentData.agent.insightsGenerated ?? 0,
          }
        : null;
      setAgentInfo(info);

      // Build one alpha card per task
      const cards: AlphaCard[] = taskList.map(t => ({
        taskId: t.id,
        agentId: t.agentId ?? info?.agentId ?? t.id,
        agentName: info?.name ?? 'Agent',
        markets: info?.markets ?? ['perps'],
        alphaTitle: t.alphaTitle,
        alphaDescription: t.alphaDescription,
        taskTitle: t.taskTitle,
        assetSymbol: t.assetSymbol,
        status: t.status,
        intervalSeconds: t.intervalSeconds,
        cycleCount: t.cycleCount,
        alertCount: t.alertCount,
        lastRunAt: t.lastRunAt,
        latestSignal: latestByTask[t.id] ?? latestByAgent[t.agentId ?? ''],
      }));

      setAlphaCards(cards);
    } catch (e) {
      console.error('Failed to fetch agents data', e);
    } finally {
      setLoading(false);
    }
  }

  const filteredCards = alphaCards.filter(c => {
    if (filter === 'all') return true;
    if (filter === 'active') return c.status === 'active';
    if (filter === 'paused') return c.status !== 'active';
    if (filter === 'perps') return c.markets.includes('perps');
    if (filter === 'predictions') return c.markets.includes('predictions');
    return true;
  });

  return (
    <div style={{ background: '#000', minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <TopNav activePage="agents" />
      <div className={s.explorer}>
      {/* Page header */}
      <div className={s.pageHdr}>
        <div>
          <div className={s.eyebrow}>
            <span className={s.liveDot} />
            Agent Explorer
          </div>
          <div className={s.pageTitle}>Your Quant Agents</div>
          <div className={s.pageSub}>
            AI analysts running 24/7 — monitoring signals, surfacing alpha, and alerting when conditions change.
          </div>
        </div>
        <button className={s.newAgentBtn} onClick={() => router.push('/demo')}>
          + Deploy New Agent
        </button>
      </div>

      {/* Filter bar */}
      <div className={s.filterBar}>
        {['all', 'active', 'paused', 'perps', 'predictions'].map(f => (
          <button
            key={f}
            className={`${s.filterChip} ${filter === f ? s.filterActive : ''}`}
            onClick={() => setFilter(f)}
          >
            {f === 'all' ? 'All Alpha' : f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>

      {/* Grid */}
      {loading ? (
        <div className={s.gridEmpty}>
          <div className={s.gridEmptyText}>Loading agents...</div>
        </div>
      ) : !address ? (
        <div className={s.gridEmpty}>
          <div className={s.gridEmptyIcon}>🔌</div>
          <div className={s.gridEmptyText}>Connect your wallet to view your agents</div>
        </div>
      ) : filteredCards.length === 0 ? (
        <div className={s.gridEmpty}>
          <div className={s.gridEmptyIcon}>🤖</div>
          <div className={s.gridEmptyText}>No agents deployed yet — create your first agent to start monitoring</div>
        </div>
      ) : (
        <div className={s.agentGrid}>
          {filteredCards.map(card => (
            <AlphaCardComponent
              key={card.taskId}
              card={card}
              onClick={() => router.push(`/agents/${card.agentId}`)}
            />
          ))}
        </div>
      )}
      </div>
    </div>
  );
}
