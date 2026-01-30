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

// Filter traders: pick best per platform with realistic win rates (70-95%)
function pickDisplayTraders(traders: FollowedTrader[]): FollowedTrader[] {
  const validWinRate = (t: FollowedTrader) => {
    const wr = t.winRate <= 1 ? t.winRate * 100 : t.winRate;
    return wr >= 70 && wr <= 95;
  };
  const byPnl = (a: FollowedTrader, b: FollowedTrader) => b.pnl30d - a.pnl30d;

  const hl = traders.filter(t => t.platform === 'hyperliquid' && validWinRate(t)).sort(byPnl);
  const av = traders.filter(t => t.platform === 'avantis' && validWinRate(t)).sort(byPnl);
  const pm = traders.filter(t => t.platform === 'polymarket' && validWinRate(t)).sort(byPnl);

  // Fallback: if no valid win rate traders, just pick highest pnl per platform
  const hlPick = hl[0] || traders.filter(t => t.platform === 'hyperliquid').sort(byPnl)[0];
  const avPick = av[0] || traders.filter(t => t.platform === 'avantis').sort(byPnl)[0];
  const pmPick = pm[0] || traders.filter(t => t.platform === 'polymarket').sort(byPnl)[0];

  return [hlPick, avPick, pmPick].filter(Boolean);
}

