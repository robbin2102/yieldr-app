'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useAccount } from 'wagmi';
import { useRouter } from 'next/navigation';

interface PerpPosition {
  pair?: string;
  direction?: string;
  leverage?: number;
  positionSize?: number;
  margin?: number;
  entryPrice?: number;
  currentPrice?: number;
  pnl?: number;
  roi?: number;
  platform?: string;
  status?: string;
}

interface PMPosition {
  market?: string;
  outcome?: string;
  size?: number;
  avgPrice?: number;
  currentPrice?: number;
  currentValue?: number;
  pnl?: number;
  pnlPercent?: number;
}

interface FollowedTrader {
  wallet: string;
  platform: string;
  username?: string;
  pnl30d: number;
  winRate: number;
  roi30d?: number;
  totalPositions: number;
  totalAUM?: number;
}

interface ChatMessage {
  id: string;
  role: 'agent' | 'user';
  content: string;
  time: string;
}

const AVATAR_IMGS = [1, 11, 12, 14, 15];

export default function ChatPage() {
  const [mounted, setMounted] = useState(false);
  const router = useRouter();
  const { address, isConnected } = useAccount();

  const [agentName, setAgentName] = useState('AlphaHunter');
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [activeTab, setActiveTab] = useState<'positions' | 'trades' | 'markets'>('positions');

  // Data
  const [perpPositions, setPerpPositions] = useState<PerpPosition[]>([]);
  const [pmPositions, setPmPositions] = useState<PMPosition[]>([]);
  const [followedTraders, setFollowedTraders] = useState<FollowedTrader[]>([]);
  const [hoveredTrader, setHoveredTrader] = useState<string | null>(null);

  // Chat
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputValue, setInputValue] = useState('');
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Countdown
  const [countdown, setCountdown] = useState(163);

  useEffect(() => { setMounted(true); }, []);

  // Load agent name
  useEffect(() => {
    if (!mounted) return;
    const created = localStorage.getItem('agentCreated');
    if (created) {
      try {
        const d = JSON.parse(created);
        if (d.name) setAgentName(d.name);
      } catch {}
    }
  }, [mounted]);

  // Redirect if no wallet
  useEffect(() => {
    if (mounted && !isConnected) {
      router.push('/demo');
    }
  }, [mounted, isConnected, router]);

  // Fetch data
  useEffect(() => {
    if (!mounted || !address) return;

    // Fetch perp positions from positions API
    fetch(`/api/positions?address=${address}`)
      .then(r => r.json())
      .then(data => {
        if (data.success && data.data) {
          setPerpPositions(data.data.perpPositions || []);
        }
      })
      .catch(() => {});

    // Fetch PM positions separately
    fetch(`/api/polymarket-positions?address=${address}`)
      .then(r => r.json())
      .then(data => {
        if (data.success && data.data) {
          setPmPositions((data.data.positions || []).map((p: any) => ({
            market: p.title,
            outcome: p.outcome,
            size: p.size,
            avgPrice: p.avgPrice,
            currentPrice: p.currentPrice,
            currentValue: p.currentValue,
            pnl: p.pnl,
            pnlPercent: p.pnlPercent,
          })));
        }
      })
      .catch(() => {});

    // Fetch agent (for followed traders)
    fetch(`/api/demo/agents?wallet=${address}`)
      .then(r => r.json())
      .then(data => {
        if (data.success && data.agent) {
          setFollowedTraders(data.agent.followedTraders || []);
          if (data.agent.name) setAgentName(data.agent.name);
        }
      })
      .catch(() => {});
  }, [mounted, address]);

  // Initial agent message
  useEffect(() => {
    if (!mounted || messages.length > 0) return;
    const timer = setTimeout(() => {
      const perpCount = perpPositions.length;
      const pmCount = pmPositions.length;
      let content = '';
      if (perpCount > 0 || pmCount > 0) {
        const parts: string[] = [];
        if (perpCount > 0) parts.push(`${perpCount} perp positions`);
        if (pmCount > 0) parts.push(`${pmCount} prediction market positions`);
        content = `I've scanned your wallet and found ${parts.join(' + ')}. I'm monitoring your portfolio and tracking the top traders you follow.\n\nAsk me anything about your positions, market conditions, or trading strategies.`;
      } else {
        content = `Welcome! I'm ${agentName}, your AI trading agent. I'm ready to help you analyze markets, track positions, and learn from top traders.\n\nConnect your positions or ask me about any market!`;
      }
      setMessages([{
        id: '1',
        role: 'agent',
        content,
        time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
      }]);
    }, 800);
    return () => clearTimeout(timer);
  }, [mounted, perpPositions, pmPositions, agentName, messages.length]);

  // Countdown timer
  useEffect(() => {
    const interval = setInterval(() => {
      setCountdown(prev => prev <= 0 ? 180 : prev - 1);
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // Auto-scroll chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = useCallback(() => {
    const text = inputValue.trim();
    if (!text) return;
    setInputValue('');
    const userMsg: ChatMessage = {
      id: Date.now().toString(),
      role: 'user',
      content: text,
      time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
    };
    setMessages(prev => [...prev, userMsg]);
    // Placeholder agent response (Claude API integration in Part 5)
    setTimeout(() => {
      setMessages(prev => [...prev, {
        id: (Date.now() + 1).toString(),
        role: 'agent',
        content: "I'm processing your request. Full AI chat integration is coming soon — I'll be able to analyze your positions, fetch market data, and provide trading insights using real-time data.",
        time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
      }]);
    }, 1000);
  }, [inputValue]);

  const handlePromptClick = (prompt: string) => {
    setInputValue(prompt);
  };

  const shortWallet = address ? `${address.slice(0, 6)}...${address.slice(-4)}` : '';
  const agentInitials = agentName.slice(0, 2).toUpperCase();
  const countdownMin = Math.floor(countdown / 60);
  const countdownSec = countdown % 60;

  const perpTotal = perpPositions.reduce((s, p) => s + (p.margin || p.positionSize || 0), 0);
  const pmTotal = pmPositions.reduce((s, p) => s + (p.currentValue || 0), 0);

  const perpTraders = followedTraders.filter(t => t.platform === 'hyperliquid' || t.platform === 'avantis');
  const pmTraders = followedTraders.filter(t => t.platform === 'polymarket');

  const suggestedPrompts = [
    'Analyze my losing positions',
    'What are top traders doing?',
    'Market outlook today',
    'Alert me on Telegram',
  ];

  if (!mounted) return null;

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif" }}>
      {/* TOP NAV */}
      <nav style={{
        background: '#0A0A0A',
        borderBottom: '1px solid #1E1E1E',
        padding: '0 1rem',
        height: 48,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem' }}>
          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '0.95rem', fontWeight: 700, color: '#00C805' }}>
            YIELDR
          </span>
          <div style={{ display: 'flex', gap: '0.25rem' }}>
            <a href="/demo/chat" style={{
              color: '#00C805',
              textDecoration: 'none',
              fontWeight: 500,
              fontSize: '0.8rem',
              padding: '0.4rem 0.6rem',
              borderRadius: 4,
              background: 'rgba(0, 200, 5, 0.08)',
            }}>Home</a>
            <a href="#" style={{
              color: '#9E9E9E',
              textDecoration: 'none',
              fontWeight: 500,
              fontSize: '0.8rem',
              padding: '0.4rem 0.6rem',
              borderRadius: 4,
            }}>Traders</a>
          </div>
        </div>
        <button style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '0.75rem',
          color: '#9E9E9E',
          background: '#111111',
          padding: '0.35rem 0.6rem',
          borderRadius: 4,
          border: '1px solid #1E1E1E',
          cursor: 'pointer',
        }}>{shortWallet}</button>
      </nav>

      {/* AGENT HEADER */}
      <div style={{
        background: '#111111',
        borderBottom: '1px solid #1E1E1E',
        padding: '0.5rem 1rem',
        display: 'flex',
        alignItems: 'center',
        gap: '0.75rem',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <div style={{
            width: 28, height: 28,
            background: 'linear-gradient(135deg, #00C805 0%, #0088FF 100%)',
            borderRadius: 6,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '0.8rem',
          }}>{'🤖'}</div>
          <span style={{ fontWeight: 600, fontSize: '0.95rem' }}>{agentName}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginLeft: 'auto' }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: '0.3rem',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '0.75rem',
            padding: '0.35rem 0.6rem',
            background: '#0A0A0A',
            border: '1px solid #1E1E1E',
            borderRadius: 4,
            cursor: 'pointer',
          }}>
            <span style={{ color: '#00C805' }}>{'⚡'}</span>
            <span style={{ fontWeight: 600 }}>63,250</span>
          </div>
          <button style={{
            fontSize: '0.65rem', fontWeight: 600,
            padding: '0.35rem 0.5rem',
            background: '#00C805', border: 'none', borderRadius: 4,
            color: '#000', cursor: 'pointer',
          }}>+ Get YLDR</button>
        </div>
      </div>

      {/* MAIN BODY */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* LEFT PANEL */}
        <div style={{
          width: panelCollapsed ? 0 : 300,
          background: '#0A0A0A',
          borderRight: '1px solid #1E1E1E',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          transition: 'width 0.2s ease',
          flexShrink: 0,
        }}>
          {/* Panel Header */}
          <div style={{
            padding: '0.5rem 0.75rem',
            borderBottom: '1px solid #1E1E1E',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            background: '#111111',
            flexShrink: 0,
          }}>
            <span style={{
              fontSize: '0.65rem', fontWeight: 600,
              color: '#9E9E9E',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              display: 'flex', alignItems: 'center', gap: '0.4rem',
            }}>
              <span style={{ color: '#00C805' }}>{'📊'}</span> Agent Monitoring
            </span>
            <button
              onClick={() => setPanelCollapsed(true)}
              style={{
                width: 22, height: 22,
                background: '#0A0A0A',
                border: '1px solid #1E1E1E',
                borderRadius: 4,
                color: '#6E6E6E',
                cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '0.65rem',
              }}
            >{'◀'}</button>
          </div>

          {/* Tabs */}
          <div style={{
            display: 'flex', alignItems: 'center',
            borderBottom: '1px solid #1E1E1E',
            background: '#0A0A0A',
            flexShrink: 0,
            padding: '0 0.5rem',
          }}>
            <div style={{ display: 'flex', flex: 1 }}>
              {(['positions', 'trades', 'markets'] as const).map(tab => (
                <button key={tab} onClick={() => setActiveTab(tab)} style={{
                  padding: '0.5rem',
                  fontSize: '0.7rem',
                  fontWeight: 500,
                  color: activeTab === tab ? '#00C805' : '#6E6E6E',
                  background: 'transparent',
                  border: 'none',
                  borderBottom: `2px solid ${activeTab === tab ? '#00C805' : 'transparent'}`,
                  cursor: 'pointer',
                  textTransform: 'capitalize',
                }}>{tab}</button>
              ))}
            </div>
            <div style={{
              display: 'flex', alignItems: 'center', gap: '0.25rem',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '0.55rem',
              color: '#6E6E6E',
              padding: '0.25rem 0.4rem',
              background: '#111111',
              borderRadius: 3,
            }}>
              <span style={{ fontSize: '0.6rem' }}>{'↻'}</span>
              <span>{countdownMin}:{String(countdownSec).padStart(2, '0')}</span>
            </div>
          </div>

          {/* Filter bar (positions/trades tabs only) */}
          {activeTab !== 'markets' && (
            <div style={{
              padding: '0.5rem',
              borderBottom: '1px solid #1E1E1E',
              background: '#0A0A0A',
              flexShrink: 0,
            }}>
              <select style={{
                width: '100%',
                padding: '0.4rem 0.6rem',
                background: '#111111',
                border: '1px solid #1E1E1E',
                borderRadius: 4,
                color: '#FFFFFF',
                fontSize: '0.75rem',
                fontFamily: "'Inter', sans-serif",
                cursor: 'pointer',
              }}>
                <option>Your Positions</option>
                {followedTraders.map((t, i) => (
                  <option key={i}>{t.username || t.wallet.slice(0, 10)}</option>
                ))}
              </select>
            </div>
          )}

          {/* Scrollable content */}
          <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
            {/* POSITIONS TAB */}
            {activeTab === 'positions' && (
              <>
                {/* Perpetuals Section */}
                <div style={{ borderBottom: '1px solid #1E1E1E' }}>
                  <div style={{
                    fontSize: '0.6rem', textTransform: 'uppercase', letterSpacing: '0.05em',
                    color: '#6E6E6E', padding: '0.5rem',
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    background: '#111111',
                  }}>
                    <span>Perpetuals</span>
                    <span style={{ fontFamily: "'JetBrains Mono', monospace", color: '#9E9E9E' }}>
                      ${perpTotal.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                    </span>
                  </div>
                  <div style={{ maxHeight: 240, overflowY: 'auto', padding: '0.5rem' }}>
                    {perpPositions.length === 0 ? (
                      <div style={{ fontSize: '0.75rem', color: '#6E6E6E', textAlign: 'center', padding: '1rem 0' }}>
                        No perp positions found
                      </div>
                    ) : perpPositions.map((pos, i) => {
                      const pnl = pos.pnl || 0;
                      const roi = pos.roi || 0;
                      const isPositive = pnl >= 0;
                      const borderColor = pnl > 0 ? '#00C805' : pnl < -10 ? '#FF4757' : pnl < 0 ? '#FFD000' : '#1E1E1E';
                      return (
                        <div key={i} style={{
                          background: '#111111',
                          border: '1px solid #1E1E1E',
                          borderLeft: `3px solid ${borderColor}`,
                          borderRadius: 5,
                          padding: '0.5rem',
                          marginBottom: '0.3rem',
                        }}>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                              <span style={{ fontWeight: 600, fontSize: '0.8rem' }}>
                                {(pos.pair || '').replace('/USD', '')}
                              </span>
                              <span style={{
                                fontSize: '0.55rem',
                                padding: '0.1rem 0.25rem',
                                borderRadius: 2,
                                fontWeight: 600,
                                background: pos.direction === 'LONG' ? 'rgba(0, 200, 5, 0.15)' : 'rgba(255, 71, 87, 0.15)',
                                color: pos.direction === 'LONG' ? '#00C805' : '#FF4757',
                              }}>
                                {pos.direction} {pos.leverage}x
                              </span>
                              <span style={{
                                fontSize: '0.55rem', color: '#6E6E6E',
                                padding: '0.1rem 0.25rem',
                                background: '#1A1A1A', borderRadius: 2,
                              }}>{pos.platform}</span>
                            </div>
                            <span style={{
                              fontFamily: "'JetBrains Mono', monospace",
                              fontSize: '0.75rem', fontWeight: 600,
                              color: isPositive ? '#00C805' : '#FF4757',
                            }}>
                              {isPositive ? '+' : ''}${Math.abs(pnl).toFixed(0)}
                            </span>
                          </div>
                          <div style={{
                            display: 'flex', gap: '0.5rem',
                            fontSize: '0.6rem', color: '#6E6E6E', marginTop: '0.25rem',
                          }}>
                            <span>Size <span style={{ fontFamily: "'JetBrains Mono', monospace", color: '#9E9E9E' }}>
                              ${(pos.positionSize || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                            </span></span>
                            <span>Entry <span style={{ fontFamily: "'JetBrains Mono', monospace", color: '#9E9E9E' }}>
                              ${(pos.entryPrice || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                            </span></span>
                            <span style={{ fontFamily: "'JetBrains Mono', monospace", color: isPositive ? '#00C805' : '#FF4757' }}>
                              {isPositive ? '+' : ''}{roi.toFixed(1)}%
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Prediction Markets Section */}
                <div style={{ borderBottom: '1px solid #1E1E1E' }}>
                  <div style={{
                    fontSize: '0.6rem', textTransform: 'uppercase', letterSpacing: '0.05em',
                    color: '#6E6E6E', padding: '0.5rem',
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    background: '#111111',
                  }}>
                    <span>Prediction Markets</span>
                    <span style={{ fontFamily: "'JetBrains Mono', monospace", color: '#9E9E9E' }}>
                      ${pmTotal.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                    </span>
                  </div>
                  <div style={{ maxHeight: 200, overflowY: 'auto', padding: '0.5rem' }}>
                    {pmPositions.length === 0 ? (
                      <div style={{ fontSize: '0.75rem', color: '#6E6E6E', textAlign: 'center', padding: '1rem 0' }}>
                        No prediction market positions
                      </div>
                    ) : pmPositions.map((pos, i) => {
                      const pnl = pos.pnl || 0;
                      const isPositive = pnl >= 0;
                      return (
                        <div key={i} style={{
                          background: '#111111',
                          border: '1px solid #1E1E1E',
                          borderLeft: `3px solid ${isPositive ? '#00C805' : '#FF4757'}`,
                          borderRadius: 5,
                          padding: '0.5rem',
                          marginBottom: '0.3rem',
                        }}>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontWeight: 600, fontSize: '0.75rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                {pos.market}
                              </div>
                              <div style={{ fontSize: '0.55rem', color: '#6E6E6E', marginTop: '0.15rem' }}>
                                {pos.outcome} @ {((pos.avgPrice || 0) * 100).toFixed(0)}c
                              </div>
                            </div>
                            <div style={{ textAlign: 'right', flexShrink: 0, marginLeft: '0.5rem' }}>
                              <div style={{
                                fontFamily: "'JetBrains Mono', monospace",
                                fontSize: '0.75rem', fontWeight: 600,
                                color: isPositive ? '#00C805' : '#FF4757',
                              }}>
                                {isPositive ? '+' : ''}${Math.abs(pnl).toFixed(2)}
                              </div>
                              <div style={{
                                fontFamily: "'JetBrains Mono', monospace",
                                fontSize: '0.55rem',
                                color: isPositive ? '#00C805' : '#FF4757',
                              }}>
                                {isPositive ? '+' : ''}{(pos.pnlPercent || 0).toFixed(1)}%
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Tokens Section (placeholder) */}
                <div style={{ borderBottom: '1px solid #1E1E1E' }}>
                  <div style={{
                    fontSize: '0.6rem', textTransform: 'uppercase', letterSpacing: '0.05em',
                    color: '#6E6E6E', padding: '0.5rem',
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    background: '#111111',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                      <span>Tokens</span>
                      <span style={{
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: '0.55rem', color: '#6E6E6E',
                        background: '#1A1A1A', padding: '0.1rem 0.25rem', borderRadius: 2,
                      }}>{shortWallet}</span>
                    </div>
                    <span style={{ fontFamily: "'JetBrains Mono', monospace", color: '#9E9E9E' }}>--</span>
                  </div>
                  <div style={{ padding: '0.75rem 0.5rem', textAlign: 'center' }}>
                    <div style={{ fontSize: '0.7rem', color: '#6E6E6E' }}>
                      Token detection coming soon
                    </div>
                  </div>
                </div>

                {/* Agent Following Section */}
                <div style={{
                  padding: '0.4rem 0.75rem',
                  background: '#111111',
                  borderTop: '1px solid #1E1E1E',
                  borderBottom: '1px solid #1E1E1E',
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                }}>
                  <span style={{
                    fontSize: '0.6rem', fontWeight: 600, color: '#6E6E6E',
                    textTransform: 'uppercase', letterSpacing: '0.05em',
                  }}>Agent Following</span>
                  <span style={{ fontSize: '0.6rem', color: '#6E6E6E' }}>
                    {followedTraders.length}
                  </span>
                </div>
                <div style={{ padding: '0.5rem' }}>
                  {followedTraders.length === 0 ? (
                    <div style={{ fontSize: '0.7rem', color: '#6E6E6E', textAlign: 'center', padding: '0.5rem 0' }}>
                      No traders followed yet
                    </div>
                  ) : followedTraders.map((trader, i) => (
                    <div
                      key={i}
                      style={{
                        background: '#111111',
                        border: `1px solid ${hoveredTrader === trader.wallet ? '#00C805' : '#1E1E1E'}`,
                        borderRadius: 4,
                        padding: '0.4rem 0.5rem',
                        marginBottom: '0.3rem',
                        display: 'flex', alignItems: 'center', gap: '0.4rem',
                        cursor: 'pointer',
                        position: 'relative',
                      }}
                      onMouseEnter={() => setHoveredTrader(trader.wallet)}
                      onMouseLeave={() => setHoveredTrader(null)}
                    >
                      <img
                        src={`https://i.pravatar.cc/150?img=${AVATAR_IMGS[i % AVATAR_IMGS.length]}`}
                        alt=""
                        style={{
                          width: 24, height: 24, borderRadius: '50%',
                          border: '2px solid #00C805',
                        }}
                      />
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 600, fontSize: '0.75rem' }}>
                          {trader.username || `${trader.wallet.slice(0, 8)}...`}
                        </div>
                        <div style={{ fontSize: '0.55rem', color: '#6E6E6E' }}>
                          {trader.platform.charAt(0).toUpperCase() + trader.platform.slice(1)} · {(trader.winRate * 100).toFixed(0)}% win
                        </div>
                      </div>
                      <span style={{
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: '0.7rem', color: '#00C805', fontWeight: 600,
                      }}>
                        +${trader.pnl30d >= 1000
                          ? `${(trader.pnl30d / 1000).toFixed(1)}K`
                          : trader.pnl30d.toFixed(0)}
                      </span>

                      {/* Hover tooltip */}
                      {hoveredTrader === trader.wallet && (
                        <div style={{
                          position: 'absolute',
                          left: '100%',
                          top: 0,
                          marginLeft: 8,
                          width: 200,
                          background: '#111111',
                          border: '1px solid #00C805',
                          borderRadius: 6,
                          padding: '0.6rem',
                          zIndex: 100,
                          boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
                        }}>
                          <div style={{ fontSize: '0.8rem', fontWeight: 700, marginBottom: '0.4rem' }}>
                            {trader.username || `${trader.wallet.slice(0, 10)}...`}
                          </div>
                          <div style={{ fontSize: '0.6rem', color: '#6E6E6E', marginBottom: '0.5rem', textTransform: 'capitalize' }}>
                            {trader.platform}
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.65rem' }}>
                              <span style={{ color: '#6E6E6E' }}>30d PnL</span>
                              <span style={{ fontFamily: "'JetBrains Mono', monospace", color: '#00C805', fontWeight: 600 }}>
                                +${trader.pnl30d.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                              </span>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.65rem' }}>
                              <span style={{ color: '#6E6E6E' }}>Win Rate</span>
                              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 600 }}>
                                {(trader.winRate * 100).toFixed(0)}%
                              </span>
                            </div>
                            {trader.roi30d !== undefined && (
                              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.65rem' }}>
                                <span style={{ color: '#6E6E6E' }}>30d ROI</span>
                                <span style={{ fontFamily: "'JetBrains Mono', monospace", color: '#00C805', fontWeight: 600 }}>
                                  {trader.roi30d.toFixed(1)}%
                                </span>
                              </div>
                            )}
                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.65rem' }}>
                              <span style={{ color: '#6E6E6E' }}>Positions</span>
                              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 600 }}>
                                {trader.totalPositions}
                              </span>
                            </div>
                            {trader.totalAUM !== undefined && trader.totalAUM > 0 && (
                              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.65rem' }}>
                                <span style={{ color: '#6E6E6E' }}>AUM</span>
                                <span style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 600 }}>
                                  ${trader.totalAUM.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                                </span>
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}

            {/* TRADES TAB (placeholder) */}
            {activeTab === 'trades' && (
              <div style={{ padding: '1rem 0.5rem', textAlign: 'center' }}>
                <div style={{ fontSize: '0.75rem', color: '#6E6E6E' }}>
                  Trade activity feed coming soon
                </div>
              </div>
            )}

            {/* MARKETS TAB (placeholder) */}
            {activeTab === 'markets' && (
              <div style={{ padding: '1rem 0.5rem', textAlign: 'center' }}>
                <div style={{ fontSize: '0.75rem', color: '#6E6E6E' }}>
                  Market data feed coming soon
                </div>
              </div>
            )}
          </div>
        </div>

        {/* CHAT AREA */}
        <div style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          background: '#000000',
          position: 'relative',
          overflow: 'hidden',
        }}>
          {/* Expand button (when panel collapsed) */}
          {panelCollapsed && (
            <button
              onClick={() => setPanelCollapsed(false)}
              style={{
                position: 'absolute', top: '0.5rem', left: '0.5rem',
                width: 32, height: 32,
                background: '#111111',
                border: '1px solid #1E1E1E',
                borderRadius: 4,
                color: '#9E9E9E',
                cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '0.8rem', zIndex: 10,
              }}
            >{'▶'}</button>
          )}

          {/* Messages */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '1rem 1.5rem' }}>
            {messages.map(msg => (
              <div key={msg.id} style={{ marginBottom: '1rem' }}>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: '0.4rem',
                  marginBottom: '0.3rem',
                }}>
                  <div style={{
                    width: 24, height: 24, borderRadius: 5,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: '0.7rem', fontWeight: 600,
                    ...(msg.role === 'agent' ? {
                      background: 'linear-gradient(135deg, #00C805 0%, #0088FF 100%)',
                      color: '#000',
                    } : {
                      background: '#1A1A1A',
                      color: '#9E9E9E',
                    }),
                  }}>
                    {msg.role === 'agent' ? agentInitials : 'U'}
                  </div>
                  <span style={{ fontWeight: 600, fontSize: '0.85rem' }}>
                    {msg.role === 'agent' ? agentName : 'You'}
                  </span>
                  <span style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: '0.6rem', color: '#6E6E6E', marginLeft: 'auto',
                  }}>{msg.time}</span>
                </div>
                <div style={{
                  paddingLeft: '1.75rem',
                  fontSize: '0.9rem',
                  lineHeight: 1.6,
                  color: '#9E9E9E',
                  whiteSpace: 'pre-wrap',
                }}>
                  {msg.content}
                </div>
              </div>
            ))}
            <div ref={chatEndRef} />
          </div>

          {/* Chat Input */}
          <div style={{
            borderTop: '1px solid #1E1E1E',
            background: '#0A0A0A',
            padding: '0.75rem 1rem',
            flexShrink: 0,
          }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem', marginBottom: '0.6rem' }}>
              {suggestedPrompts.map((prompt, i) => (
                <button key={i} onClick={() => handlePromptClick(prompt)} style={{
                  fontSize: '0.7rem',
                  padding: '0.35rem 0.6rem',
                  background: '#111111',
                  border: '1px solid #1E1E1E',
                  borderRadius: 4,
                  color: '#9E9E9E',
                  cursor: 'pointer',
                }}>{prompt}</button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <textarea
                value={inputValue}
                onChange={e => setInputValue(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
                placeholder="Ask about your positions, traders, or strategies..."
                rows={1}
                style={{
                  flex: 1,
                  background: '#111111',
                  border: '1px solid #1E1E1E',
                  borderRadius: 6,
                  padding: '0.6rem 0.75rem',
                  color: '#FFFFFF',
                  fontSize: '0.9rem',
                  fontFamily: "'Inter', sans-serif",
                  resize: 'none',
                  outline: 'none',
                }}
              />
              <button onClick={handleSend} style={{
                width: 40, height: 40,
                background: '#111111',
                border: '1px solid #1E1E1E',
                borderRadius: 6,
                color: '#9E9E9E',
                cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '1rem',
              }}>{'➤'}</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
