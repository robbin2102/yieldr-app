'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useAccount, useDisconnect } from 'wagmi';
import { useRouter } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

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
  matchReason?: string;
}

interface ChatMessage {
  id: string;
  role: 'agent' | 'user';
  content: string;
  time: string;
}

interface TokenBalance {
  symbol: string;
  name: string;
  balance: number;
  usdPrice: number | null;
  usdValue: number | null;
  chain: string;
  logo: string | null;
  isNative: boolean;
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

// Free credits limit (300k tokens)
const FREE_CREDITS_LIMIT = 300000;

export default function ChatPage() {
  const [mounted, setMounted] = useState(false);
  const router = useRouter();
  const { address, isConnected, isReconnecting } = useAccount();
  const { disconnect } = useDisconnect();

  // Auth state - check localStorage first, then verify with wagmi
  const [authChecking, setAuthChecking] = useState(true);
  const [authenticatedWallet, setAuthenticatedWallet] = useState<string | null>(null);

  const [agentName, setAgentName] = useState('AlphaHunter');
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [activeTab, setActiveTab] = useState<'positions' | 'tokens' | 'trades' | 'markets'>('positions');

  // Credits state
  const [creditsUsed, setCreditsUsed] = useState(0);
  const [creditsLoading, setCreditsLoading] = useState(true);
  const creditsExceeded = creditsUsed >= FREE_CREDITS_LIMIT;

  // Data
  const [perpPositions, setPerpPositions] = useState<PerpPosition[]>([]);
  const [pmPositions, setPmPositions] = useState<PMPosition[]>([]);
  const [followedTraders, setFollowedTraders] = useState<FollowedTrader[]>([]);
  const [hoveredTrader, setHoveredTrader] = useState<string | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const [tokens, setTokens] = useState<TokenBalance[]>([]);
  const [tokensLoading, setTokensLoading] = useState(false);
  const [tokensTotalUsd, setTokensTotalUsd] = useState(0);

  // Chat
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputValue, setInputValue] = useState('');
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Chat sessions
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [chatSessions, setChatSessions] = useState<{ id: string; title: string; updatedAt: string }[]>([]);
  const [showHistory, setShowHistory] = useState(false);

  // Modal
  const [showModal, setShowModal] = useState(false);
  const [yldrInput, setYldrInput] = useState(100);

  useEffect(() => { setMounted(true); }, []);

  // Auth check - use localStorage + wagmi for persistent login
  useEffect(() => {
    if (!mounted) return;

    // Check localStorage for previously authenticated wallet
    const storedWallet = localStorage.getItem('yieldr_auth_wallet');
    const agentCreated = localStorage.getItem('agentCreated');

    if (storedWallet) {
      setAuthenticatedWallet(storedWallet.toLowerCase());
    } else if (agentCreated) {
      // Fallback: extract wallet from agentCreated data
      try {
        const data = JSON.parse(agentCreated);
        if (data.wallet) {
          localStorage.setItem('yieldr_auth_wallet', data.wallet.toLowerCase());
          setAuthenticatedWallet(data.wallet.toLowerCase());
        }
      } catch {}
    }

    // Wait a bit for wagmi to potentially reconnect
    const timer = setTimeout(() => {
      setAuthChecking(false);
    }, 1500);

    return () => clearTimeout(timer);
  }, [mounted]);

  // Sync wagmi connection with auth state
  useEffect(() => {
    if (!mounted || authChecking) return;

    // If wagmi connected, update auth state
    if (isConnected && address) {
      localStorage.setItem('yieldr_auth_wallet', address.toLowerCase());
      setAuthenticatedWallet(address.toLowerCase());
    }

    // Only redirect if both wagmi and localStorage auth fail
    if (!isConnected && !isReconnecting && !authenticatedWallet) {
      router.push('/demo');
    }
  }, [mounted, authChecking, isConnected, isReconnecting, address, authenticatedWallet, router]);

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

  // Fetch credits/usage
  const fetchCredits = useCallback(async (wallet: string) => {
    try {
      const res = await fetch(`/api/usage/${wallet}`);
      if (res.ok) {
        const data = await res.json();
        if (data.success && data.data) {
          const totalTokens = (data.data.lifetime?.totalInputTokens || 0) + (data.data.lifetime?.totalOutputTokens || 0);
          setCreditsUsed(totalTokens);
        }
      }
    } catch (err) {
      console.error('[chat] Failed to fetch credits:', err);
    } finally {
      setCreditsLoading(false);
    }
  }, []);

