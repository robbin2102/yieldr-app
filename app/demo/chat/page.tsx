'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useAccount, useDisconnect } from 'wagmi';
import { useRouter } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import s from './terminal.module.css';

// ─── Interfaces ───────────────────────────────────────────────────────────────

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

interface SignalPill {
  label: string;
  color: string; // g | y | r | b | p
}

interface MonitoringTaskUI {
  id: string;
  taskTitle: string;
  assetSymbol: string; // normalized, uppercase e.g. "ETH"
  status: 'active' | 'paused' | 'error';
  intervalSeconds: number;
  cycleCount: number;
  alertCount: number;
  nextRunAt: string | null;
  lastRunAt: string | null;
  signalPills: SignalPill[];
}

interface NewsLink {
  title: string;
  url: string;
  source: string;
  publishedAt: string;
  age?: string;
}

interface MonitoringAlertUI {
  id: string;
  taskId: string;
  title: string;
  message: string;
  severity: 'info' | 'warning' | 'critical';
  cycleNumber: number;
  read: boolean;
  assetSymbol: string;
  createdAt: string;
  newsLinks?: NewsLink[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Normalise a position pair to a bare symbol: "ETH-USD" → "ETH"
function normaliseSymbol(raw: string): string {
  return (raw || '')
    .toUpperCase()
    .replace(/[-/](USD[CT]?|PERP|USDT?)$/i, '')
    .replace(/[^A-Z0-9]/g, '');
}

const FREE_CREDITS_LIMIT = 500000;
const YLDR_PRICE = 9_000_000 / 210_000_000; // ~$0.04286

function formatCreditsDisplay(used: number) {
  const usedK = used >= 1000 ? `${(used / 1000).toFixed(1)}k` : used.toString();
  return usedK;
}

function formatPnl(v: number | undefined): string {
  if (v == null) return '—';
  const abs = Math.abs(v);
  const sign = v >= 0 ? '+' : '-';
  if (abs >= 1000) return `${sign}$${(abs / 1000).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

function formatPct(v: number | undefined): string {
  if (v == null) return '—';
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
}

function formatPrice(v: number | undefined): string {
  if (v == null) return '—';
  if (v >= 1000) return `$${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  if (v >= 1) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(4)}`;
}

function formatUsd(v: number | null | undefined): string {
  if (v == null) return '$0';
  if (v >= 1000) return `$${(v / 1000).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function formatCountdown(nextRunAt: string | null, cycleCount = 0): string {
  if (!nextRunAt) return '—';
  const diff = new Date(nextRunAt).getTime() - Date.now();
  if (diff <= 0) return cycleCount === 0 ? 'Pending...' : 'Running...';
  const totalS = Math.floor(diff / 1000);
  const m = Math.floor(totalS / 60);
  const sec = totalS % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

// Filter traders: pick best per platform with realistic win rates
function pickDisplayTraders(traders: FollowedTrader[]): FollowedTrader[] {
  const validWinRate = (t: FollowedTrader) => {
    const wr = t.winRate <= 1 ? t.winRate * 100 : t.winRate;
    return wr >= 70 && wr <= 95;
  };
  const byPnl = (a: FollowedTrader, b: FollowedTrader) => b.pnl30d - a.pnl30d;
  const hl = traders.filter(t => t.platform === 'hyperliquid' && validWinRate(t)).sort(byPnl);
  const av = traders.filter(t => t.platform === 'avantis' && validWinRate(t)).sort(byPnl);
  const pm = traders.filter(t => t.platform === 'polymarket' && validWinRate(t)).sort(byPnl);
  const hlPick = hl[0] || traders.filter(t => t.platform === 'hyperliquid').sort(byPnl)[0];
  const avPick = av[0] || traders.filter(t => t.platform === 'avantis').sort(byPnl)[0];
  const pmPick = pm[0] || traders.filter(t => t.platform === 'polymarket').sort(byPnl)[0];
  return [hlPick, avPick, pmPick].filter(Boolean);
}

// Activity ticker messages

// ─── Component ────────────────────────────────────────────────────────────────

export default function ChatPage() {
  const [mounted, setMounted] = useState(false);
  const router = useRouter();
  const { address, isConnected, isReconnecting } = useAccount();
  const { disconnect } = useDisconnect();

  // Auth
  const [authChecking, setAuthChecking] = useState(true);
  const [authenticatedWallet, setAuthenticatedWallet] = useState<string | null>(null);

  // Agent info
  const [agentName, setAgentName] = useState('Analyst');

  // UI state
  const [activeLeftTab, setActiveLeftTab] = useState<'positions' | 'alerts' | 'tokens'>('positions');
  const [expandedCards, setExpandedCards] = useState<Set<string>>(new Set());
  const [activeNavTab, setActiveNavTab] = useState<'terminal' | 'agents'>('terminal');
  const [showYldrModal, setShowYldrModal] = useState(false);
  const [yldrInput, setYldrInput] = useState(100);
  const [mobPanelHidden, setMobPanelHidden] = useState(false);

  // Credits
  const [creditsUsed, setCreditsUsed] = useState(0);
  const [creditsLoading, setCreditsLoading] = useState(true);
  const creditsExceeded = creditsUsed >= FREE_CREDITS_LIMIT;

  // Position data
  const [perpPositions, setPerpPositions] = useState<PerpPosition[]>([]);
  const [pmPositions, setPmPositions] = useState<PMPosition[]>([]);
  const [followedTraders, setFollowedTraders] = useState<FollowedTrader[]>([]);
  const [tokens, setTokens] = useState<TokenBalance[]>([]);
  const [tokensTotalUsd, setTokensTotalUsd] = useState(0);

  // Monitoring
  const [monitoringTasks, setMonitoringTasks] = useState<MonitoringTaskUI[]>([]);
  const [monitoringAlerts, setMonitoringAlerts] = useState<MonitoringAlertUI[]>([]);
  const [unreadAlerts, setUnreadAlerts] = useState(0);
  const [expandedAlerts, setExpandedAlerts] = useState<Set<string>>(new Set());

  // Ticker state

  // Chat
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [toolStatus, setToolStatus] = useState<string | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Sessions
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [chatSessions, setChatSessions] = useState<{ id: string; title: string; updatedAt: string }[]>([]);
  const [totalMessages, setTotalMessages] = useState(0);
  const [hasEarlierMessages, setHasEarlierMessages] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);

  const initialAnalysisTriggered = useRef(false);
  const isPrepending = useRef(false);
  const chatStreamRef = useRef<HTMLDivElement>(null);
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const SESSION_PAGE_SIZE = 20;

  // ── Mount
  useEffect(() => { setMounted(true); }, []);

  // ── Auth check
  useEffect(() => {
    if (!mounted) return;
    const storedWallet = localStorage.getItem('yieldr_auth_wallet');
    const agentCreated = localStorage.getItem('agentCreated');
    if (storedWallet) {
      setAuthenticatedWallet(storedWallet.toLowerCase());
    } else if (agentCreated) {
      try {
        const d = JSON.parse(agentCreated);
        if (d.wallet) {
          localStorage.setItem('yieldr_auth_wallet', d.wallet.toLowerCase());
          setAuthenticatedWallet(d.wallet.toLowerCase());
        }
      } catch {}
    }
    const t = setTimeout(() => setAuthChecking(false), 1500);
    return () => clearTimeout(t);
  }, [mounted]);

  useEffect(() => {
    if (!mounted || authChecking) return;
    if (isConnected && address) {
      localStorage.setItem('yieldr_auth_wallet', address.toLowerCase());
      setAuthenticatedWallet(address.toLowerCase());
    }
    if (!isConnected && !isReconnecting && !authenticatedWallet) {
      router.push('/demo');
    }
  }, [mounted, authChecking, isConnected, isReconnecting, address, authenticatedWallet, router]);

  // ── Agent name
  useEffect(() => {
    if (!mounted) return;
    const d = localStorage.getItem('agentCreated');
    if (d) {
      try { const p = JSON.parse(d); if (p.name) setAgentName(p.name); } catch {}
    }
  }, [mounted]);

  const effectiveWallet = address || authenticatedWallet;
  const shortWallet = effectiveWallet
    ? `${effectiveWallet.slice(0, 6)}...${effectiveWallet.slice(-4)}`
    : '';

  // ── Credits
  const fetchCredits = useCallback(async (wallet: string) => {
    try {
      const res = await fetch(`/api/usage/${wallet}`);
      if (res.ok) {
        const data = await res.json();
        if (data.success && data.data) {
          const total = (data.data.lifetime?.totalInputTokens || 0) + (data.data.lifetime?.totalOutputTokens || 0);
          setCreditsUsed(total);
        }
      }
    } catch {}
    finally { setCreditsLoading(false); }
  }, []);

  useEffect(() => {
    if (mounted && effectiveWallet) fetchCredits(effectiveWallet);
  }, [mounted, effectiveWallet, fetchCredits]);

  // ── Positions + agent data
  useEffect(() => {
    if (!mounted || !effectiveWallet) return;

    fetch(`/api/positions?address=${effectiveWallet}`)
      .then(r => r.json())
      .then(d => { if (d.success && d.data) setPerpPositions(d.data.perpPositions || []); })
      .catch(() => {});

    fetch(`/api/polymarket-positions?address=${effectiveWallet}`)
      .then(r => r.json())
      .then(d => {
        if (d.success && d.data) {
          setPmPositions((d.data.positions || []).map((p: any) => ({
            market: p.title, outcome: p.outcome, size: p.size,
            avgPrice: p.avgPrice, currentPrice: p.currentPrice,
            currentValue: p.currentValue, pnl: p.pnl, pnlPercent: p.pnlPercent,
          })));
        }
      })
      .catch(() => {});

    fetch(`/api/demo/agents?wallet=${effectiveWallet}`)
      .then(r => r.json())
      .then(d => {
        if (d.success && d.agent) {
          setFollowedTraders(d.agent.followedTraders || []);
          if (d.agent.name) setAgentName(d.agent.name);
          setTokens(d.agent.cachedTokenBalances || []);
          setTokensTotalUsd(d.agent.cachedTokensTotalUsd || 0);
        }
      })
      .catch(() => {});
  }, [mounted, effectiveWallet]);

  // ── Monitoring polling (10s)
  const fetchMonitoring = useCallback(async (wallet: string) => {
    try {
      const res = await fetch(`/api/demo/monitoring-tasks?wallet=${wallet}`);
      if (res.ok) {
        const d = await res.json();
        setMonitoringTasks(d.tasks || []);
      }
    } catch {}
  }, []);

  const fetchAlerts = useCallback(async (wallet: string) => {
    try {
      const res = await fetch(`/api/demo/alerts?wallet=${wallet}`);
      if (res.ok) {
        const d = await res.json();
        setMonitoringAlerts(d.alerts || []);
        setUnreadAlerts(d.unreadCount || 0);
      }
    } catch {}
  }, []);

  useEffect(() => {
    if (!mounted || !effectiveWallet) return;
    fetchMonitoring(effectiveWallet);
    fetchAlerts(effectiveWallet);
    const iv = setInterval(() => {
      fetchMonitoring(effectiveWallet);
      fetchAlerts(effectiveWallet);
    }, 30000);
    return () => clearInterval(iv);
  }, [mounted, effectiveWallet, fetchMonitoring, fetchAlerts]);

  // ── Ticker rotation
  const activeTasks = monitoringTasks.filter(t => t.status === 'active');
  const pendingTasks = monitoringTasks.filter(t => t.cycleCount === 0);
  const hasTasks = monitoringTasks.length > 0;
  const hasActiveTasks = activeTasks.length > 0;


  // ── Get signal pills for a position
  const getPillsForPosition = useCallback((pair: string): SignalPill[] => {
    const sym = normaliseSymbol(pair);
    const pills: SignalPill[] = [];
    const seen = new Set<string>();
    for (const task of monitoringTasks) {
      if (normaliseSymbol(task.assetSymbol) === sym) {
        for (const pill of task.signalPills) {
          if (!seen.has(pill.label)) {
            seen.add(pill.label);
            pills.push(pill);
          }
        }
      }
    }
    return pills;
  }, [monitoringTasks]);

  // ── Get last alert for a position (for expanded card)
  const getLastAlertForPosition = useCallback((pair: string): MonitoringAlertUI | null => {
    const sym = normaliseSymbol(pair);
    // Find taskIds that match this position
    const matchingTaskIds = new Set(
      monitoringTasks
        .filter(t => normaliseSymbol(t.assetSymbol) === sym)
        .map(t => t.id)
    );
    const match = monitoringAlerts.find(a => matchingTaskIds.has(a.taskId));
    return match || null;
  }, [monitoringTasks, monitoringAlerts]);

  // ── Has unread alert for position
  const hasUnreadAlertForPosition = useCallback((pair: string): 'warn' | 'crit' | null => {
    const sym = normaliseSymbol(pair);
    const matchingTaskIds = new Set(
      monitoringTasks
        .filter(t => normaliseSymbol(t.assetSymbol) === sym)
        .map(t => t.id)
    );
    const unread = monitoringAlerts.find(a => matchingTaskIds.has(a.taskId) && !a.read);
    if (!unread) return null;
    return unread.severity === 'critical' ? 'crit' : 'warn';
  }, [monitoringTasks, monitoringAlerts]);

  // ── Per-task countdowns for Alerts tab
  const [taskCountdowns, setTaskCountdowns] = useState<Record<string, { str: string; pct: number }>>({});

  useEffect(() => {
    const compute = () => {
      const now = Date.now();
      const next: Record<string, { str: string; pct: number }> = {};
      for (const task of activeTasks) {
        const totalMs = task.intervalSeconds * 1000;
        const nextMs = task.nextRunAt ? new Date(task.nextRunAt).getTime() : now;
        const diff = Math.max(0, nextMs - now);
        const elapsed = totalMs - diff;
        next[task.id] = {
          str: formatCountdown(task.nextRunAt, task.cycleCount),
          pct: Math.min(100, Math.max(0, (elapsed / totalMs) * 100)),
        };
      }
      setTaskCountdowns(next);
    };
    compute();
    const iv = setInterval(compute, 1000);
    return () => clearInterval(iv);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTasks.map(t => t.id + t.nextRunAt + t.cycleCount).join(',')]);

  // ── Chat sessions — refresh list only (called after sends, not on startup)
  const loadChatSessions = useCallback(async () => {
    if (!effectiveWallet) return;
    try {
      const res = await fetch(`/api/demo/chat-sessions?wallet=${effectiveWallet}`);
      const d = await res.json();
      if (d.success) {
        setChatSessions(d.sessions.map((s: any) => ({ id: s.id, title: s.title, updatedAt: s.updatedAt })));
      }
    } catch {}
  }, [effectiveWallet]);

  const loadSession = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/demo/chat-sessions/${id}?limit=${SESSION_PAGE_SIZE}`);
      const d = await res.json();
      if (d.success && d.session) {
        setSessionId(id);
        setTotalMessages(d.session.totalMessages ?? d.session.messages.length);
        setHasEarlierMessages(d.session.hasMore ?? false);
        setMessages(d.session.messages.map((m: any, i: number) => ({
          id: `${id}-${i}`,
          role: m.role,
          content: m.content,
          time: new Date(m.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
        })));
        return true;
      }
    } catch {}
    return false;
  }, [SESSION_PAGE_SIZE]);

  const loadEarlierMessages = useCallback(async () => {
    if (!sessionId || !hasEarlierMessages || loadingEarlier) return;
    setLoadingEarlier(true);
    const container = chatStreamRef.current;
    const prevScrollHeight = container?.scrollHeight ?? 0;
    try {
      const alreadyLoaded = messages.length;
      const skip = Math.max(0, totalMessages - alreadyLoaded - SESSION_PAGE_SIZE);
      const res = await fetch(`/api/demo/chat-sessions/${sessionId}?limit=${SESSION_PAGE_SIZE}&skip=${skip}`);
      const d = await res.json();
      if (d.success && d.session) {
        const earlier = d.session.messages.map((m: any, i: number) => ({
          id: `${sessionId}-earlier-${skip}-${i}`,
          role: m.role,
          content: m.content,
          time: new Date(m.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
        }));
        isPrepending.current = true;
        setMessages(prev => [...earlier, ...prev]);
        setHasEarlierMessages(d.session.hasMore ?? skip > 0);
        requestAnimationFrame(() => {
          if (container) container.scrollTop = container.scrollHeight - prevScrollHeight;
          isPrepending.current = false;
        });
      }
    } catch {}
    setLoadingEarlier(false);
  }, [sessionId, hasEarlierMessages, loadingEarlier, messages.length, totalMessages, SESSION_PAGE_SIZE]);

  const startNewChat = useCallback(() => {
    setSessionId(null);
    setMessages([]);
    setTotalMessages(0);
    setHasEarlierMessages(false);
    initialAnalysisTriggered.current = false;
  }, []);

  // ── Single startup effect: restore last session OR run initial analysis (never both)
  // Sequential — no race condition possible between session check and initial analysis.
  useEffect(() => {
    if (!mounted || !effectiveWallet || initialAnalysisTriggered.current) return;
    initialAnalysisTriggered.current = true; // lock immediately before any await

    (async () => {
      // Step 1: Try to restore most recent session
      try {
        const res = await fetch(`/api/demo/chat-sessions?wallet=${effectiveWallet}`);
        const d = await res.json();
        if (d.success && d.sessions?.length > 0) {
          setChatSessions(d.sessions.map((s: any) => ({ id: s.id, title: s.title, updatedAt: s.updatedAt })));
          const restored = await loadSession(d.sessions[0].id);
          if (restored) return; // session loaded — skip initial analysis entirely
        }
      } catch {}

      // Step 2: No sessions found (new user) — run initial analysis
      const now = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
      const agentMsgId = 'initial-analysis';
      setMessages([{ id: agentMsgId, role: 'agent', content: '', time: now }]);
      setIsStreaming(true);

      try {
        const res = await fetch('/api/demo/chat/initial-analysis', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ wallet: effectiveWallet }),
        });

        if (!res.ok) {
          setMessages([{ id: agentMsgId, role: 'agent', content: `Welcome! I'm ${agentName}, your AI trading analyst. I'm ready to analyse markets, track positions, and build monitoring tasks.\n\nAsk me anything.`, time: now }]);
          setIsStreaming(false);
          return;
        }

        const contentType = res.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          const data = await res.json();
          setMessages([{ id: agentMsgId, role: 'agent', content: data.content || `Welcome! I'm ${agentName}.`, time: now }]);
          setIsStreaming(false);
          return;
        }

        if (!res.body) { setIsStreaming(false); return; }
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
                setMessages(prev => prev.map(m => m.id === agentMsgId ? { ...m, content: m.content + parsed.text } : m));
              } else if (parsed.type === 'session') {
                setSessionId(parsed.sessionId);
                loadChatSessions();
              }
            } catch {}
          }
        }
      } catch {
        setMessages([{ id: agentMsgId, role: 'agent', content: `Welcome! I'm ${agentName}, your AI trading analyst. Ask me about your positions or set up monitoring.`, time: now }]);
      }
      setIsStreaming(false);
      if (effectiveWallet) fetchCredits(effectiveWallet);
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted, effectiveWallet]); // minimal deps — intentionally excludes agentName/loadChatSessions to prevent re-fires

  // ── Auto-scroll (skip when prepending earlier messages to preserve position)
  useEffect(() => {
    if (isPrepending.current) return;
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, toolStatus]);
  useEffect(() => {
    if (!isStreaming) return;
    const iv = setInterval(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, 300);
    return () => clearInterval(iv);
  }, [isStreaming]);

  // ── Scroll-to-top sentinel: auto-load earlier messages when user scrolls up
  useEffect(() => {
    const sentinel = topSentinelRef.current;
    const container = chatStreamRef.current;
    if (!sentinel || !container || !hasEarlierMessages) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !loadingEarlier) loadEarlierMessages();
      },
      { root: container, threshold: 0.1 }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasEarlierMessages, loadEarlierMessages, loadingEarlier]);

  // ── Send message
  const handleSend = useCallback(async () => {
    const text = inputValue.trim();
    if (!text || isStreaming || creditsExceeded || !effectiveWallet) return;
    setInputValue('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';

    const now = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    const userMsg: ChatMessage = { id: Date.now().toString(), role: 'user', content: text, time: now };
    const agentMsgId = (Date.now() + 1).toString();

    setMessages(prev => [...prev, userMsg, { id: agentMsgId, role: 'agent', content: '', time: now }]);
    setIsStreaming(true);

    const apiMessages = [...messages, userMsg]
      .filter(m => m.content.trim())
      .map(m => ({ role: m.role, content: m.content }));

    try {
      const res = await fetch('/api/demo/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: apiMessages, wallet: effectiveWallet, sessionId }),
      });

      if (!res.ok || !res.body) {
        const errData = await res.json().catch(() => ({ error: 'Unknown error' }));
        setMessages(prev => prev.map(m => m.id === agentMsgId ? { ...m, content: `Error: ${errData.error || 'Failed to get response'}` } : m));
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
              setToolStatus(null);
              setMessages(prev => prev.map(m => m.id === agentMsgId ? { ...m, content: m.content + parsed.text } : m));
            } else if (parsed.type === 'tool_status') {
              setToolStatus(parsed.status);
            } else if (parsed.type === 'session') {
              setSessionId(parsed.sessionId);
              loadChatSessions();
            } else if (parsed.type === 'monitor_created') {
              // Monitor was just created — refresh the monitors list immediately
              if (effectiveWallet) fetchMonitoring(effectiveWallet);
            } else if (parsed.type === 'error') {
              setMessages(prev => prev.map(m => m.id === agentMsgId ? { ...m, content: m.content || `Error: ${parsed.error}` } : m));
            }
          } catch {}
        }
      }
    } catch (err: any) {
      setMessages(prev => prev.map(m => m.id === agentMsgId ? { ...m, content: `Connection error: ${err.message}` } : m));
    }

    setIsStreaming(false);
    setToolStatus(null);
    if (effectiveWallet) fetchCredits(effectiveWallet);
    // Re-poll monitoring after each message (a task may have been created)
    if (effectiveWallet) {
      setTimeout(() => {
        fetchMonitoring(effectiveWallet);
        fetchAlerts(effectiveWallet);
      }, 2000);
    }
  }, [inputValue, isStreaming, creditsExceeded, messages, effectiveWallet, sessionId, loadChatSessions, fetchCredits, fetchMonitoring, fetchAlerts]);

  // ── Logout
  const handleLogout = useCallback(() => {
    localStorage.removeItem('yieldr_auth_wallet');
    localStorage.removeItem('agentCreated');
    localStorage.removeItem('agentSetup');
    disconnect();
    router.push('/demo');
  }, [disconnect, router]);

  // ── Toggle card expansion
  const toggleCard = (key: string) => {
    setExpandedCards(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };

  // ── Switch left tab + mark-as-read when switching to alerts
  const switchLeftTab = async (tab: 'positions' | 'alerts' | 'tokens') => {
    setActiveLeftTab(tab);
    if (tab === 'alerts' && unreadAlerts > 0 && effectiveWallet) {
      setUnreadAlerts(0);
      try {
        await fetch(`/api/demo/alerts?wallet=${effectiveWallet}`, { method: 'PATCH' });
        setMonitoringAlerts(prev => prev.map(a => ({ ...a, read: true })));
      } catch {}
    }
  };

  const agentInitials = agentName.slice(0, 2).toUpperCase();
  const displayTraders = pickDisplayTraders(followedTraders);
  const yldrTokens = Math.floor(yldrInput / YLDR_PRICE);
  const creditsFormatted = formatCreditsDisplay(creditsUsed);
  const monitoringCount = perpPositions.length + pmPositions.length;

  // ── Loading screen
  if (!mounted) return null;
  if (authChecking || isReconnecting) {
    return (
      <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#000' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ width: 40, height: 40, margin: '0 auto 12px', border: '2px solid #1A1A1A', borderTop: '2px solid #00C805', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
          <div style={{ color: '#4A4A4A', fontSize: '0.7rem', fontFamily: 'monospace' }}>Reconnecting wallet...</div>
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      </div>
    );
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className={s.root}>
      {/* ═══ TOP NAV ═══ */}
      <nav className={s.topnav}>
        <span className={s.logo}>YIELDR</span>
        <div className={s.navTabs}>
          <button
            className={`${s.navTab} ${activeNavTab === 'terminal' ? s.active : ''}`}
            onClick={() => setActiveNavTab('terminal')}
          >Terminal</button>
          <button
            className={s.navTab}
            onClick={() => router.push('/agents')}
          >Agents</button>
          <button className={`${s.navTab} ${s.disabled}`} title="Coming soon">Traders</button>
          <button className={`${s.navTab} ${s.disabled}`} title="Coming soon">Funds</button>
        </div>
        <div className={s.topnavRight}>
          <div className={s.tokenDisplay} onClick={() => setShowYldrModal(true)} title="AI credits used">
            <span className={s.tokenIcon}>⚡</span>
            <span className={s.tokenVal}>{creditsFormatted}</span>
            <span className={s.tokenSep}>/</span>
            <span className={s.tokenMax}>500k</span>
          </div>
          <button className={s.getYldr} onClick={() => setShowYldrModal(true)}>+ Get YLDR</button>
          <div className={s.walletPill} onClick={handleLogout} title="Click to disconnect" style={{ cursor: 'pointer' }}>
            {shortWallet}
          </div>
          <button className={s.mobToggle} onClick={() => setMobPanelHidden(p => !p)}>☰</button>
        </div>
      </nav>

      {/* ═══ APP BODY ═══ */}
      <div className={s.appBody}>

        {/* ═══ LEFT PANEL ═══ */}
        <div className={`${s.leftPanel} ${mobPanelHidden ? s.mobHidden : ''}`}>
          <div className={s.panelHeader}>
            <span className={`${s.liveDot} ${hasActiveTasks ? '' : s.idle}`}></span>
            <span className={s.panelTitle}>Agent Monitoring</span>
          </div>

          {/* ── Activity ticker ── */}
          <div className={s.activityTicker}>
            <div className={`${s.atDot} ${!hasTasks ? 'idle' : pendingTasks.length > 0 && activeTasks.length === 0 ? 'processing' : hasActiveTasks ? 'scanning' : 'idle'}`}></div>
            <span className={`${s.atText} ${!hasActiveTasks ? s.idleMode : ''}`}>
              {!hasTasks
                ? 'Idle — no monitors configured'
                : pendingTasks.length > 0 && activeTasks.length === 0
                ? `Initializing — ${pendingTasks.length} monitor${pendingTasks.length > 1 ? 's' : ''} pending first scan`
                : hasActiveTasks
                ? `Scanning ${activeTasks.map(t => t.assetSymbol).filter(Boolean).join(', ') || 'markets'} — ${activeTasks.length} monitor${activeTasks.length > 1 ? 's' : ''} active`
                : 'Paused — all monitors inactive'}
            </span>
            {hasActiveTasks && (
              <span className={s.atCycle}>
                ↻ {activeTasks.reduce((sum, t) => sum + t.cycleCount, 0)} cycles
              </span>
            )}
          </div>

          <div className={s.lpanelTabs}>
            <button
              className={`${s.lpanelTab} ${activeLeftTab === 'positions' ? s.active : ''}`}
              onClick={() => switchLeftTab('positions')}
            >Positions</button>
            <button
              className={`${s.lpanelTab} ${activeLeftTab === 'alerts' ? s.active : ''}`}
              onClick={() => switchLeftTab('alerts')}
            >
              Monitors
              {unreadAlerts > 0 && <span className={s.tabBadge}>{unreadAlerts > 9 ? '9+' : unreadAlerts}</span>}
            </button>
            <button
              className={`${s.lpanelTab} ${activeLeftTab === 'tokens' ? s.active : ''}`}
              onClick={() => switchLeftTab('tokens')}
            >Tokens</button>
          </div>


          <div className={s.lpanelScroll}>

            {/* ══ POSITIONS TAB ══ */}
            {activeLeftTab === 'positions' && (
              <>
                {/* Perpetuals */}
                <div className={s.sectionDivider}>
                  <span className={`${s.sdDot} ${s.perp}`}></span>
                  Perpetuals
                  <span className={s.sdCount}>{perpPositions.length} open</span>
                </div>

                {perpPositions.length === 0 ? (
                  <div className={s.emptyState}>
                    <div className={s.emptyIcon}>📊</div>
                    <div className={s.emptyTitle}>No perpetual positions found</div>
                    <div className={s.emptyText}>
                      Connect a wallet with open Hyperliquid or Avantis positions to see them here.
                    </div>
                  </div>
                ) : (
                  perpPositions.map((pos, i) => {
                    const key = `perp-${i}`;
                    const isExpanded = expandedCards.has(key);
                    const pair = pos.pair || '—';
                    const symbol = normaliseSymbol(pair);
                    const pills = getPillsForPosition(pair);
                    const alertDotType = hasUnreadAlertForPosition(pair);
                    const lastAlert = getLastAlertForPosition(pair);
                    const isLong = (pos.direction || '').toUpperCase().includes('LONG');
                    const pnlPos = (pos.pnl || 0) >= 0;

                    return (
                      <div key={key} className={s.posCard} id={`card-${symbol}`}>
                        <div className={s.posHeader} onClick={() => toggleCard(key)}>
                          <div className={s.posAssetWrap}>
                            <span className={s.posAsset}>{symbol}</span>
                            <span className={`${s.posTag} ${isLong ? s.long : s.short}`}>
                              {isLong ? 'LONG' : 'SHORT'}{pos.leverage ? ` ${pos.leverage}×` : ''}
                            </span>
                            <span className={s.posVenue}>{pos.platform || '—'}</span>
                            {alertDotType && (
                              <span className={`${s.posAlertDot} ${s.visible} ${s[alertDotType]}`}></span>
                            )}
                          </div>
                          <div className={s.posPnlWrap}>
                            <div className={`${s.posPnl} ${pnlPos ? s.g : s.r}`}>{formatPnl(pos.pnl)}</div>
                            <div className={`${s.posPnlSub} ${pnlPos ? s.g : s.r}`}>{formatPct(pos.roi)}</div>
                          </div>
                          <span className={`${s.chevron} ${isExpanded ? s.open : ''}`}>▾</span>
                        </div>

                        {pills.length > 0 && (
                          <div className={s.pillsRow}>
                            {pills.map((p, pi) => (
                              <span key={pi} className={`${s.sigPill} ${s[p.color] ?? ''}`}>{p.label}</span>
                            ))}
                          </div>
                        )}

                        <div className={`${s.posStats} ${s.perpStats}`}>
                          <div className={s.psItem}>
                            <div className={s.psLbl}>Entry</div>
                            <div className={s.psVal}>{formatPrice(pos.entryPrice)}</div>
                          </div>
                          <div className={s.psItem}>
                            <div className={s.psLbl}>Mark</div>
                            <div className={s.psVal}>{formatPrice(pos.currentPrice)}</div>
                          </div>
                          <div className={s.psItem}>
                            <div className={s.psLbl}>Size</div>
                            <div className={s.psVal}>{formatUsd(pos.positionSize || pos.margin)}</div>
                          </div>
                          <div className={s.psItem}>
                            <div className={s.psLbl}>Margin</div>
                            <div className={s.psVal}>{formatUsd(pos.margin)}</div>
                          </div>
                        </div>

                        {/* Expanded signal detail */}
                        <div className={`${s.signalBlock} ${isExpanded ? s.open : ''}`}>
                          {lastAlert ? (
                            <div className={s.signalItem}>
                              <span className={`${s.sigDot} ${lastAlert.severity === 'critical' ? s.r : lastAlert.severity === 'warning' ? s.y : s.g}`}></span>
                              <div className={s.sigBody}>
                                <div className={s.sigTop}>
                                  <span className={s.sigName}>{lastAlert.title}</span>
                                </div>
                                <div className={s.sigNote}>{lastAlert.message}</div>
                              </div>
                              <span className={s.sigTime}>{timeAgo(lastAlert.createdAt)}</span>
                            </div>
                          ) : pills.length > 0 ? (
                            <div className={s.signalItem}>
                              <span className={`${s.sigDot} ${s.b}`}></span>
                              <div className={s.sigBody}>
                                <div className={s.sigTop}><span className={s.sigName}>Monitoring active</span></div>
                                <div className={s.sigNote}>First scan pending — agent will alert you when signals trigger.</div>
                              </div>
                            </div>
                          ) : (
                            <div className={s.signalItem}>
                              <span className={`${s.sigDot} ${s.n}`}></span>
                              <div className={s.sigBody}>
                                <div className={s.sigTop}><span className={s.sigName}>No monitoring set up</span></div>
                                <div className={s.sigNote}>Ask the analyst to monitor signals for {symbol} — e.g. funding rate, OI, or RSI.</div>
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}

                {/* Predictions */}
                <div className={s.sectionDivider}>
                  <span className={`${s.sdDot} ${s.poly}`}></span>
                  Predictions
                  <span className={s.sdCount}>{pmPositions.length} open</span>
                </div>

                {pmPositions.length === 0 ? (
                  <div className={s.emptyState}>
                    <div className={s.emptyIcon}>🎯</div>
                    <div className={s.emptyTitle}>No prediction market positions</div>
                    <div className={s.emptyText}>
                      Connect a wallet with open Polymarket positions to see them here.
                    </div>
                  </div>
                ) : (
                  pmPositions.map((pos, i) => {
                    const key = `pm-${i}`;
                    const isExpanded = expandedCards.has(key);
                    const market = pos.market || 'Unknown Market';
                    const symbol = market.slice(0, 20);
                    const isYes = (pos.outcome || '').toUpperCase() === 'YES';
                    const pnlPos = (pos.pnl || 0) >= 0;
                    const pills = getPillsForPosition(market);
                    const alertDotType = hasUnreadAlertForPosition(market);
                    const lastAlert = getLastAlertForPosition(market);
                    const yesOdds = pos.currentPrice ? Math.round(pos.currentPrice * 100) : 50;

                    return (
                      <div key={key} className={`${s.posCard} ${s.polyCard}`}>
                        <div className={s.posHeader} onClick={() => toggleCard(key)}>
                          <div className={s.posAssetWrap}>
                            <span className={s.polyVenueDot}></span>
                            <span className={`${s.posAsset} ${s.poly}`}>{symbol}</span>
                            <span className={`${s.posTag} ${isYes ? s.yes : s.no}`}>{pos.outcome || '—'}</span>
                            {alertDotType && (
                              <span className={`${s.posAlertDot} ${s.visible} ${s[alertDotType]}`}></span>
                            )}
                          </div>
                          <div className={s.posPnlWrap}>
                            <div className={`${s.posPnl} ${pnlPos ? s.g : s.r}`}>{formatPnl(pos.pnl)}</div>
                            <div className={`${s.posPnlSub} ${s.n}`}>{pos.size ? `${pos.size.toFixed(0)} shares` : '—'}</div>
                          </div>
                          <span className={`${s.chevron} ${isExpanded ? s.open : ''}`}>▾</span>
                        </div>

                        <div className={s.polyQuestion}>{market}</div>

                        <div className={s.polyOddsRow}>
                          <div className={s.polyOddsBarWrap}>
                            <div className={s.polyOddsBarYes} style={{ width: `${yesOdds}%` }}></div>
                            <div className={s.polyOddsBarNo} style={{ width: `${100 - yesOdds}%` }}></div>
                          </div>
                          <div className={s.polyOddsLabels}>
                            <span className={s.polyYesLbl}>YES {yesOdds}¢</span>
                            <span className={s.polyNoLbl}>NO {100 - yesOdds}¢</span>
                          </div>
                        </div>

                        {pills.length > 0 && (
                          <div className={s.pillsRow}>
                            {pills.map((p, pi) => (
                              <span key={pi} className={`${s.sigPill} ${s[p.color] ?? ''}`}>{p.label}</span>
                            ))}
                          </div>
                        )}

                        <div className={`${s.posStats} ${s.polyStats}`}>
                          <div className={s.psItem}>
                            <div className={s.psLbl}>Avg Entry</div>
                            <div className={s.psVal}>{pos.avgPrice ? `${Math.round(pos.avgPrice * 100)}¢` : '—'}</div>
                          </div>
                          <div className={s.psItem}>
                            <div className={s.psLbl}>Current</div>
                            <div className={`${s.psVal} ${pnlPos ? s.g : s.r}`}>
                              {pos.currentPrice ? `${Math.round(pos.currentPrice * 100)}¢` : '—'}
                            </div>
                          </div>
                          <div className={s.psItem}>
                            <div className={s.psLbl}>Value</div>
                            <div className={s.psVal}>{formatUsd(pos.currentValue)}</div>
                          </div>
                        </div>

                        <div className={`${s.signalBlock} ${isExpanded ? s.open : ''}`}>
                          {lastAlert ? (
                            <div className={s.signalItem}>
                              <span className={`${s.sigDot} ${lastAlert.severity === 'critical' ? s.r : lastAlert.severity === 'warning' ? s.y : s.g}`}></span>
                              <div className={s.sigBody}>
                                <div className={s.sigTop}><span className={s.sigName}>{lastAlert.title}</span></div>
                                <div className={s.sigNote}>{lastAlert.message}</div>
                              </div>
                              <span className={s.sigTime}>{timeAgo(lastAlert.createdAt)}</span>
                            </div>
                          ) : pills.length > 0 ? (
                            <div className={s.signalItem}>
                              <span className={`${s.sigDot} ${s.b}`}></span>
                              <div className={s.sigBody}>
                                <div className={s.sigTop}><span className={s.sigName}>Monitoring active</span></div>
                                <div className={s.sigNote}>First scan pending — agent will alert you when signals trigger.</div>
                              </div>
                            </div>
                          ) : (
                            <div className={s.signalItem}>
                              <span className={`${s.sigDot} ${s.n}`}></span>
                              <div className={s.sigBody}>
                                <div className={s.sigTop}><span className={s.sigName}>No monitoring set up</span></div>
                                <div className={s.sigNote}>Ask the analyst to monitor this market — odds drift, volume spikes, or whale activity.</div>
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </>
            )}

            {/* ══ ALERTS TAB ══ */}
            {activeLeftTab === 'alerts' && (
              <>
                {/* Per-task monitor countdown strips */}
                {activeTasks.length === 0 ? (
                  <div className={s.emptyState}>
                    <div className={s.emptyTitle}>No monitors running</div>
                    <div className={s.emptyText}>
                      Ask your agent to set up a monitor for alpha detection. For example:
                    </div>
                    <div className={s.monitorExamples}>
                      <div className={s.monitorExample}>
                        <span className={s.monitorExampleTag}>Perps</span>
                        "Monitor ETH funding rate and alert me when it flips negative with open interest diverging"
                      </div>
                      <div className={s.monitorExample}>
                        <span className={s.monitorExampleTag}>Predictions</span>
                        "Watch the Trump election market and alert if odds move more than 5% in under an hour"
                      </div>
                    </div>
                  </div>
                ) : (
                  activeTasks.map(task => {
                    const cd = taskCountdowns[task.id] || { str: '—', pct: 0 };
                    const mins = Math.round(task.intervalSeconds / 60);
                    const intervalLabel = mins >= 60 ? `${Math.round(mins / 60)}h` : `${mins}m`;
                    const isOverdue = cd.str === 'Pending...' || cd.str === 'Running...';
                    return (
                      <div key={task.id} className={s.monitorItem}>
                        <span className={`${s.monitorStatusDot} ${s[task.status]}`}></span>
                        <span className={s.monitorTitle}>{task.taskTitle}</span>
                        <span className={s.monitorRight}>
                          <span className={s.monitorMeta}>{intervalLabel}</span>
                          <span className={s.monitorSep}>·</span>
                          <span className={s.monitorMeta}>C{task.cycleCount}</span>
                          <span className={s.monitorSep}>·</span>
                          <span className={`${s.monitorTimer} ${isOverdue ? s.overdue : ''}`}>{cd.str}</span>
                        </span>
                      </div>
                    );
                  })
                )}

                {/* Alerts list */}
                {monitoringAlerts.length === 0 ? (
                  <div className={s.emptyState}>
                    <div className={s.emptyIcon}>🔔</div>
                    <div className={s.emptyTitle}>No alerts yet</div>
                    <div className={s.emptyText}>
                      {!hasTasks
                        ? 'Set up monitoring to start receiving alerts on your positions.'
                        : activeTasks.some(t => t.cycleCount > 0)
                          ? 'Monitoring active — alerts fire when signal conditions are met.'
                          : 'First scan pending — alerts appear here once the scanner runs.'}
                    </div>
                  </div>
                ) : (
                  <>
                    <div className={s.alertsSectionDivider}>Signals &amp; Alerts</div>
                    {monitoringAlerts.map(alert => {
                      const isExpanded = expandedAlerts.has(alert.id);
                      return (
                        <div
                          key={alert.id}
                          className={`${s.alertItem} ${alert.severity === 'critical' ? s.crit : alert.severity === 'warning' ? s.warn : s.info}`}
                          onClick={() => setExpandedAlerts(prev => {
                            const next = new Set(prev);
                            if (next.has(alert.id)) next.delete(alert.id); else next.add(alert.id);
                            return next;
                          })}
                        >
                          <div className={s.alertTop}>
                            <span className={s.alertSeverityLabel}>
                              {alert.severity === 'critical' ? 'Alert' : alert.severity === 'warning' ? 'Watch' : 'Signal'}
                            </span>
                            {alert.assetSymbol && <span className={s.alertAsset}>{alert.assetSymbol}</span>}
                            <span className={s.alertTitle}>{alert.title}</span>
                            <span className={s.alertTime}>{timeAgo(alert.createdAt)}</span>
                          </div>
                          <div className={isExpanded ? s.alertBodyExpanded : s.alertBody}>{alert.message}</div>
                          {isExpanded && alert.newsLinks && alert.newsLinks.length > 0 && (
                            <div className={s.alertNewsLinks} onClick={e => e.stopPropagation()}>
                              <div className={s.alertNewsLinksLabel}>Related News</div>
                              {alert.newsLinks.map((link, i) => (
                                <a
                                  key={i}
                                  href={link.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className={s.alertNewsLink}
                                >
                                  <span className={s.alertNewsLinkTitle}>{link.title}</span>
                                  <span className={s.alertNewsLinkMeta}>
                                    {link.source}
                                    {link.age ? ` · ${link.age}` : link.publishedAt ? ` · ${timeAgo(link.publishedAt)}` : ''}
                                  </span>
                                </a>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </>
                )}
              </>
            )}

            {/* ══ TOKENS TAB ══ */}
            {activeLeftTab === 'tokens' && (
              <>
                <div className={s.sectionDivider}>
                  <span className={`${s.sdDot} ${s.perp}`}></span>
                  Wallet Holdings
                  <span className={s.sdCount}>Scanned on connect</span>
                </div>

                {tokens.length === 0 ? (
                  <div className={s.emptyState}>
                    <div className={s.emptyIcon}>💼</div>
                    <div className={s.emptyTitle}>No tokens found</div>
                    <div className={s.emptyText}>Token balances are scanned when you first connect your wallet.</div>
                  </div>
                ) : (
                  tokens.map((tok, i) => {
                    const chgPct = tok.usdPrice && tok.usdValue && tok.balance
                      ? null // no 24h change data in cached tokens
                      : null;
                    return (
                      <div key={i} className={s.tokenRow}>
                        <div className={s.tokIcon}>
                          {tok.logo
                            ? <img src={tok.logo} alt={tok.symbol} style={{ width: 28, height: 28, borderRadius: '50%' }} />
                            : tok.symbol.slice(0, 2)
                          }
                        </div>
                        <div className={s.tokInfo}>
                          <div className={s.tokName}>{tok.name || tok.symbol}</div>
                          <div className={s.tokBal}>{tok.balance.toLocaleString('en-US', { maximumFractionDigits: 4 })} {tok.symbol}</div>
                        </div>
                        <div className={s.tokRight}>
                          <div className={s.tokUsd}>{formatUsd(tok.usdValue)}</div>
                        </div>
                      </div>
                    );
                  })
                )}

                {tokensTotalUsd > 0 && (
                  <div className={s.tokTotal}>
                    <span className={s.tokTotalLbl}>Total Portfolio</span>
                    <span className={s.tokTotalVal}>{formatUsd(tokensTotalUsd)}</span>
                  </div>
                )}
              </>
            )}

          </div>{/* /lpanelScroll */}

          {/* ══ AGENT FOLLOWING ══ */}
          <div className={s.followingWrap}>
            <div className={s.followingHdr}>
              <span className={s.fhLabel}>
                <span className={`${s.liveDot} ${s.sm}`}></span>
                Agent Following
              </span>
              <span className={s.fhCount}>{displayTraders.length}</span>
            </div>
            <div className={s.followingList}>
              {displayTraders.length === 0 ? (
                <div style={{ padding: '10px 12px' }}>
                  <div className={s.emptyTitle} style={{ fontSize: '0.6rem' }}>No traders followed yet</div>
                </div>
              ) : (
                displayTraders.map((trader, i) => {
                  const initials = (trader.username || trader.wallet || '').slice(0, 2).toUpperCase() || '??';
                  const pnlStr = trader.pnl30d >= 1000000
                    ? `+$${(trader.pnl30d / 1000000).toFixed(1)}M`
                    : trader.pnl30d >= 1000
                    ? `+$${(trader.pnl30d / 1000).toFixed(1)}K`
                    : `+$${trader.pnl30d.toFixed(0)}`;
                  const winRate = trader.winRate <= 1 ? (trader.winRate * 100).toFixed(0) : trader.winRate.toFixed(0);
                  const platform = trader.platform === 'hyperliquid' ? 'Hyperliquid' : trader.platform === 'avantis' ? 'Avantis' : 'Polymarket';

                  return (
                    <div key={i} className={s.fc}>
                      <div className={s.fcAv}>{initials}</div>
                      <div className={s.fcInfo}>
                        {trader.username
                          ? <div className={s.fcId}>{trader.username}</div>
                          : <div className={s.fcId}>{`${trader.wallet.slice(0, 6)}...${trader.wallet.slice(-2)}`}</div>
                        }
                        <div className={s.fcMeta}>{platform} · <span className="win">{winRate}% win</span></div>
                      </div>
                      <div className={s.fcPnl}>{pnlStr}</div>
                    </div>
                  );
                })
              )}
            </div>
            <button className={s.followMoreBtn}>+ Follow more traders</button>
          </div>
        </div>{/* /leftPanel */}

        {/* ═══ RIGHT PANEL — CHAT ═══ */}
        <div className={s.rightPanel}>
          {/* Chat header */}
          <div className={s.chatHdr} style={{ position: 'relative' }}>
            <div className={s.chatAgentIc}>{agentInitials}</div>
            <div>
              <div className={s.chatAgentNm}>{agentName}</div>
            </div>
            <div className={s.chatAgentSt}>
              <span className={`${s.liveDot} ${s.sm}`}></span>
              {hasActiveTasks
                ? `Monitoring ${activeTasks.length} task${activeTasks.length !== 1 ? 's' : ''}`
                : `${perpPositions.length + pmPositions.length} position${perpPositions.length + pmPositions.length !== 1 ? 's' : ''} loaded`
              }
            </div>
          </div>

          {/* Chat stream */}
          <div className={s.chatStream} ref={chatStreamRef}>
            {/* Top sentinel — IntersectionObserver triggers earlier-message loading when scrolled into view */}
            <div ref={topSentinelRef} style={{ height: 1 }} />
            {loadingEarlier && (
              <div style={{ textAlign: 'center', padding: '6px 0', fontSize: '0.58rem', color: '#4A4A4A', letterSpacing: '0.04em' }}>
                Loading earlier messages...
              </div>
            )}
            {messages.map((msg, i) => {
              const isAgent = msg.role === 'agent';
              const isEmpty = !msg.content.trim();
              const isLastAgent = isAgent && i === messages.length - 1;

              return (
                <div key={msg.id} className={s.msg}>
                  <div className={s.msgHdr}>
                    <div className={`${s.msgAv} ${isAgent ? s.agent : s.user}`}>
                      {isAgent ? agentInitials : (shortWallet.slice(0, 2).toUpperCase() || 'U')}
                    </div>
                    <span className={s.msgSender}>{isAgent ? agentName : 'You'}</span>
                    <span className={s.msgTime}>{msg.time}</span>
                  </div>

                  {isAgent && isEmpty && isStreaming ? (
                    <div className={s.typing}>
                      <div className={s.typingDot}></div>
                      <div className={s.typingDot}></div>
                      <div className={s.typingDot}></div>
                    </div>
                  ) : (
                    <div className={s.msgBody}>
                      {isAgent ? (
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                      ) : (
                        <p>{msg.content}</p>
                      )}
                    </div>
                  )}

                  {/* Tool status shown under the streaming agent message */}
                  {isAgent && isLastAgent && isStreaming && toolStatus && (
                    <div className={s.toolStatusBubble}>
                      <div className={s.toolStatusInner}>
                        <div className={s.toolSpinner}></div>
                        {toolStatus}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            <div ref={chatEndRef} />
          </div>

          {/* Credits exceeded banner */}
          {creditsExceeded && (
            <div className={s.creditsExceededBanner}>
              Free credits used — <button onClick={() => setShowYldrModal(true)} style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', textDecoration: 'underline' }}>get YLDR tokens</button> to continue
            </div>
          )}

          {/* Chat input */}
          <div className={s.chatInputWrap}>
            <div className={s.chatInputRow}>
              <textarea
                ref={textareaRef}
                className={s.chatTa}
                value={inputValue}
                onChange={e => {
                  setInputValue(e.target.value);
                  e.target.style.height = 'auto';
                  e.target.style.height = Math.min(e.target.scrollHeight, 140) + 'px';
                }}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
                placeholder={creditsExceeded ? 'Credits exhausted — get YLDR to continue' : "Ask your analyst... e.g. 'monitor ETH funding rate every hour'"}
                rows={2}
                disabled={creditsExceeded}
              />
              <button
                className={s.chatSendBtn}
                onClick={handleSend}
                disabled={isStreaming || creditsExceeded}
              >↑</button>
            </div>
          </div>
        </div>{/* /rightPanel */}
      </div>{/* /appBody */}

      {/* ═══ YLDR MODAL ═══ */}
      {showYldrModal && (
        <div className={s.modalOverlay} onClick={e => { if (e.target === e.currentTarget) setShowYldrModal(false); }}>
          <div className={s.modal}>
            <div className={s.modalHdr}>
              <div>
                <div className={s.modalTitle}>Get YLDR Tokens</div>
                <div className={s.modalSub}>YLDR provides AI credits and powers your agent's training.</div>
              </div>
              <button className={s.modalClose} onClick={() => setShowYldrModal(false)}>✕</button>
            </div>
            <div className={s.modalBody}>
              <div className={s.tierBlock}>
                <div className={s.tierRow1}>
                  <span className={s.tierLabel}>Tier 1</span>
                  <span className={s.tierName}>Early Access</span>
                  <span className={s.tierFdv}>$9M FDV</span>
                </div>
                <div className={s.fillBarWrap}>
                  <div className={s.fillBarTrack}><div className={s.fillBarFill}></div></div>
                  <div className={s.fillBarLabels}>
                    <span className="used">35% filled</span>
                    <span className="rem">650K YLDR left at this price</span>
                  </div>
                </div>
                <div className={s.tierNext}>Next tier <strong>$14M FDV (+56%)</strong> — buy now to lock in current price</div>
              </div>

              <div className={s.amountBlock}>
                <div className={s.amountLabel}>Amount</div>
                <div className={s.amountInputWrap}>
                  <input
                    className={s.amountInput}
                    type="number"
                    value={yldrInput}
                    min={1}
                    onChange={e => setYldrInput(parseFloat(e.target.value) || 0)}
                  />
                  <span className={s.amountCurrency}>USDC</span>
                </div>
              </div>

              <div className={s.receiveRow}>
                <div>
                  <div className={s.receiveLbl}>You Receive</div>
                  <div className={s.receiveVal}>{yldrTokens.toLocaleString()} YLDR</div>
                </div>
                <div>
                  <div className={s.receiveSubLbl}>YLDR Price</div>
                  <div className={s.receiveSubVal}>$0.043 / YLDR</div>
                </div>
              </div>

              <div className={s.whyBlock}>
                <div className={s.whyTitle}>Why Buy Now</div>
                {[
                  'AI chat credits for trading insights & analysis',
                  'Train agent to unlock personalized signals',
                  'Deflationary 🔥 — YLDR is burned on every AI action. Fixed supply of 210M.',
                  'Early access to Trading Agents',
                ].map((item, i) => (
                  <div key={i} className={s.whyItem}><span className={s.whyCheck}>✓</span><span>{item}</span></div>
                ))}
              </div>

              <div className={s.roiBlock}>
                <div className={s.roiTitle}>ROI Scenarios at TGE ({yldrInput > 0 ? `$${yldrInput.toLocaleString()} USDC` : '—'})</div>
                <div className={s.roiScenarios}>
                  {[
                    { fdv: '$150M', multiple: 150 / 9 },
                    { fdv: '$300M', multiple: 300 / 9 },
                    { fdv: '$500M', multiple: 500 / 9 },
                  ].map(({ fdv, multiple }) => {
                    const roi = yldrInput > 0 ? yldrInput * multiple : 0;
                    return (
                      <div key={fdv} className={s.roiScenario}>
                        <div className={s.roiFdv}>{fdv} FDV</div>
                        <div className={s.roiValue}>{yldrInput > 0 ? `$${Math.round(roi).toLocaleString()}` : '—'}</div>
                        <div className={s.roiMultiple}>{multiple.toFixed(1)}×</div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className={s.modalDisclaimer}>
                Only users can mint. No team/VC allocation until listing. Max Supply: 210,000,000 YLDR. Tokens distributed at TGE.{' '}
                <a href="https://docs.yieldr.app" target="_blank" rel="noopener noreferrer">Read docs</a> to learn more about product &amp; tokenomics.
              </div>
              <button className={s.modalCta} disabled>Buy YLDR</button>
              <div className={s.modalTrustLinks}>
                Treasury: <a href="https://basescan.org/address/0xB56Ca15" target="_blank" rel="noopener noreferrer">0xB56C...a15C</a> multisig |{' '}
                <a href="https://basescan.org/address/0xB56Ca15" target="_blank" rel="noopener noreferrer">View on Basescan</a>
              </div>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
