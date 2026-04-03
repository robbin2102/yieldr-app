'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { AD_VARIANTS, AdVariant } from '@/lib/agent-test/ads';

type ModelKey = 'claude' | 'openai' | 'grok';

interface Message {
  role: 'user' | 'agent' | 'error';
  content: string;
  responseTimeMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  model?: string;
}

interface SessionMeta {
  _id: string;
  session_id: string;
  test_label: string;
  created_at: string;
  status: string;
  state: { exchange_count: number; outcome?: string; vault_interest?: string };
}

const MODEL_CONFIG: Record<ModelKey, {
  label: string;
  emoji: string;
  color: string;
  bg: string;
  border: string;
  bubble: string;
  headerBg: string;
}> = {
  claude: {
    label: 'Claude Sonnet 4.6',
    emoji: '🟣',
    color: '#a09be8',
    bg: 'bg-[#13111f]',
    border: 'border-[#7F77DD]/40',
    bubble: 'bg-[#7F77DD]/15 text-[#c4c0f0]',
    headerBg: 'bg-[#7F77DD]/10',
  },
  openai: {
    label: 'GPT-4.5 Mini',
    emoji: '🟢',
    color: '#5DCAA5',
    bg: 'bg-[#0d1a15]',
    border: 'border-[#5DCAA5]/40',
    bubble: 'bg-[#5DCAA5]/15 text-[#9de8cc]',
    headerBg: 'bg-[#5DCAA5]/10',
  },
  grok: {
    label: 'Grok 4.1 Fast',
    emoji: '🟠',
    color: '#EF9F27',
    bg: 'bg-[#1a1200]',
    border: 'border-[#EF9F27]/40',
    bubble: 'bg-[#EF9F27]/15 text-[#f5c97a]',
    headerBg: 'bg-[#EF9F27]/10',
  },
};

const MODELS: ModelKey[] = ['claude', 'openai', 'grok'];

function MetaBadge({ ms, input, output }: { ms?: number; input?: number; output?: number }) {
  if (!ms) return null;
  return (
    <div className="flex gap-1 mt-1.5 flex-wrap">
      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-white/8 text-white/40 font-mono">
        ⚡ {ms}ms
      </span>
      {input != null && (
        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-white/8 text-white/40 font-mono">
          🔢 {input > 999 ? `${(input / 1000).toFixed(1)}k` : input}→{output}
        </span>
      )}
    </div>
  );
}