  // Load credits on mount
  useEffect(() => {
    const wallet = address || authenticatedWallet;
    if (mounted && wallet) {
      fetchCredits(wallet);
    }
  }, [mounted, address, authenticatedWallet, fetchCredits]);

  // Handle logout/disconnect
  const handleLogout = useCallback(() => {
    localStorage.removeItem('yieldr_auth_wallet');
    localStorage.removeItem('agentCreated');
    localStorage.removeItem('agentSetup');
    disconnect();
    router.push('/demo');
  }, [disconnect, router]);

  // Fetch data
  useEffect(() => {
    const wallet = address || authenticatedWallet;
    if (!mounted || !wallet) return;

    // Fetch perp positions from positions API
    fetch(`/api/positions?address=${wallet}`)
      .then(r => r.json())
      .then(data => {
        if (data.success && data.data) {
          setPerpPositions(data.data.perpPositions || []);
        }
      })
      .catch(() => {});

    // Fetch PM positions separately
    fetch(`/api/polymarket-positions?address=${wallet}`)
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

    // Fetch token balances
    setTokensLoading(true);
    fetch(`/api/demo/tokens?address=${wallet}`)
      .then(r => r.json())
      .then(data => {
        if (data.success && data.data) {
          setTokens(data.data.tokens || []);
          setTokensTotalUsd(data.data.totalUsdValue || 0);
        }
      })
      .catch(() => {})
      .finally(() => setTokensLoading(false));

    // Fetch agent (for followed traders)
    fetch(`/api/demo/agents?wallet=${wallet}`)
      .then(r => r.json())
      .then(data => {
        if (data.success && data.agent) {
          setFollowedTraders(data.agent.followedTraders || []);
          if (data.agent.name) setAgentName(data.agent.name);
        }
      })
      .catch(() => {});
  }, [mounted, address, authenticatedWallet]);

  // Load chat sessions list
  const loadChatSessions = useCallback(async () => {
    const wallet = address || authenticatedWallet;
    if (!wallet) return;
    try {
      const res = await fetch(`/api/demo/chat-sessions?wallet=${wallet}`);
      const data = await res.json();
      if (data.success) {
        setChatSessions(data.sessions.map((s: any) => ({
          id: s.id,
          title: s.title,
          updatedAt: s.updatedAt,
        })));
      }
    } catch {}
  }, [address, authenticatedWallet]);

  useEffect(() => {
    const wallet = address || authenticatedWallet;
    if (mounted && wallet) loadChatSessions();
  }, [mounted, address, authenticatedWallet, loadChatSessions]);

