'use client';

import { useState, useEffect } from 'react';
import { useAccount } from 'wagmi';
import { useRouter } from 'next/navigation';

interface AgentCard {
  agentId: string;
  name: string;
  status: string;
  markets: string[];
  alertsSent: number;
  insightsGenerated: number;
  totalTasks: number;
  activeTasks: number;
  cycleCount: number;
  portfolioSummary?: { positionCount: number };
  createdAt: string;
}

export default function AgentsPage() {
  const [mounted, setMounted] = useState(false);
  const router = useRouter();
  const { address } = useAccount();
  const [authenticatedWallet, setAuthenticatedWallet] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [myAgentId, setMyAgentId] = useState<string | null>(null);

  useEffect(() => {
    if (!mounted) return;
    try {
      const d = JSON.parse(localStorage.getItem('agentCreated') || '{}');
      if (d.agentId) setMyAgentId(d.agentId);
    } catch {}
  }, [mounted]);

  useEffect(() => { setMounted(true); }, []);

  useEffect(() => {
    if (!mounted) return;
    const stored = localStorage.getItem('yieldr_auth_wallet');
    if (stored) setAuthenticatedWallet(stored.toLowerCase());
  }, [mounted]);

  useEffect(() => {
    if (!mounted) return;
    const wallet = address || authenticatedWallet;
    if (!wallet) return;

    // Fetch agents list
    fetch(`/api/demo/agents/list?wallet=${wallet}`)
      .then(r => r.json())
      .then(data => {
        if (data.agents) {
          setAgents(data.agents);
          if (data.agents.length > 0 && !myAgentId) {
            setMyAgentId(data.agents[0].agentId);
          }
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [mounted, address, authenticatedWallet]);

  if (!mounted) return null;

  return (
    <div style={{
      minHeight: '100vh',
      background: '#000',
      fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
      color: '#FFFFFF',
    }}>
      {/* NAV */}
      <nav style={{
        background: '#0A0A0A',
        borderBottom: '1px solid #1E1E1E',
        padding: '0 1rem',
        height: 48,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        position: 'sticky', top: 0, zIndex: 50,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem' }}>
          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '0.95rem', fontWeight: 700, color: '#00C805' }}>
            YIELDR
          </span>
          <div style={{ display: 'flex', gap: '0.25rem' }}>
            <a href="/demo/chat" style={{
              color: '#6E6E6E', textDecoration: 'none', fontWeight: 500,
              fontSize: '0.8rem', padding: '0.4rem 0.6rem', borderRadius: 4,
            }}>Home</a>
            <a href="/demo/agents" style={{
              color: '#00C805', textDecoration: 'none', fontWeight: 500,
              fontSize: '0.8rem', padding: '0.4rem 0.6rem', borderRadius: 4,
              background: 'rgba(0, 200, 5, 0.08)',
            }}>Agents</a>
          </div>
        </div>
        {myAgentId && (
          <a
            href="/demo/chat"
            style={{
              fontSize: '0.75rem', fontWeight: 600,
              padding: '0.35rem 0.65rem',
              background: '#00C805', border: 'none', borderRadius: 4,
              color: '#000', cursor: 'pointer', textDecoration: 'none',
            }}
          >My Agent</a>
        )}
      </nav>

      {/* HEADER */}
      <div style={{ padding: '2rem 1.5rem 1rem' }}>
        <div style={{ maxWidth: 900, margin: '0 auto' }}>
          <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
            <div>
              <h1 style={{ fontSize: '1.4rem', fontWeight: 700, margin: 0, marginBottom: '0.25rem' }}>
                Agent Explorer
              </h1>
              <p style={{ fontSize: '0.85rem', color: '#6E6E6E', margin: 0 }}>
                AI agents monitoring markets and surfacing alpha for their owners
              </p>
            </div>
            <div style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '0.7rem', color: '#6E6E6E',
              padding: '0.35rem 0.6rem',
              background: '#111111', border: '1px solid #1E1E1E', borderRadius: 4,
            }}>
              {agents.length} agents active
            </div>
          </div>

          {/* Filter bar placeholder */}
          <div style={{
            display: 'flex', gap: '0.5rem', marginTop: '1rem',
            borderBottom: '1px solid #1E1E1E', paddingBottom: '0.75rem',
          }}>
            {['All', 'Perps', 'Predictions', 'Most Alerts'].map((f, idx) => (
              <button key={f} style={{
                fontSize: '0.7rem', fontWeight: 500,
                padding: '0.3rem 0.65rem', borderRadius: 4,
                background: idx === 0 ? 'rgba(0, 200, 5, 0.12)' : '#111111',
                border: `1px solid ${idx === 0 ? 'rgba(0, 200, 5, 0.3)' : '#1E1E1E'}`,
                color: idx === 0 ? '#00C805' : '#6E6E6E',
                cursor: 'pointer',
              }}>{f}</button>
            ))}
          </div>
        </div>
      </div>

      {/* AGENTS GRID */}
      <div style={{ padding: '0 1.5rem 2rem', maxWidth: 900, margin: '0 auto' }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: '3rem', color: '#6E6E6E', fontSize: '0.85rem' }}>
            <div style={{
              width: 36, height: 36, margin: '0 auto 0.75rem',
              border: '2px solid #1E1E1E', borderTop: '2px solid #00C805',
              borderRadius: '50%', animation: 'spin 1s linear infinite',
            }} />
            Loading agents...
            <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
          </div>
        ) : agents.length === 0 ? (
          <div style={{
            textAlign: 'center', padding: '3rem',
            background: '#0A0A0A', border: '1px solid #1E1E1E', borderRadius: 8,
            marginTop: '1rem',
          }}>
            <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>🤖</div>
            <div style={{ fontSize: '0.9rem', fontWeight: 600, marginBottom: '0.25rem' }}>No agents found</div>
            <div style={{ fontSize: '0.75rem', color: '#6E6E6E', marginBottom: '1rem' }}>
              Be the first to deploy an agent on Yieldr
            </div>
            <a
              href="/demo"
              style={{
                display: 'inline-block',
                padding: '0.5rem 1rem',
                background: '#00C805', borderRadius: 4,
                color: '#000', fontWeight: 700, fontSize: '0.8rem',
                textDecoration: 'none',
              }}
            >Create Agent</a>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '0.75rem', marginTop: '0.75rem' }}>
            {agents.map((agent) => {
              const isOwn = agent.agentId === myAgentId;
              return (
                <div
                  key={agent.agentId}
                  onClick={() => isOwn && router.push('/demo/chat')}
                  style={{
                    background: '#0A0A0A',
                    border: `1px solid ${isOwn ? 'rgba(0, 200, 5, 0.4)' : '#1E1E1E'}`,
                    borderRadius: 8,
                    padding: '0.9rem',
                    cursor: isOwn ? 'pointer' : 'default',
                    transition: 'border-color 0.15s',
                    position: 'relative',
                  }}
                >
                  {isOwn && (
                    <div style={{
                      position: 'absolute', top: '0.5rem', right: '0.5rem',
                      fontSize: '0.45rem', fontWeight: 700,
                      padding: '0.15rem 0.35rem',
                      background: 'rgba(0, 200, 5, 0.15)', color: '#00C805', borderRadius: 3,
                      letterSpacing: '0.04em', textTransform: 'uppercase',
                    }}>Your Agent</div>
                  )}

                  {/* Agent header */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.65rem' }}>
                    <div style={{
                      width: 32, height: 32,
                      background: 'linear-gradient(135deg, #00C805 0%, #0088FF 100%)',
                      borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: '0.9rem', flexShrink: 0,
                    }}>🤖</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: '0.9rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {agent.name}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', marginTop: '0.1rem' }}>
                        <span style={{
                          fontSize: '0.45rem', fontWeight: 700, padding: '0.1rem 0.25rem', borderRadius: 2,
                          background: agent.status === 'active' ? 'rgba(0, 200, 5, 0.15)' : '#1A1A1A',
                          color: agent.status === 'active' ? '#00C805' : '#6E6E6E',
                          textTransform: 'uppercase',
                        }}>{agent.status}</span>
                        {agent.markets.map(m => (
                          <span key={m} style={{
                            fontSize: '0.45rem', padding: '0.1rem 0.25rem',
                            background: '#1A1A1A', color: '#6E6E6E', borderRadius: 2,
                          }}>{m}</span>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Stats row */}
                  <div style={{
                    display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)',
                    gap: '0.35rem', marginBottom: '0.65rem',
                  }}>
                    {[
                      ['Monitors', agent.totalTasks || 0],
                      ['Alerts', agent.alertsSent || 0],
                      ['Cycles', agent.cycleCount || 0],
                    ].map(([label, value]) => (
                      <div key={label as string} style={{
                        background: '#111111', border: '1px solid #1E1E1E', borderRadius: 4,
                        padding: '0.35rem 0.4rem', textAlign: 'center',
                      }}>
                        <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '0.85rem', fontWeight: 700, color: '#FFFFFF' }}>
                          {value}
                        </div>
                        <div style={{ fontSize: '0.5rem', color: '#6E6E6E', marginTop: '0.1rem' }}>{label}</div>
                      </div>
                    ))}
                  </div>

                  {/* Wallet + age */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: '0.55rem', color: '#6E6E6E',
                      background: '#111111', padding: '0.15rem 0.3rem', borderRadius: 3,
                    }}>
                      {agent.agentId}
                    </span>
                    <span style={{ fontSize: '0.55rem', color: '#6E6E6E' }}>
                      {Math.floor((Date.now() - new Date(agent.createdAt).getTime()) / 86400000)}d ago
                    </span>
                  </div>

                  {isOwn && (
                    <div style={{
                      marginTop: '0.6rem', paddingTop: '0.6rem',
                      borderTop: '1px solid #1E1E1E',
                      fontSize: '0.65rem', color: '#00C805', fontWeight: 500,
                      display: 'flex', alignItems: 'center', gap: '0.3rem',
                    }}>
                      <span>Open agent terminal</span>
                      <span>→</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Coming soon notice */}
        <div style={{
          marginTop: '2rem',
          padding: '1rem',
          background: '#0A0A0A',
          border: '1px dashed #1E1E1E',
          borderRadius: 8,
          textAlign: 'center',
        }}>
          <div style={{ fontSize: '0.75rem', color: '#6E6E6E' }}>
            Agent leaderboards, copy-monitor, and social features coming in V1
          </div>
        </div>
      </div>
    </div>
  );
}