function ChatColumn({
  modelKey,
  messages,
  streaming,
}: {
  modelKey: ModelKey;
  messages: Message[];
  streaming: string;
}) {
  const cfg = MODEL_CONFIG[modelKey];
  const bottomRef = useRef<HTMLDivElement>(null);
  const isStreaming = !!streaming;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streaming]);

  return (
    <div className={`flex flex-col flex-1 min-w-0 rounded-xl border ${cfg.border} ${cfg.bg} overflow-hidden shadow-lg`}>
      {/* Column header */}
      <div className={`px-4 py-2.5 flex items-center justify-between ${cfg.headerBg} border-b border-white/5`}>
        <div className="flex items-center gap-2">
          <span className="text-base">{cfg.emoji}</span>
          <span className="text-xs font-semibold tracking-wide" style={{ color: cfg.color }}>
            {cfg.label}
          </span>
        </div>
        {isStreaming && (
          <span className="text-[10px] text-white/30 animate-pulse">● writing</span>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2.5" style={{ maxHeight: 'calc(100vh - 230px)' }}>
        {messages.length === 0 && !streaming && (
          <div className="flex flex-col items-center justify-center h-32 gap-2">
            <span className="text-2xl opacity-20">💬</span>
            <p className="text-white/20 text-xs">Waiting to respond…</p>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            {msg.role === 'error' ? (
              <div className="w-full rounded-lg px-3 py-2 bg-red-500/10 border border-red-500/20 text-red-400 text-xs font-mono">
                ⚠️ {msg.content}
              </div>
            ) : (
              <div
                className={`max-w-[92%] rounded-2xl px-3 py-2 text-sm leading-relaxed ${
                  msg.role === 'user'
                    ? 'bg-white/10 text-white/75 rounded-br-sm'
                    : `${cfg.bubble} rounded-bl-sm font-mono text-xs`
                }`}
              >
                <span className="whitespace-pre-wrap">{msg.content}</span>
                {msg.role === 'agent' && (
                  <MetaBadge ms={msg.responseTimeMs} input={msg.inputTokens} output={msg.outputTokens} />
                )}
              </div>
            )}
          </div>
        ))}

        {streaming && (
          <div className="flex justify-start">
            <div className={`max-w-[92%] rounded-2xl rounded-bl-sm px-3 py-2 text-xs font-mono ${cfg.bubble}`}>
              <span className="whitespace-pre-wrap">{streaming}</span>
              <span className="animate-pulse opacity-60">▌</span>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

export default function AgentTestPage() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [testLabel, setTestLabel] = useState('');
  const [status, setStatus] = useState<'active' | 'completed' | 'abandoned'>('active');
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [showSessionPicker, setShowSessionPicker] = useState(false);
  const [exchangeCount, setExchangeCount] = useState(0);
  const [selectedAd, setSelectedAd] = useState<AdVariant>(AD_VARIANTS[0]);
  const [openingFired, setOpeningFired] = useState(false);

  const [messages, setMessages] = useState<Record<ModelKey, Message[]>>({
    claude: [], openai: [], grok: [],
  });
  const [streaming, setStreaming] = useState<Record<ModelKey, string>>({
    claude: '', openai: '', grok: '',
  });

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const searchParams = useSearchParams();

  const fetchSessions = useCallback(async () => {
    const res = await fetch('/api/agent-test/sessions');
    const data = await res.json();
    setSessions(data);
  }, []);

  useEffect(() => { fetchSessions(); }, [fetchSessions]);

  const loadSession = useCallback(async (sid: string) => {
    const res = await fetch(`/api/agent-test/sessions/${sid}`);
    const session = await res.json();
    setSessionId(session.session_id);
    setTestLabel(session.test_label || '');
    setStatus(session.status);
    setExchangeCount(session.state?.exchange_count || 0);
    setOpeningFired(session.exchanges?.length > 0);

    const newMessages: Record<ModelKey, Message[]> = { claude: [], openai: [], grok: [] };
    for (const ex of session.exchanges || []) {
      const isOpening = ex.user_message?.startsWith('[OPENING:');
      MODELS.forEach((m) => {
        if (!isOpening) newMessages[m].push({ role: 'user', content: ex.user_message });
        const resp = ex.responses?.[m];
        if (resp) {
          newMessages[m].push({
            role: 'agent',
            content: resp.content,
            responseTimeMs: resp.response_time_ms,
            inputTokens: resp.input_tokens,
            outputTokens: resp.output_tokens,
            model: resp.model,
          });
        }
      });
    }

    setMessages(newMessages);
    setStreaming({ claude: '', openai: '', grok: '' });
    setShowSessionPicker(false);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const sid = searchParams.get('session');
    if (sid) loadSession(sid);
  }, [searchParams, loadSession]);

  const handleNewSession = () => {
    setSessionId(null);
    setTestLabel('');
    setStatus('active');
    setExchangeCount(0);
    setOpeningFired(false);
    setMessages({ claude: [], openai: [], grok: [] });
    setStreaming({ claude: '', openai: '', grok: '' });
    inputRef.current?.focus();
  };

  const consumeStream = async (body: ReadableStream<Uint8Array>, isOpening = false) => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const liveStreams: Record<ModelKey, string> = { claude: '', openai: '', grok: '' };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const event = JSON.parse(line.slice(6));

          if (event.type === 'session' && !sessionId) setSessionId(event.session_id);

          if (event.type === 'chunk' && event.model && event.chunk) {
            const m = event.model as ModelKey;
            liveStreams[m] += event.chunk;
            setStreaming((prev) => ({ ...prev, [m]: liveStreams[m] }));
          }

          if (event.type === 'done' && event.model) {
            const m = event.model as ModelKey;
            setStreaming((prev) => ({ ...prev, [m]: '' }));
            setMessages((prev) => ({
              ...prev,
              [m]: [...prev[m], {
                role: 'agent',
                content: event.content,
                responseTimeMs: event.response_time_ms,
                inputTokens: event.input_tokens,
                outputTokens: event.output_tokens,
                model: event.model,
              }],
            }));
          }

          if (event.type === 'error' && event.model) {
            const m = event.model as ModelKey;
            setStreaming((prev) => ({ ...prev, [m]: '' }));
            setMessages((prev) => ({
              ...prev,
              [m]: [...prev[m], { role: 'error', content: event.error }],
            }));
          }

          if (event.type === 'complete') setExchangeCount((c) => c + 1);
        } catch { /* skip malformed SSE */ }
      }
    }
  };

  const handleFireOpening = async () => {
    if (loading || openingFired) return;
    setLoading(true);
    setOpeningFired(true);
    setStreaming({ claude: '', openai: '', grok: '' });
    try {
      const res = await fetch('/api/agent-test/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: sessionId,
          message: '',
          test_label: testLabel || selectedAd.id,
          is_opening: true,
          ad_variant_id: selectedAd.id,
        }),
      });
      if (!res.ok || !res.body) throw new Error('Request failed');
      await consumeStream(res.body, true);
    } catch (err) {
      console.error('Opening error:', err);
      setOpeningFired(false);
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  };

  const handleSend = async () => {
    const msg = input.trim();
    if (!msg || loading) return;
    setInput('');
    setLoading(true);
    setStreaming({ claude: '', openai: '', grok: '' });

    setMessages((prev) => {
      const next = { ...prev };
      MODELS.forEach((m) => { next[m] = [...prev[m], { role: 'user', content: msg }]; });
      return next;
    });

    try {
      const res = await fetch('/api/agent-test/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId, message: msg, test_label: testLabel }),
      });
      if (!res.ok || !res.body) throw new Error('Request failed');
      await consumeStream(res.body);
    } catch (err) {
      console.error('Chat error:', err);
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  };

  const handleComplete = async () => {
    if (!sessionId) return;
    await fetch(`/api/agent-test/sessions/${sessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'completed' }),
    });
    setStatus('completed');
    fetchSessions();
  };

  const handleLabelBlur = async () => {
    if (!sessionId || !testLabel) return;
    await fetch(`/api/agent-test/sessions/${sessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ test_label: testLabel }),
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const statusConfig: Record<string, { emoji: string; cls: string }> = {
    active:    { emoji: '🟢', cls: 'text-green-400' },
    completed: { emoji: '✅', cls: 'text-blue-400' },
    abandoned: { emoji: '🔴', cls: 'text-red-400' },
  };

  return (
    <div className="min-h-screen bg-[#0a0a0d] text-white flex flex-col" style={{ fontFamily: 'Inter, sans-serif' }}>

      {/* ── Top header ── */}
      <header className="border-b border-white/8 px-4 py-2.5 flex items-center gap-3 flex-shrink-0 bg-[#0d0d10]">
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className="text-lg">🤖</span>
          <h1 className="text-sm font-bold text-white/90 whitespace-nowrap">Yieldr Agent</h1>
          <span className="text-[10px] text-white/30 hidden sm:block">Model Comparison</span>
        </div>

        <div className="flex items-center gap-2 flex-1 min-w-0">
          {/* Session picker */}
          <div className="relative">
            <button
              onClick={() => { fetchSessions(); setShowSessionPicker((v) => !v); }}
              className="text-[11px] bg-white/5 hover:bg-white/8 border border-white/10 rounded-lg px-2.5 py-1.5 text-white/60 transition-colors whitespace-nowrap"
            >
              📂 {sessionId ? sessionId.slice(0, 8) + '…' : 'Load'}
            </button>
            {showSessionPicker && (
              <div className="absolute top-full mt-1 left-0 z-50 bg-[#16161c] border border-white/10 rounded-xl shadow-2xl w-72 max-h-60 overflow-y-auto">
                {sessions.length === 0 ? (
                  <p className="p-3 text-xs text-white/30 text-center">No sessions yet</p>
                ) : sessions.map((s) => (
                  <button key={s.session_id} onClick={() => loadSession(s.session_id)}
                    className="w-full text-left px-3 py-2.5 hover:bg-white/5 border-b border-white/5 last:border-0 transition-colors">
                    <div className="text-[11px] font-medium text-white/80 truncate">
                      {s.test_label || '—'} <span className="text-white/30">{s.session_id.slice(0, 8)}</span>
                    </div>
                    <div className="text-[10px] text-white/30 mt-0.5">
                      {s.state?.exchange_count ?? 0} exchanges · {s.status} · {new Date(s.created_at).toLocaleDateString()}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          <button onClick={handleNewSession}
            className="text-[11px] bg-white/5 hover:bg-white/8 border border-white/10 rounded-lg px-2.5 py-1.5 text-white/60 transition-colors whitespace-nowrap">
            ✨ New
          </button>

          <input type="text" placeholder="📝 Label this test…" value={testLabel}
            onChange={(e) => setTestLabel(e.target.value)} onBlur={handleLabelBlur}
            className="flex-1 text-[11px] bg-white/5 border border-white/10 rounded-lg px-2.5 py-1.5 text-white/70 placeholder-white/20 focus:outline-none focus:border-white/20 min-w-0" />

          <span className={`text-[11px] font-medium ${statusConfig[status]?.cls}`}>
            {statusConfig[status]?.emoji} {status}
          </span>
          <span className="text-[10px] text-white/25 whitespace-nowrap hidden sm:block">
            💬 {exchangeCount}
          </span>
        </div>

        <Link href="/agent-test/history"
          className="text-[11px] text-white/30 hover:text-white/60 transition-colors whitespace-nowrap flex-shrink-0">
          📊 History
        </Link>
      </header>

      {/* ── Ad variant bar ── */}
      <div className="border-b border-white/5 px-4 py-2 flex items-center gap-2.5 bg-[#0c0c0f] flex-shrink-0 flex-wrap">
        <span className="text-[10px] text-white/25 uppercase tracking-widest whitespace-nowrap">📢 Ad</span>
        {AD_VARIANTS.map((v) => (
          <button key={v.id} onClick={() => { setSelectedAd(v); setOpeningFired(false); }}
            className={`text-[10px] px-2.5 py-1 rounded-full border transition-colors ${
              selectedAd.id === v.id
                ? 'border-[#7F77DD]/60 bg-[#7F77DD]/15 text-[#a09be8]'
                : 'border-white/8 text-white/35 hover:text-white/55'
            }`}>
            {v.name}
          </button>
        ))}
        <span className="text-[10px] text-white/20 italic truncate flex-1 hidden lg:block">
          "{selectedAd.copy}"
        </span>
        <button onClick={handleFireOpening} disabled={loading || openingFired}
          className={`text-[11px] px-3 py-1.5 rounded-lg border font-medium transition-all whitespace-nowrap ${
            openingFired
              ? 'border-white/8 text-white/20 cursor-not-allowed'
              : 'border-[#7F77DD]/50 text-[#a09be8] hover:bg-[#7F77DD]/10 hover:border-[#7F77DD]/70'
          }`}>
          {loading && !openingFired ? '⏳ …' : openingFired ? '✅ Agent opened' : '🚀 Fire opening'}
        </button>
      </div>

      {/* ── 3 columns ── */}
      <div className="flex gap-2 flex-1 p-2.5 overflow-hidden min-h-0">
        {MODELS.map((m) => (
          <ChatColumn key={m} modelKey={m} messages={messages[m]} streaming={streaming[m]} />
        ))}
      </div>

      {/* ── Input bar ── */}
      <div className="border-t border-white/8 px-3 py-2.5 flex gap-2 items-end flex-shrink-0 bg-[#0d0d10]">
        <textarea ref={inputRef} value={input} onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown} disabled={loading} rows={2} placeholder="💬 Type a message… (Enter to send, Shift+Enter for newline)"
          className="flex-1 bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white/85 placeholder-white/20 focus:outline-none focus:border-white/20 resize-none disabled:opacity-40 transition-colors" />
        <div className="flex flex-col gap-1.5">
          <button onClick={handleSend} disabled={loading || !input.trim()}
            className="px-4 py-2 text-sm font-semibold rounded-xl bg-[#7F77DD] hover:bg-[#6f67cd] text-white transition-all disabled:opacity-30 disabled:cursor-not-allowed whitespace-nowrap shadow-lg shadow-[#7F77DD]/20">
            {loading ? '⏳' : '⚡ Send'}
          </button>
          <button onClick={handleComplete} disabled={!sessionId || status === 'completed'}
            className="px-4 py-1.5 text-[11px] font-medium rounded-xl bg-white/5 hover:bg-white/8 border border-white/10 text-white/50 transition-colors disabled:opacity-20 disabled:cursor-not-allowed whitespace-nowrap">
            ✅ Done
          </button>
        </div>
      </div>
    </div>
  );
}