  // Load a specific chat session
  const loadSession = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/demo/chat-sessions/${id}`);
      const data = await res.json();
      if (data.success && data.session) {
        setSessionId(id);
        setMessages(data.session.messages.map((m: any, i: number) => ({
          id: `${id}-${i}`,
          role: m.role,
          content: m.content,
          time: new Date(m.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
        })));
        setShowHistory(false);
      }
    } catch {}
  }, []);

  // Start a new chat
  const startNewChat = useCallback(() => {
    setSessionId(null);
    setMessages([]);
    setShowHistory(false);
  }, []);

  // Track whether initial analysis has been triggered
  const initialAnalysisTriggered = useRef(false);

  // Initial agent message - calls the LLM to generate portfolio analysis
  useEffect(() => {
    const wallet = address || authenticatedWallet;
    if (!mounted || messages.length > 0 || !wallet || initialAnalysisTriggered.current) return;
    initialAnalysisTriggered.current = true;

    const now = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    const agentMsgId = 'initial-analysis';

    // Show an empty agent message that will be filled by streaming
    setMessages([{
      id: agentMsgId,
      role: 'agent',
      content: '',
      time: now,
    }]);
    setIsStreaming(true);

    console.log('[chat-page] Triggering initial-analysis...');

    (async () => {
      try {
        const res = await fetch('/api/demo/chat/initial-analysis', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ wallet }),
        });

        if (!res.ok) {
          // If the API fails, try parsing as JSON for a static response
          const errData = await res.json().catch(() => ({ error: 'Unknown error' }));
          setMessages([{
            id: agentMsgId,
            role: 'agent',
            content: `Welcome! I'm ${agentName}, your AI trading agent. I'm ready to help you analyze markets, track positions, and learn from top traders.\n\nAsk me anything about your positions or strategies.`,
            time: now,
          }]);
          setIsStreaming(false);
          console.log('[chat-page] initial-analysis failed:', errData.error);
          return;
        }

        const contentType = res.headers.get('content-type') || '';

        // Handle static response (no positions)
        if (contentType.includes('application/json')) {
          const data = await res.json();
          setMessages([{
            id: agentMsgId,
            role: 'agent',
            content: data.content || `Welcome! I'm ${agentName}, your AI trading agent.`,
            time: now,
          }]);
          setIsStreaming(false);
          console.log('[chat-page] initial-analysis: static response (no positions)');
          return;
        }

        // Handle streaming response
        if (!res.body) {
          setIsStreaming(false);
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const parsed = JSON.parse(line);
              if (parsed.type === 'text') {
                setMessages(prev => prev.map(m =>
                  m.id === agentMsgId ? { ...m, content: m.content + parsed.text } : m
                ));
              } else if (parsed.type === 'session') {
                setSessionId(parsed.sessionId);
                loadChatSessions();
                console.log('[chat-page] initial-analysis session created:', parsed.sessionId);
              } else if (parsed.type === 'error') {
                console.error('[chat-page] initial-analysis stream error:', parsed.error);
              }
            } catch {}
          }
        }

        console.log('[chat-page] initial-analysis streaming complete');
      } catch (err: any) {
        console.error('[chat-page] initial-analysis fetch error:', err.message);
        setMessages([{
          id: agentMsgId,
          role: 'agent',
          content: `Welcome! I'm ${agentName}, your AI trading agent. I encountered an issue loading your analysis, but I'm ready to help.\n\nAsk me anything about your positions or strategies.`,
          time: now,
        }]);
      }
      setIsStreaming(false);
      // Refresh credits after initial analysis
      if (wallet) fetchCredits(wallet);
    })();
  }, [mounted, address, authenticatedWallet, agentName, messages.length, loadChatSessions, fetchCredits]);

  const [isStreaming, setIsStreaming] = useState(false);
  const [toolStatus, setToolStatus] = useState<string | null>(null);

  // Auto-scroll chat — scroll on new messages, tool status, and continuously during streaming
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, toolStatus]);

  useEffect(() => {
    if (!isStreaming) return;
    const interval = setInterval(() => {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, 300);
    return () => clearInterval(interval);
  }, [isStreaming]);

  const handleSend = useCallback(async () => {
    const text = inputValue.trim();
    if (!text || isStreaming || creditsExceeded) return;
    setInputValue('');

    const wallet = address || authenticatedWallet;
    if (!wallet) return;

    const now = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    const userMsg: ChatMessage = {
      id: Date.now().toString(),
      role: 'user',
      content: text,
      time: now,
    };
    const agentMsgId = (Date.now() + 1).toString();

    setMessages(prev => [...prev, userMsg, {
      id: agentMsgId,
      role: 'agent',
      content: '',
      time: now,
    }]);
    setIsStreaming(true);

    // Build conversation history for API (exclude the empty agent msg)
    const apiMessages = [...messages, userMsg]
      .filter(m => m.content.trim())
      .map(m => ({ role: m.role, content: m.content }));

    try {
      const res = await fetch('/api/demo/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: apiMessages, wallet, sessionId }),
      });

      if (!res.ok || !res.body) {
        const errData = await res.json().catch(() => ({ error: 'Unknown error' }));
        setMessages(prev => prev.map(m =>
          m.id === agentMsgId ? { ...m, content: `Error: ${errData.error || 'Failed to get response'}` } : m
        ));
        setIsStreaming(false);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed.type === 'text') {
              setToolStatus(null); // Clear tool status when text starts
              setMessages(prev => prev.map(m =>
                m.id === agentMsgId ? { ...m, content: m.content + parsed.text } : m
              ));
            } else if (parsed.type === 'tool_status') {
              setToolStatus(parsed.status);
            } else if (parsed.type === 'session') {
              setSessionId(parsed.sessionId);
              loadChatSessions();
            } else if (parsed.type === 'error') {
              setMessages(prev => prev.map(m =>
                m.id === agentMsgId ? { ...m, content: m.content || `Error: ${parsed.error}` } : m
              ));
            }
          } catch {}
        }
      }
    } catch (err: any) {
      setMessages(prev => prev.map(m =>
        m.id === agentMsgId ? { ...m, content: `Connection error: ${err.message}` } : m
      ));
    }

    setIsStreaming(false);
    setToolStatus(null);
    // Refresh credits after each message
    if (wallet) fetchCredits(wallet);
  }, [inputValue, isStreaming, creditsExceeded, messages, address, authenticatedWallet, sessionId, loadChatSessions, fetchCredits]);

  const handlePromptClick = (prompt: string) => {
    setInputValue(prompt);
  };

  // Use either wagmi address or stored authenticated wallet
  const effectiveWallet = address || authenticatedWallet;
  const shortWallet = effectiveWallet ? `${effectiveWallet.slice(0, 6)}...${effectiveWallet.slice(-4)}` : '';
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

  // Format credits display (e.g., 32.1k/300k)
  const formatCredits = (used: number) => {
    const usedK = used >= 1000 ? `${(used / 1000).toFixed(1)}k` : used.toString();
    const limitK = `${FREE_CREDITS_LIMIT / 1000}k`;
    return `${usedK}/${limitK}`;
  };

  const creditsPercent = Math.min((creditsUsed / FREE_CREDITS_LIMIT) * 100, 100);

  if (!mounted) return null;

  // Show loading state while checking auth
  if (authChecking || isReconnecting) {
    return (
      <div style={{
        height: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#000',
        fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
      }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{
            width: 48, height: 48, margin: '0 auto 1rem',
            border: '3px solid #1E1E1E',
            borderTop: '3px solid #00C805',
            borderRadius: '50%',
            animation: 'spin 1s linear infinite',
          }} />
          <div style={{ color: '#9E9E9E', fontSize: '0.9rem' }}>Reconnecting wallet...</div>
          <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
        </div>
      </div>
    );
  }

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
        <button
          onClick={handleLogout}
          title="Disconnect wallet"
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '0.75rem',
            color: '#9E9E9E',
            background: '#111111',
            padding: '0.35rem 0.6rem',
            borderRadius: 4,
            border: '1px solid #1E1E1E',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '0.4rem',
          }}>
          <span>{shortWallet}</span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <polyline points="16 17 21 12 16 7" />
            <line x1="21" y1="12" x2="9" y2="12" />
          </svg>
        </button>
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
          {/* Credits Display */}
          <div
            title={`AI Credits: ${creditsUsed.toLocaleString()} / ${FREE_CREDITS_LIMIT.toLocaleString()} tokens used`}
            style={{
              display: 'flex', alignItems: 'center', gap: '0.4rem',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '0.7rem',
              padding: '0.35rem 0.6rem',
              background: '#0A0A0A',
              border: `1px solid ${creditsExceeded ? '#FF4757' : '#1E1E1E'}`,
              borderRadius: 4,
            }}>
            <span style={{ color: creditsExceeded ? '#FF4757' : '#00C805' }}>{'⚡'}</span>
            {creditsLoading ? (
              <span style={{ color: '#6E6E6E' }}>...</span>
            ) : (
              <>
                <span style={{ fontWeight: 600, color: creditsExceeded ? '#FF4757' : '#FFFFFF' }}>
                  {formatCredits(creditsUsed)}
                </span>
                <div style={{
                  width: 40,
                  height: 4,
                  background: '#1E1E1E',
                  borderRadius: 2,
                  overflow: 'hidden',
                }}>
                  <div style={{
                    width: `${creditsPercent}%`,
                    height: '100%',
                    background: creditsExceeded ? '#FF4757' : creditsPercent > 80 ? '#FFD000' : '#00C805',
                    borderRadius: 2,
                  }} />
                </div>
              </>
            )}
          </div>
          <a
            href="https://yieldr.org"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              fontSize: '0.65rem', fontWeight: 600,
              padding: '0.35rem 0.5rem',
              background: '#00C805', border: 'none', borderRadius: 4,
              color: '#000', cursor: 'pointer',
              textDecoration: 'none',
            }}>+ Get YLDR</a>
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
            <span style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '0.7rem', fontWeight: 700, color: '#FFFFFF',
            }}>
              ${(perpTotal + pmTotal + tokensTotalUsd).toLocaleString(undefined, { maximumFractionDigits: 0 })}
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
                        onMouseEnter={(e) => {
                          const rect = e.currentTarget.getBoundingClientRect();
                          setTooltipPos({ top: rect.top, left: rect.right + 8 });
                          setHoveredTrader(trader.wallet);
                        }}
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
                            left: tooltipPos.left,
                            top: tooltipPos.top,
                            width: 200,
                            background: '#111111',
                            border: '1px solid #00C805',
                            borderRadius: 6,
                            padding: '0.6rem',
                            zIndex: 1000,
                            boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
                          }}>
                            <div style={{ fontSize: '0.8rem', fontWeight: 700, marginBottom: '0.4rem' }}>
                              {trader.username || `${trader.wallet.slice(0, 10)}...`}
                            </div>
                            <div style={{ fontSize: '0.6rem', color: '#6E6E6E', marginBottom: trader.matchReason ? '0.25rem' : '0.5rem', textTransform: 'capitalize' }}>
                              {trader.platform}
                            </div>
                            {trader.matchReason && (
                              <div style={{ fontSize: '0.55rem', color: '#00C805', marginBottom: '0.5rem', fontStyle: 'italic' }}>
                                {trader.matchReason}
                              </div>
                            )}
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
                      <a
                        href="https://yieldr.org"
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                          fontSize: '0.6rem', fontWeight: 600,
                          padding: '0.3rem 0.5rem',
                          background: 'rgba(0, 200, 5, 0.15)',
                          border: '1px solid rgba(0, 200, 5, 0.3)',
                          borderRadius: 4,
                          color: '#00C805',
                          cursor: 'pointer',
                          textDecoration: 'none',
                        }}
                      >Train Agent</a>
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
                    <a
                      href="https://yieldr.org"
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{
                        display: 'block',
                        width: '100%', padding: '0.6rem',
                        background: '#00C805', border: 'none', borderRadius: 4,
                        color: '#000', fontSize: '0.75rem', fontWeight: 700,
                        cursor: 'pointer',
                        textAlign: 'center',
                        textDecoration: 'none',
                        boxSizing: 'border-box',
                      }}
                    >Train Agent</a>

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
              <div>
                {/* Header */}
                <div style={{
                  fontSize: '0.6rem', textTransform: 'uppercase', letterSpacing: '0.05em',
                  color: '#6E6E6E', padding: '0.5rem',
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  background: '#111111', borderBottom: '1px solid #1E1E1E',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                    <span>Tokens</span>
                    <span style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: '0.55rem', color: '#6E6E6E',
                      background: '#1A1A1A', padding: '0.1rem 0.25rem', borderRadius: 2,
                    }}>{shortWallet}</span>
                  </div>
                  <span style={{ fontFamily: "'JetBrains Mono', monospace", color: '#9E9E9E' }}>
                    {tokensTotalUsd > 0 ? `$${tokensTotalUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '--'}
                  </span>
                </div>

                {/* Chain badges */}
                <div style={{
                  padding: '0.4rem 0.5rem',
                  display: 'flex', flexWrap: 'wrap', gap: '0.25rem',
                  borderBottom: '1px solid #1E1E1E',
                }}>
                  {['Ethereum', 'Base', 'Arbitrum', 'Optimism', 'Polygon'].map(chain => {
                    const hasTokens = tokens.some(t => t.chain === chain);
                    return (
                      <span key={chain} style={{
                        fontSize: '0.5rem', padding: '0.15rem 0.3rem',
                        background: hasTokens ? 'rgba(0, 200, 5, 0.1)' : '#1A1A1A',
                        border: `1px solid ${hasTokens ? 'rgba(0, 200, 5, 0.3)' : '#1E1E1E'}`,
                        borderRadius: 3,
                        color: hasTokens ? '#00C805' : '#6E6E6E',
                        fontWeight: 500,
                      }}>{chain}</span>
                    );
                  })}
                </div>

                {/* Token list */}
                <div style={{ padding: '0.5rem' }}>
                  {tokensLoading ? (
                    <div style={{ fontSize: '0.75rem', color: '#6E6E6E', textAlign: 'center', padding: '1.5rem 0' }}>
                      Scanning chains...
                    </div>
                  ) : tokens.length === 0 ? (
                    <div style={{ fontSize: '0.75rem', color: '#6E6E6E', textAlign: 'center', padding: '1.5rem 0' }}>
                      No tokens found across chains
                    </div>
                  ) : tokens.map((token, i) => (
                    <div key={i} style={{
                      background: '#111111',
                      border: '1px solid #1E1E1E',
                      borderRadius: 5,
                      padding: '0.45rem 0.5rem',
                      marginBottom: '0.3rem',
                      display: 'flex', alignItems: 'center', gap: '0.4rem',
                    }}>
                      {/* Token icon */}
                      <div style={{
                        width: 24, height: 24, borderRadius: '50%',
                        background: token.isNative ? 'linear-gradient(135deg, #627EEA 0%, #3B5998 100%)' : '#1A1A1A',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: '0.6rem', fontWeight: 700, color: '#9E9E9E',
                        overflow: 'hidden', flexShrink: 0,
                      }}>
                        {token.logo ? (
                          <img src={token.logo} alt="" style={{ width: '100%', height: '100%' }} />
                        ) : (
                          token.symbol.slice(0, 2)
                        )}
                      </div>

                      {/* Token info */}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                          <span style={{ fontWeight: 600, fontSize: '0.75rem' }}>{token.symbol}</span>
                          <span style={{
                            fontSize: '0.45rem', color: '#6E6E6E',
                            background: '#1A1A1A', padding: '0.1rem 0.2rem', borderRadius: 2,
                          }}>{token.chain}</span>
                          {token.isNative && (
                            <span style={{
                              fontSize: '0.4rem', color: '#0088FF',
                              background: 'rgba(0, 136, 255, 0.1)', padding: '0.1rem 0.2rem', borderRadius: 2,
                            }}>NATIVE</span>
                          )}
                        </div>
                        <div style={{
                          fontSize: '0.55rem', color: '#6E6E6E',
                          fontFamily: "'JetBrains Mono', monospace",
                        }}>
                          {token.balance < 0.001
                            ? token.balance.toExponential(2)
                            : token.balance < 1
                            ? token.balance.toFixed(4)
                            : token.balance.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                        </div>
                      </div>

                      {/* USD value */}
                      <div style={{ textAlign: 'right', flexShrink: 0 }}>
                        <div style={{
                          fontFamily: "'JetBrains Mono', monospace",
                          fontSize: '0.75rem', fontWeight: 600,
                        }}>
                          {token.usdValue !== null
                            ? `$${token.usdValue < 0.01 ? token.usdValue.toFixed(4) : token.usdValue.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
                            : '--'}
                        </div>
                        {token.usdPrice !== null && (
                          <div style={{
                            fontSize: '0.5rem', color: '#6E6E6E',
                            fontFamily: "'JetBrains Mono', monospace",
                          }}>
                            @${token.usdPrice < 0.01 ? token.usdPrice.toFixed(6) : token.usdPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
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
          {/* Chat History Dropdown */}
          {showHistory && (
            <div style={{
              position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
              background: 'rgba(0,0,0,0.7)', zIndex: 20,
            }} onClick={() => setShowHistory(false)}>
              <div
                onClick={e => e.stopPropagation()}
                style={{
                  position: 'absolute', top: '0.5rem', right: '0.5rem',
                  width: 300, maxHeight: '70vh',
                  background: '#111111', border: '1px solid #1E1E1E',
                  borderRadius: 8, overflow: 'hidden',
                  display: 'flex', flexDirection: 'column',
                }}
              >
                <div style={{
                  padding: '0.6rem 0.75rem',
                  borderBottom: '1px solid #1E1E1E',
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                }}>
                  <span style={{ fontSize: '0.8rem', fontWeight: 600 }}>Chat History</span>
                  <button onClick={startNewChat} style={{
                    fontSize: '0.65rem', fontWeight: 600,
                    padding: '0.25rem 0.5rem',
                    background: '#00C805', border: 'none', borderRadius: 4,
                    color: '#000', cursor: 'pointer',
                  }}>+ New Chat</button>
                </div>
                <div style={{ flex: 1, overflowY: 'auto' }}>
                  {chatSessions.length === 0 ? (
                    <div style={{ padding: '1.5rem', textAlign: 'center', fontSize: '0.75rem', color: '#6E6E6E' }}>
                      No previous chats
                    </div>
                  ) : chatSessions.map(s => (
                    <div
                      key={s.id}
                      onClick={() => loadSession(s.id)}
                      style={{
                        padding: '0.6rem 0.75rem',
                        borderBottom: '1px solid #1E1E1E',
                        cursor: 'pointer',
                        background: s.id === sessionId ? 'rgba(0, 200, 5, 0.08)' : 'transparent',
                      }}
                    >
                      <div style={{
                        fontSize: '0.75rem', fontWeight: 500,
                        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                      }}>{s.title}</div>
                      <div style={{
                        fontSize: '0.6rem', color: '#6E6E6E',
                        fontFamily: "'JetBrains Mono', monospace",
                        marginTop: '0.15rem',
                      }}>
                        {new Date(s.updatedAt).toLocaleDateString()}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

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
                  ...(msg.role === 'user' ? { whiteSpace: 'pre-wrap' } : {}),
                }}>
                  {msg.role === 'agent' ? (
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={{
                        h2: ({ children }) => (
                          <h2 style={{ fontSize: '1.1rem', fontWeight: 600, color: '#FFFFFF', margin: '1rem 0 0.5rem' }}>{children}</h2>
                        ),
                        h3: ({ children }) => (
                          <h3 style={{ fontSize: '0.95rem', fontWeight: 600, color: '#E0E0E0', margin: '0.75rem 0 0.35rem' }}>{children}</h3>
                        ),
                        p: ({ children }) => (
                          <p style={{ margin: '0.4rem 0' }}>{children}</p>
                        ),
                        strong: ({ children }) => (
                          <strong style={{ color: '#FFFFFF', fontWeight: 600 }}>{children}</strong>
                        ),
                        ul: ({ children }) => (
                          <ul style={{ margin: '0.3rem 0', paddingLeft: '1.25rem', listStyleType: 'disc' }}>{children}</ul>
                        ),
                        ol: ({ children }) => (
                          <ol style={{ margin: '0.3rem 0', paddingLeft: '1.25rem' }}>{children}</ol>
                        ),
                        li: ({ children }) => (
                          <li style={{ margin: '0.15rem 0' }}>{children}</li>
                        ),
                        hr: () => (
                          <hr style={{ border: 'none', borderTop: '1px solid #2A2A2A', margin: '0.75rem 0' }} />
                        ),
                        table: ({ children }) => (
                          <div style={{ overflowX: 'auto', margin: '0.5rem 0' }}>
                            <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '0.8rem' }}>{children}</table>
                          </div>
                        ),
                        th: ({ children }) => (
                          <th style={{ border: '1px solid #2A2A2A', padding: '0.4rem 0.6rem', background: '#111111', color: '#FFFFFF', fontWeight: 600, textAlign: 'left' }}>{children}</th>
                        ),
                        td: ({ children }) => (
                          <td style={{ border: '1px solid #2A2A2A', padding: '0.4rem 0.6rem' }}>{children}</td>
                        ),
                        code: ({ children, className }) => {
                          const isBlock = className?.includes('language-');
                          return isBlock ? (
                            <pre style={{ background: '#111111', border: '1px solid #1E1E1E', borderRadius: 4, padding: '0.6rem', overflowX: 'auto', margin: '0.5rem 0' }}>
                              <code style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '0.8rem' }}>{children}</code>
                            </pre>
                          ) : (
                            <code style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '0.8rem', background: '#1A1A1A', padding: '0.1rem 0.3rem', borderRadius: 3 }}>{children}</code>
                          );
                        },
                        a: ({ href, children }) => (
                          <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: '#00C805', textDecoration: 'none' }}>{children}</a>
                        ),
                      }}
                    >
                      {msg.content}
                    </ReactMarkdown>
                  ) : (
                    msg.content
                  )}
                </div>
              </div>
            ))}
            {/* Tool status indicator */}
            {toolStatus && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: '0.5rem',
                padding: '0.5rem 0.75rem', margin: '0.25rem 0',
                color: '#00C805', fontSize: '0.7rem',
                fontFamily: 'monospace',
              }}>
                <span style={{
                  display: 'inline-block', width: 8, height: 8,
                  borderRadius: '50%', background: '#00C805',
                  animation: 'pulse 1.5s ease-in-out infinite',
                }} />
                {toolStatus}
                <style>{`@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }`}</style>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

          {/* Credits Exceeded Banner */}
          {creditsExceeded && (
            <div style={{
              background: 'linear-gradient(90deg, rgba(255, 71, 87, 0.15) 0%, rgba(255, 71, 87, 0.08) 100%)',
              borderTop: '1px solid #FF4757',
              padding: '0.75rem 1rem',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: '0.5rem',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span style={{ fontSize: '1rem' }}>{'⚠️'}</span>
                <div>
                  <div style={{ fontSize: '0.8rem', fontWeight: 600, color: '#FF4757' }}>
                    100% demo credits used
                  </div>
                  <div style={{ fontSize: '0.7rem', color: '#9E9E9E' }}>
                    Buy YLDR to get more AI compute credits
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <a
                  href="https://yieldr.org"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    fontSize: '0.7rem', fontWeight: 600,
                    padding: '0.4rem 0.75rem',
                    background: '#00C805', border: 'none', borderRadius: 4,
                    color: '#000', cursor: 'pointer',
                    textDecoration: 'none',
                  }}
                >Get YLDR</a>
                <a
                  href="https://discord.gg/jhRvvWsc"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    fontSize: '0.7rem', fontWeight: 600,
                    padding: '0.4rem 0.75rem',
                    background: '#5865F2', border: 'none', borderRadius: 4,
                    color: '#FFFFFF', cursor: 'pointer',
                    textDecoration: 'none',
                  }}
                >Join Discord</a>
              </div>
            </div>
          )}

          {/* Chat Input */}
          <div style={{
            borderTop: '1px solid #1E1E1E',
            background: '#0A0A0A',
            padding: '0.75rem 1rem',
            flexShrink: 0,
            opacity: creditsExceeded ? 0.5 : 1,
            pointerEvents: creditsExceeded ? 'none' : 'auto',
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
                  cursor: creditsExceeded ? 'not-allowed' : 'pointer',
                }}>{prompt}</button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button
                onClick={() => { setShowHistory(!showHistory); loadChatSessions(); }}
                title="Chat History"
                style={{
                  width: 40, height: 40,
                  background: '#111111',
                  border: '1px solid #1E1E1E',
                  borderRadius: 6,
                  color: '#9E9E9E',
                  cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '1rem', flexShrink: 0,
                  pointerEvents: 'auto',
                }}
              >{'☰'}</button>
              <textarea
                value={inputValue}
                onChange={e => setInputValue(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !creditsExceeded) { e.preventDefault(); handleSend(); } }}
                placeholder={creditsExceeded ? "Credits exceeded - Get YLDR to continue" : "Ask about your positions, traders, or strategies..."}
                rows={1}
                disabled={creditsExceeded}
                style={{
                  flex: 1,
                  background: '#111111',
                  border: `1px solid ${creditsExceeded ? '#FF4757' : '#1E1E1E'}`,
                  borderRadius: 6,
                  padding: '0.6rem 0.75rem',
                  color: '#FFFFFF',
                  fontSize: '0.9rem',
                  fontFamily: "'Inter', sans-serif",
                  resize: 'none',
                  outline: 'none',
                }}
              />
              <button onClick={handleSend} disabled={isStreaming || creditsExceeded} style={{
                width: 40, height: 40,
                background: isStreaming || creditsExceeded ? '#0A0A0A' : '#111111',
                border: '1px solid #1E1E1E',
                borderRadius: 6,
                color: isStreaming || creditsExceeded ? '#333' : '#9E9E9E',
                cursor: isStreaming || creditsExceeded ? 'not-allowed' : 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '1rem',
              }}>{isStreaming ? '...' : '➤'}</button>
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