export default function ChatPage() {
  const [mounted, setMounted] = useState(false);
  const router = useRouter();
  const { address, isConnected } = useAccount();

  const [agentName, setAgentName] = useState('AlphaHunter');
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [activeTab, setActiveTab] = useState<'positions' | 'tokens' | 'trades' | 'markets'>('positions');

  // Data
  const [perpPositions, setPerpPositions] = useState<PerpPosition[]>([]);
  const [pmPositions, setPmPositions] = useState<PMPosition[]>([]);
  const [followedTraders, setFollowedTraders] = useState<FollowedTrader[]>([]);
  const [hoveredTrader, setHoveredTrader] = useState<string | null>(null);

  // Chat
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputValue, setInputValue] = useState('');
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Modal
  const [showModal, setShowModal] = useState(false);
  const [yldrInput, setYldrInput] = useState(100);

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

  const perpTotal = perpPositions.reduce((s, p) => s + (p.margin || p.positionSize || 0), 0);
  const pmTotal = pmPositions.reduce((s, p) => s + (p.currentValue || 0), 0);

  const displayTraders = pickDisplayTraders(followedTraders);

  // YLDR tokenomics: $9M FDV, 210M supply => price = 9000000/210000000 = ~$0.04286 per YLDR
  const yldrPrice = 9000000 / 210000000;
  const yldrTokens = Math.floor(yldrInput / yldrPrice);
  const tradeCapacity = Math.floor(yldrTokens / 1000);

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
          <div
            onClick={() => setShowModal(true)}
            style={{
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
            <span style={{ fontWeight: 600 }}>100K</span>
          </div>
          <button
            onClick={() => setShowModal(true)}
            style={{
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

          {/* Tabs: Positions | Tokens | Trades | Markets */}
          <div style={{
            display: 'flex', alignItems: 'center',
            borderBottom: '1px solid #1E1E1E',
            background: '#0A0A0A',
            flexShrink: 0,
            padding: '0 0.5rem',
          }}>
            <div style={{ display: 'flex', flex: 1 }}>
              {(['positions', 'tokens', 'trades', 'markets'] as const).map(tab => (
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
          </div>

          {/* Filter bar (positions tab only) */}
          {activeTab === 'positions' && (
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
                {displayTraders.map((t, i) => (
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
                    {displayTraders.length}
                  </span>
                </div>
                <div style={{ padding: '0.5rem' }}>
                  {displayTraders.length === 0 ? (
                    <div style={{ fontSize: '0.7rem', color: '#6E6E6E', textAlign: 'center', padding: '0.5rem 0' }}>
                      No traders followed yet
                    </div>
                  ) : displayTraders.map((trader, i) => {
                    const wrDisplay = trader.winRate <= 1 ? (trader.winRate * 100).toFixed(0) : trader.winRate.toFixed(0);
                    return (
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
                            {trader.platform.charAt(0).toUpperCase() + trader.platform.slice(1)} · {wrDisplay}% win
                          </div>
                        </div>
                        <span style={{
                          fontFamily: "'JetBrains Mono', monospace",
                          fontSize: '0.7rem', color: '#00C805', fontWeight: 600,
                        }}>
                          +${trader.pnl30d >= 1000000
                            ? `${(trader.pnl30d / 1000000).toFixed(1)}M`
                            : trader.pnl30d >= 1000
                            ? `${(trader.pnl30d / 1000).toFixed(1)}K`
                            : trader.pnl30d.toFixed(0)}
                        </span>

                        {/* Hover tooltip */}
                        {hoveredTrader === trader.wallet && (
                          <div style={{
                            position: 'fixed',
                            left: 308,
                            top: 'auto',
                            width: 200,
                            background: '#111111',
                            border: '1px solid #00C805',
                            borderRadius: 6,
                            padding: '0.6rem',
                            zIndex: 1000,
                            boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
                            marginTop: -30,
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
                                  {wrDisplay}%
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
                    );
                  })}
                </div>

                {/* AGENT TRAINING SECTION */}
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
                  }}>Agent Training</span>
                </div>
                <div style={{ padding: '0.5rem' }}>
                  <div style={{
                    background: '#111111',
                    border: '1px solid #1E1E1E',
                    borderRadius: 6,
                    padding: '0.6rem',
                  }}>
                    {/* Training Fuel */}
                    <div style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      marginBottom: '0.6rem', paddingBottom: '0.6rem',
                      borderBottom: '1px solid #1E1E1E',
                    }}>
                      <div style={{
                        display: 'flex', alignItems: 'center', gap: '0.35rem',
                        fontFamily: "'JetBrains Mono', monospace", fontSize: '0.75rem',
                      }}>
                        <span style={{ color: '#00C805' }}>{'⚡'}</span>
                        <span style={{ color: '#9E9E9E', fontSize: '0.65rem' }}>Training Fuel:</span>
                        <span style={{ fontWeight: 700 }}>100K YLDR</span>
                      </div>
                      <button
                        onClick={() => setShowModal(true)}
                        style={{
                          fontSize: '0.6rem', fontWeight: 600,
                          padding: '0.3rem 0.5rem',
                          background: 'rgba(0, 200, 5, 0.15)',
                          border: '1px solid rgba(0, 200, 5, 0.3)',
                          borderRadius: 4,
                          color: '#00C805',
                          cursor: 'pointer',
                        }}
                      >Train Agent</button>
                    </div>

                    {/* Current Phase */}
                    <div style={{ marginBottom: '0.6rem' }}>
                      <div style={{
                        fontSize: '0.55rem', textTransform: 'uppercase', letterSpacing: '0.05em',
                        color: '#6E6E6E', marginBottom: '0.2rem',
                      }}>Current Phase</div>
                      <div style={{ fontSize: '0.65rem', fontWeight: 700, color: '#FFD000', marginBottom: '0.15rem', letterSpacing: '0.05em' }}>
                        DATA MONITORING
                      </div>
                      <div style={{ fontSize: '0.65rem', color: '#9E9E9E' }}>
                        Monitoring traders and collecting trade data
                      </div>
                    </div>

                    {/* Agent Activity - all 0 except YLDR */}
                    <div style={{
                      background: '#0A0A0A', borderRadius: 4, padding: '0.5rem',
                      marginBottom: '0.6rem',
                    }}>
                      {[
                        ['Trades analyzed', '0'],
                        ['Insights generated', '0'],
                        ['Trader alignments', '0'],
                        ['YLDR consumed', '0'],
                      ].map(([label, value]) => (
                        <div key={label} style={{
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                          fontSize: '0.65rem', padding: '0.2rem 0',
                        }}>
                          <span style={{ color: '#6E6E6E' }}>{label}</span>
                          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 600 }}>{value}</span>
                        </div>
                      ))}
                    </div>

                    {/* Training Threshold */}
                    <div style={{
                      background: '#0A0A0A', borderRadius: 4, padding: '0.5rem',
                      marginBottom: '0.6rem',
                    }}>
                      <div style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        fontSize: '0.6rem', marginBottom: '0.35rem',
                      }}>
                        <span style={{ color: '#6E6E6E' }}>Training Starts At</span>
                        <span style={{ fontFamily: "'JetBrains Mono', monospace", color: '#FFD000', fontWeight: 600 }}>1,000 trades</span>
                      </div>
                      <div style={{
                        height: 6, background: '#000', borderRadius: 3, overflow: 'hidden',
                        marginBottom: '0.25rem',
                      }}>
                        <div style={{
                          height: '100%', width: '0%',
                          background: 'linear-gradient(90deg, #FFD000 0%, #00C805 100%)',
                          borderRadius: 3,
                        }} />
                      </div>
                      <div style={{ fontSize: '0.55rem', color: '#6E6E6E', textAlign: 'right' }}>
                        1,000 more trades needed
                      </div>
                    </div>

                    {/* What Training Unlocks */}
                    <div style={{ marginBottom: '0.6rem' }}>
                      <div style={{ fontSize: '0.6rem', fontWeight: 600, color: '#9E9E9E', marginBottom: '0.35rem' }}>
                        What Training Unlocks
                      </div>
                      {[
                        'Personalized entry/exit signals',
                        'Pattern recognition from your traders',
                        'Position sizing & risk management advice',
                        'Auto-execution (coming soon)',
                      ].map((text, i) => (
                        <div key={i} style={{
                          display: 'flex', alignItems: 'flex-start', gap: '0.35rem',
                          fontSize: '0.65rem', color: '#6E6E6E', padding: '0.15rem 0',
                        }}>
                          <span style={{ color: '#6E6E6E', flexShrink: 0 }}>{'○'}</span>
                          <span>{text}</span>
                        </div>
                      ))}
                    </div>

                    {/* Expected ROI */}
                    <div style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      padding: '0.5rem',
                      background: 'rgba(0, 200, 5, 0.08)',
                      border: '1px solid rgba(0, 200, 5, 0.15)',
                      borderRadius: 4,
                      marginBottom: '0.6rem',
                    }}>
                      <div>
                        <div style={{ fontSize: '0.65rem', color: '#9E9E9E', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                          {'📈'} Expected Agent ROI
                        </div>
                        <div style={{ fontSize: '0.55rem', color: '#6E6E6E' }}>
                          Based on avg of {displayTraders.length} followed traders
                        </div>
                      </div>
                      <div style={{
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: '0.85rem', fontWeight: 700, color: '#00C805',
                      }}>+0%</div>
                    </div>

                    {/* Train Agent CTA */}
                    <button
                      onClick={() => setShowModal(true)}
                      style={{
                        width: '100%', padding: '0.6rem',
                        background: '#00C805', border: 'none', borderRadius: 4,
                        color: '#000', fontSize: '0.75rem', fontWeight: 700,
                        cursor: 'pointer',
                      }}
                    >Train Agent</button>

                    {/* V1 label + docs */}
                    <div style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      marginTop: '0.5rem', paddingTop: '0.5rem',
                      borderTop: '1px solid #1E1E1E',
                    }}>
                      <span style={{
                        fontSize: '0.5rem', fontWeight: 700, padding: '0.15rem 0.35rem',
                        background: 'rgba(0, 136, 255, 0.15)', color: '#0088FF', borderRadius: 3,
                        letterSpacing: '0.03em',
                      }}>COMING IN V1</span>
                      <a
                        href="https://yieldr.org/docs"
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ fontSize: '0.55rem', color: '#00C805', textDecoration: 'none' }}
                      >Read docs &rarr;</a>
                    </div>
                  </div>
                </div>
              </>
            )}

            {/* TOKENS TAB */}
            {activeTab === 'tokens' && (
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
                <div style={{ padding: '1.5rem 0.5rem', textAlign: 'center' }}>
                  <div style={{ fontSize: '0.75rem', color: '#6E6E6E', marginBottom: '0.5rem' }}>
                    Multi-chain token detection coming soon
                  </div>
                  <div style={{ fontSize: '0.65rem', color: '#6E6E6E' }}>
                    Will detect tokens across Base, Ethereum, Arbitrum, and more
                  </div>
                </div>
              </div>
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

      {/* YLDR MODAL */}
      {showModal && (
        <div
          onClick={() => setShowModal(false)}
          style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0, 0, 0, 0.9)',
            backdropFilter: 'blur(8px)',
            zIndex: 1000,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '1.5rem',
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: '#0A0A0A',
              border: '1px solid #00C805',
              borderRadius: 8,
              maxWidth: 440,
              width: '100%',
              maxHeight: '90vh',
              overflowY: 'auto',
            }}
          >
            {/* Modal Header */}
            <div style={{
              padding: '1rem',
              borderBottom: '1px solid #1E1E1E',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            }}>
              <h2 style={{ fontSize: '1rem', fontWeight: 700, margin: 0 }}>Get YLDR Tokens</h2>
              <button
                onClick={() => setShowModal(false)}
                style={{
                  width: 28, height: 28,
                  background: '#111111',
                  border: '1px solid #1E1E1E',
                  borderRadius: 4,
                  color: '#9E9E9E',
                  cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '1rem',
                }}
              >{'×'}</button>
            </div>

            {/* Modal Body */}
            <div style={{ padding: '1rem' }}>
              <p style={{ fontSize: '0.85rem', color: '#9E9E9E', lineHeight: 1.5, marginBottom: '1rem' }}>
                YLDR powers your agent's training. Early buyers get the best price — it increases at each tier.
              </p>

              {/* Tier Card */}
              <div style={{
                background: '#111111',
                border: '1px solid #1E1E1E',
                borderRadius: 6,
                padding: '0.75rem',
                marginBottom: '1rem',
              }}>
                <div style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  marginBottom: '0.5rem',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                    <span style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: '0.6rem', fontWeight: 700,
                      padding: '0.2rem 0.4rem',
                      background: '#00C805', color: '#000', borderRadius: 3,
                    }}>TIER 1</span>
                    <span style={{ fontSize: '0.8rem', fontWeight: 600 }}>Early Access</span>
                  </div>
                  <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '0.75rem', color: '#9E9E9E' }}>$9M FDV</span>
                </div>
                <div style={{ marginBottom: '0.5rem' }}>
                  <div style={{ height: 4, background: '#000', borderRadius: 2, overflow: 'hidden', marginBottom: '0.25rem' }}>
                    <div style={{ height: '100%', width: '35%', background: '#00C805' }} />
                  </div>
                  <div style={{ fontSize: '0.65rem', color: '#6E6E6E' }}>35% filled — 650K YLDR left at this price</div>
                </div>
                <div style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  paddingTop: '0.5rem', borderTop: '1px solid #1E1E1E', fontSize: '0.7rem',
                }}>
                  <span style={{ color: '#9E9E9E' }}>Next tier</span>
                  <span style={{ fontFamily: "'JetBrains Mono', monospace", color: '#FFD000', fontWeight: 600 }}>$14M FDV (+56%)</span>
                </div>
              </div>

              {/* Amount Input */}
              <div style={{ marginBottom: '1rem' }}>
                <label style={{ fontSize: '0.75rem', fontWeight: 600, marginBottom: '0.35rem', display: 'block' }}>Amount</label>
                <div style={{ position: 'relative' }}>
                  <input
                    type="number"
                    value={yldrInput}
                    onChange={e => setYldrInput(Math.max(0, parseFloat(e.target.value) || 0))}
                    min={0}
                    style={{
                      width: '100%',
                      background: '#111111',
                      border: '1px solid #1E1E1E',
                      borderRadius: 6,
                      padding: '0.75rem 3.5rem 0.75rem 0.75rem',
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: '1.25rem', fontWeight: 600,
                      color: '#FFFFFF',
                      outline: 'none',
                    }}
                  />
                  <span style={{
                    position: 'absolute', right: '0.75rem', top: '50%', transform: 'translateY(-50%)',
                    fontFamily: "'JetBrains Mono', monospace", fontSize: '0.85rem', color: '#6E6E6E',
                  }}>USDC</span>
                </div>
              </div>

              {/* Conversion Display */}
              <div style={{
                background: '#111111',
                border: '1px solid #1E1E1E',
                borderRadius: 6,
                padding: '0.75rem',
                marginBottom: '1rem',
              }}>
                {[
                  ['You Receive', `${yldrTokens.toLocaleString()} YLDR`],
                  ['Agent Training', `~${tradeCapacity.toLocaleString()} trades`],
                  ['Max Supply', '210,000,000 YLDR'],
                ].map(([label, value]) => (
                  <div key={label} style={{
                    display: 'flex', justifyContent: 'space-between',
                    fontSize: '0.8rem', marginBottom: '0.35rem',
                  }}>
                    <span style={{ color: '#9E9E9E' }}>{label}</span>
                    <span style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, color: '#00C805' }}>{value}</span>
                  </div>
                ))}
              </div>

              {/* Why Buy Now */}
              <div style={{
                background: 'rgba(0, 200, 5, 0.08)',
                border: '1px solid rgba(0, 200, 5, 0.2)',
                borderRadius: 6,
                padding: '0.75rem',
                marginBottom: '1rem',
              }}>
                <div style={{ fontSize: '0.7rem', fontWeight: 600, color: '#00C805', marginBottom: '0.5rem' }}>
                  Why Buy Now
                </div>
                {[
                  'AI chat credits for trading insights',
                  'Train agent to unlock personalized signals',
                  'Early access to Execute (auto-trading)',
                  'Potential 10-100x if listed on major exchange',
                ].map((text, i) => (
                  <div key={i} style={{
                    display: 'flex', alignItems: 'flex-start', gap: '0.4rem',
                    fontSize: '0.75rem', marginBottom: '0.35rem', lineHeight: 1.4,
                  }}>
                    <span style={{ color: '#00C805', flexShrink: 0 }}>{'✓'}</span>
                    <span>{text}</span>
                  </div>
                ))}
              </div>

              {/* Buy Button - Deactivated */}
              <button
                disabled
                style={{
                  width: '100%',
                  background: '#333',
                  color: '#666',
                  border: 'none',
                  padding: '0.75rem',
                  borderRadius: 6,
                  fontWeight: 700,
                  fontSize: '0.9rem',
                  cursor: 'not-allowed',
                  opacity: 0.6,
                }}
              >Buy YLDR (Coming Soon)</button>

              <p style={{
                fontSize: '0.7rem', color: '#6E6E6E',
                textAlign: 'center', marginTop: '0.75rem', lineHeight: 1.5,
              }}>
                Only users can mint. No team/VC allocation until listing.<br />
                <a
                  href="https://yieldr.org/docs"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: '#00C805', textDecoration: 'none' }}
                >Learn about tokenomics &rarr;</a>
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
