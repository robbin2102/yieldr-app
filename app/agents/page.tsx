'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import s from './agents.module.css';
import TopNav from '../components/TopNav';

interface AgentTask {
  id: string;
  taskTitle: string;
  assetSymbol: string;
  status: 'active' | 'paused' | 'error';
  intervalSeconds: number;
  cycleCount: number;
  alertCount: number;
  nextRunAt: string | null;
  lastRunAt: string | null;
  signalPills: { label: string; color: string }[];
}

interface AgentSignal {
  id: string;
  title: string;
  message: string;
  severity: 'info' | 'warning' | 'critical';
  isSignal: boolean;
  createdAt: string;
}

interface AgentCard {
  agentId: string;
  name: string;
  ownerWallet?: string;
  markets: string[];
  status: string;
  alertsSent: number;
  insightsGenerated: number;
  tasks: AgentTask[];
  latestSignal?: AgentSignal;
  isOwn?: boolean;
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

function AgentCard({ card, onClick }: { card: AgentCard; onClick: () => void }) {
  const primaryTask = card.tasks.find(t => t.status === 'active') ?? card.tasks[0];
  const status = primaryTask?.status ?? 'active';
  const isActive = status === 'active';
  const isError = status === 'error';

  const marketIcons = card.markets.map(m => MARKET_ICONS[m] ?? '🔧').join('');
  const signalCount = card.insightsGenerated;
  const monitorsLive = card.tasks.filter(t => t.status === 'active').length;

  return (
    <div
      className={`${s.card} ${isActive ? s.cardActive : ''} ${isError ? s.cardError : ''} ${!isActive && !isError ? s.cardPaused : ''}`}
      onClick={onClick}
    >
      <div className={`${s.cardBar} ${isActive ? s.barActive : isError ? s.barError : s.barPaused}`} />
      <div className={s.cardInner}>
        {/* Top row */}
        <div className={s.cardTopRow}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <div className={`${s.statusBadge} ${isActive ? s.badgeActive : isError ? s.badgeError : s.badgePaused}`}>
              <div className={`${s.statusDot} ${isActive ? s.dotActive : isError ? s.dotError : s.dotPaused}`} />
              <span className={`${s.statusTxt} ${isActive ? s.txtActive : isError ? s.txtError : s.txtPaused}`}>
                {isActive ? 'Active' : isError ? 'Error' : 'Paused'}
              </span>
            </div>
            {card.isOwn && (
              <span style={{ fontSize: '10px', fontWeight: 600, color: '#a78bfa', background: 'rgba(167,139,250,0.12)', border: '1px solid rgba(167,139,250,0.25)', borderRadius: '4px', padding: '1px 5px', letterSpacing: '0.04em' }}>
                YOURS
              </span>
            )}
          </div>
          <span className={s.lastRun}>{timeAgo(primaryTask?.lastRunAt ?? null)}</span>
        </div>

        {/* Identity */}
        <div className={s.cardIdentity}>
          <div className={s.agentIcon} style={{ background: isActive ? 'linear-gradient(145deg,#0d1f3c,#162d52)' : 'linear-gradient(145deg,#141414,#1a1a1a)' }}>
            {marketIcons || '🤖'}
          </div>
          <div>
            <div className={s.cardName}>{card.name}</div>
            <div className={s.cardMandate}>
              {primaryTask?.taskTitle ?? 'Monitoring agent'}
            </div>
          </div>
        </div>

        {/* Market / interval tags */}
        <div className={s.cardMarkets}>
          {card.markets.map(m => (
            <span key={m} className={`${s.mktTag} ${s[`mkt_${m}`] ?? ''}`}>
              {m === 'perps' ? 'Perpetuals' : m === 'predictions' ? 'Polymarket' : 'Liquidity'}
            </span>
          ))}
          {primaryTask && (
            <span className={s.mktTagInterval}>{intervalLabel(primaryTask.intervalSeconds)}</span>
          )}
        </div>

        {/* Latest signal */}
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
            <div className={s.csVal}>{primaryTask?.cycleCount ?? 0}</div>
            <div className={s.csLbl}>Cycles</div>
          </div>
          <div className={s.cs}>
            <div className={`${s.csVal} ${card.alertsSent > 0 ? s.csValG : ''}`}>{card.alertsSent}</div>
            <div className={s.csLbl}>Alerts</div>
          </div>
          <div className={s.cs}>
            <div className={s.csVal}>{signalCount}</div>
            <div className={s.csLbl}>Signals</div>
          </div>
          <div className={s.cs}>
            <div className={`${s.csVal} ${monitorsLive > 0 ? s.csValG : ''}`}>{monitorsLive}</div>
            <div className={s.csLbl}>Monitors Live</div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function AgentsPage() {
  const router = useRouter();
  const [address, setAddress] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentCard[]>([]);
  const [filter, setFilter] = useState('all');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const wallet = localStorage.getItem('yieldr_auth_wallet');
    setAddress(wallet);
  }, []);

  useEffect(() => {
    fetchData();
  }, [address]);

  async function fetchData() {
    setLoading(true);
    try {
      const res = await fetch('/api/demo/agents/all');
      const data = res.ok ? await res.json() : { agents: [] };
      const allAgents: any[] = data.agents ?? [];

      const cards: AgentCard[] = allAgents.map(ag => ({
        agentId: ag.agentId,
        name: ag.name,
        ownerWallet: ag.ownerWallet,
        markets: ag.markets ?? ['perps'],
        status: ag.status,
        alertsSent: ag.alertsSent ?? 0,
        insightsGenerated: ag.insightsGenerated ?? 0,
        tasks: (ag.activeTasks ?? []).map((t: any) => ({
          id: t.id,
          taskTitle: t.taskTitle,
          assetSymbol: '',
          status: t.status,
          intervalSeconds: t.intervalSeconds,
          cycleCount: t.cycleCount,
          alertCount: t.alertCount,
          nextRunAt: null,
          lastRunAt: t.lastRunAt,
          signalPills: [],
        })),
        latestSignal: ag.latestSignal ?? undefined,
        isOwn: address ? ag.ownerWallet?.toLowerCase() === address.toLowerCase() : false,
      }));

      // Sort: own agent first, then by alertsSent desc
      cards.sort((a, b) => {
        if (a.isOwn && !b.isOwn) return -1;
        if (!a.isOwn && b.isOwn) return 1;
        return (b.alertsSent ?? 0) - (a.alertsSent ?? 0);
      });

      setAgents(cards);
    } catch (e) {
      console.error('Failed to fetch agents', e);
    } finally {
      setLoading(false);
    }
  }

  const filteredAgents = agents.filter(a => {
    if (filter === 'all') return true;
    if (filter === 'mine') return a.isOwn;
    if (filter === 'active') return a.tasks.some(t => t.status === 'active');
    if (filter === 'perps') return a.markets.includes('perps');
    if (filter === 'predictions') return a.markets.includes('predictions');
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
          <div className={s.pageTitle}>Quant Agent Explorer</div>
          <div className={s.pageSub}>
            All agents actively monitoring signals — surfacing alpha across perps, predictions, and macro.
          </div>
        </div>
        <button className={s.newAgentBtn} onClick={() => router.push('/demo')}>
          + Deploy New Agent
        </button>
      </div>

      {/* Filter bar */}
      <div className={s.filterBar}>
        {['all', 'mine', 'active', 'perps', 'predictions'].map(f => (
          <button
            key={f}
            className={`${s.filterChip} ${filter === f ? s.filterActive : ''}`}
            onClick={() => setFilter(f)}
          >
            {f === 'all' ? 'All Agents' : f === 'mine' ? 'My Agent' : f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>

      {/* Grid */}
      {loading ? (
        <div className={s.gridEmpty}>
          <div className={s.gridEmptyText}>Loading agents...</div>
        </div>
      ) : filteredAgents.length === 0 ? (
        <div className={s.gridEmpty}>
          <div className={s.gridEmptyIcon}>🤖</div>
          <div className={s.gridEmptyText}>
            {filter === 'mine'
              ? 'No agent deployed from this wallet yet'
              : 'No agents with active monitors found'}
          </div>
        </div>
      ) : (
        <div className={s.agentGrid}>
          {filteredAgents.map(card => (
            <AgentCard
              key={card.agentId}
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
