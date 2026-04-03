'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { AD_VARIANTS, AdVariant } from '@/lib/agent-test/ads';

type ModelKey = 'claude' | 'openai' | 'grok';

interface Message {
  role: 'user' | 'agent';
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

const MODEL_CONFIG: Record<ModelKey, { label: string; color: string; bg: string; border: string }> = {
  claude: { label: 'Claude Sonnet 4.6', color: '#7F77DD', bg: 'bg-[#1a1830]', border: 'border-[#7F77DD]' },
  openai: { label: 'GPT-4.5 Mini', color: '#5DCAA5', bg: 'bg-[#0f1f1a]', border: 'border-[#5DCAA5]' },
  grok: { label: 'Grok 4.1 Fast', color: '#EF9F27', bg: 'bg-[#1f1700]', border: 'border-[#EF9F27]' },
};

const MODELS: ModelKey[] = ['claude', 'openai', 'grok'];

function TokenBadge({ ms, input, output }: { ms?: number; input?: number; output?: number }) {
  if (!ms) return null;
  return (
    <div className="flex gap-1 mt-1 font-mono text-[10px]">
      <span className="px-1 rounded bg-white/10 text-white/50">{ms}ms</span>
      {input != null && (
        <span className="px-1 rounded bg-white/10 text-white/40">
          in:{input > 999 ? `${(input / 1000).toFixed(1)}K` : input} out:{output}
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

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streaming]);

  return (
    <div className={`flex flex-col flex-1 min-w-0 rounded-lg border ${cfg.border} border-opacity-30 ${cfg.bg} overflow-hidden`}>
      {/* Column header */}
      <div
        className="px-3 py-2 flex items-center gap-2 border-b border-white/10"
        style={{ borderBottomColor: `${cfg.color}22` }}
      >
        <div className="w-2 h-2 rounded-full" style={{ backgroundColor: cfg.color }} />
        <span className="text-xs font-semibold tracking-wide" style={{ color: cfg.color }}>
          {cfg.label}
        </span>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3 min-h-0" style={{ maxHeight: 'calc(100vh - 200px)' }}>
        {messages.length === 0 && (
          <p className="text-white/20 text-xs text-center mt-8">Waiting for first message…</p>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[90%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${
                msg.role === 'user'
                  ? 'bg-white/10 text-white/80'
                  : 'bg-white/5 text-white/90 font-mono'
              }`}
            >
              {msg.content}
              {msg.role === 'agent' && (
                <TokenBadge ms={msg.responseTimeMs} input={msg.inputTokens} output={msg.outputTokens} />
              )}
            </div>
          </div>
        ))}

        {/* Live streaming text */}
        {streaming && (
          <div className="flex justify-start">
            <div className="max-w-[90%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap bg-white/5 text-white/90 font-mono">
              {streaming}
              <span className="animate-pulse text-white/40">▌</span>
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
    claude: [],
    openai: [],
    grok: [],
  });
  const [streaming, setStreaming] = useState<Record<ModelKey, string>>({
    claude: '',
    openai: '',
    grok: '',
  });

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const searchParams = useSearchParams();

  const fetchSessions = useCallback(async () => {
    const res = await fetch('/api/agent-test/sessions');
    const data = await res.json();
    setSessions(data);
  }, []);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  const loadSession = useCallback(async (sid: string) => {
    const res = await fetch(`/api/agent-test/sessions/${sid}`);
    const session = await res.json();
    setSessionId(session.session_id);
    setTestLabel(session.test_label || '');
    setStatus(session.status);
    setExchangeCount(session.state?.exchange_count || 0);

    const newMessages: Record<ModelKey, Message[]> = { claude: [], openai: [], grok: [] };

    for (const ex of session.exchanges || []) {
      // User message — same for all columns
      MODELS.forEach((m) => {
        newMessages[m].push({ role: 'user', content: ex.user_message });
      });
      // Agent responses per model
      MODELS.forEach((m) => {
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

  // Load session from URL param (e.g. coming from /history)
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

  // Fire the agent opening message (agent speaks first, no user bubble shown)
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
      await consumeStream(res.body);
    } catch (err) {
      console.error('Opening error:', err);
      setOpeningFired(false);
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  };

  // Shared stream reader used by both handleFireOpening and handleSend
  const consumeStream = async (body: ReadableStream<Uint8Array>) => {
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

          if (event.type === 'session' && !sessionId) {
            setSessionId(event.session_id);
          }

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
              [m]: [
                ...prev[m],
                {
                  role: 'agent',
                  content: event.content,
                  responseTimeMs: event.response_time_ms,
                  inputTokens: event.input_tokens,
                  outputTokens: event.output_tokens,
                  model: event.model,
                },
              ],
            }));
          }

          if (event.type === 'complete') {
            setExchangeCount((c) => c + 1);
          }
        } catch {
          // skip malformed SSE line
        }
      }
    }
  };

  const handleSend = async () => {
    const msg = input.trim();
    if (!msg || loading) return;

    setInput('');
    setLoading(true);
    setStreaming({ claude: '', openai: '', grok: '' });

    // Add user message to all columns
    setMessages((prev) => {
      const next = { ...prev };
      MODELS.forEach((m) => {
        next[m] = [...prev[m], { role: 'user', content: msg }];
      });
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
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const statusColors: Record<string, string> = {
    active: 'bg-green-500/20 text-green-400',
    completed: 'bg-blue-500/20 text-blue-400',
    abandoned: 'bg-red-500/20 text-red-400',
  };

  return (
    <div className="min-h-screen bg-[#0d0d0f] text-white flex flex-col" style={{ fontFamily: 'Inter, sans-serif' }}>
      {/* Header */}
      <header className="border-b border-white/10 px-4 py-3 flex items-center justify-between gap-4 flex-shrink-0">
        <h1 className="text-sm font-semibold text-white/80 whitespace-nowrap">
          Yieldr Sales Agent — Model Comparison
        </h1>

        <div className="flex items-center gap-2 flex-1 max-w-2xl">
          {/* Session picker */}
          <div className="relative">
            <button
              onClick={() => { fetchSessions(); setShowSessionPicker((v) => !v); }}
              className="text-xs bg-white/5 hover:bg-white/10 border border-white/10 rounded px-3 py-1.5 text-white/70 transition-colors whitespace-nowrap"
            >
              {sessionId ? `Session: ${sessionId.slice(0, 8)}…` : 'Load session'}
            </button>
            {showSessionPicker && (
              <div className="absolute top-full mt-1 left-0 z-50 bg-[#1a1a1f] border border-white/10 rounded-lg shadow-xl w-80 max-h-64 overflow-y-auto">
                {sessions.length === 0 ? (
                  <p className="p-3 text-xs text-white/40">No sessions yet</p>
                ) : (
                  sessions.map((s) => (
                    <button
                      key={s.session_id}
                      onClick={() => loadSession(s.session_id)}
                      className="w-full text-left px-3 py-2 hover:bg-white/5 border-b border-white/5 last:border-0"
                    >
                      <div className="text-xs font-medium text-white/80 truncate">
                        {s.test_label || 'Untitled'} — {s.session_id.slice(0, 8)}
                      </div>
                      <div className="text-[10px] text-white/40 mt-0.5">
                        {s.state?.exchange_count ?? 0} exchanges · {s.status} ·{' '}
                        {new Date(s.created_at).toLocaleDateString()}
                      </div>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>

          <button
            onClick={handleNewSession}
            className="text-xs bg-white/5 hover:bg-white/10 border border-white/10 rounded px-3 py-1.5 text-white/70 transition-colors whitespace-nowrap"
          >
            + New
          </button>

          <input
            type="text"
            placeholder="Test label (e.g. happy_path_1)"
            value={testLabel}
            onChange={(e) => setTestLabel(e.target.value)}
            onBlur={handleLabelBlur}
            className="flex-1 text-xs bg-white/5 border border-white/10 rounded px-3 py-1.5 text-white/70 placeholder-white/25 focus:outline-none focus:border-white/20 min-w-0"
          />

          <span className={`text-[10px] px-2 py-1 rounded font-medium ${statusColors[status]}`}>
            {status}
          </span>

          <span className="text-[10px] text-white/30 whitespace-nowrap">
            {exchangeCount} exchange{exchangeCount !== 1 ? 's' : ''}
          </span>
        </div>

        <Link
          href="/agent-test/history"
          className="text-xs text-white/40 hover:text-white/70 transition-colors whitespace-nowrap"
        >
          History →
        </Link>
      </header>

      {/* Ad variant bar */}
      <div className="border-b border-white/5 px-4 py-2 flex items-center gap-3 bg-[#0f0f12] flex-shrink-0">
        <span className="text-[10px] text-white/30 uppercase tracking-widest whitespace-nowrap">Ad variant</span>
        <div className="flex gap-1.5 flex-wrap">
          {AD_VARIANTS.map((v) => (
            <button
              key={v.id}
              onClick={() => { setSelectedAd(v); setOpeningFired(false); }}
              className={`text-[10px] px-2.5 py-1 rounded border transition-colors ${
                selectedAd.id === v.id
                  ? 'border-[#7F77DD] bg-[#7F77DD]/15 text-[#a09be8]'
                  : 'border-white/10 text-white/40 hover:text-white/60'
              }`}
            >
              {v.name}
            </button>
          ))}
        </div>
        <div className="flex-1 text-[10px] text-white/25 italic truncate hidden md:block">
          "{selectedAd.copy}"
        </div>
        <button
          onClick={handleFireOpening}
          disabled={loading || openingFired}
          className={`text-[10px] px-3 py-1.5 rounded border font-medium transition-colors whitespace-nowrap ${
            openingFired
              ? 'border-white/10 text-white/20 cursor-not-allowed'
              : 'border-[#7F77DD]/50 text-[#a09be8] hover:bg-[#7F77DD]/10'
          }`}
        >
          {openingFired ? '✓ Agent opened' : '▶ Fire opening message'}
        </button>
      </div>

      {/* 3 columns */}
      <div className="flex gap-2 flex-1 p-3 overflow-hidden min-h-0">
        {MODELS.map((m) => (
          <ChatColumn
            key={m}
            modelKey={m}
            messages={messages[m]}
            streaming={streaming[m]}
          />
        ))}
      </div>

      {/* Input bar */}
      <div className="border-t border-white/10 px-4 py-3 flex gap-2 items-end flex-shrink-0">
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a message… (Enter to send, Shift+Enter for newline)"
          disabled={loading}
          rows={2}
          className="flex-1 bg-white/5 border border-white/10 rounded-lg px-4 py-2.5 text-sm text-white/90 placeholder-white/25 focus:outline-none focus:border-white/20 resize-none disabled:opacity-50"
        />
        <div className="flex flex-col gap-1">
          <button
            onClick={handleSend}
            disabled={loading || !input.trim()}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-[#7F77DD] hover:bg-[#6f67cd] text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
          >
            {loading ? 'Sending…' : 'Send'}
          </button>
          <button
            onClick={handleComplete}
            disabled={!sessionId || status === 'completed'}
            className="px-4 py-2 text-xs font-medium rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-white/60 transition-colors disabled:opacity-30 disabled:cursor-not-allowed whitespace-nowrap"
          >
            Complete
          </button>
        </div>
      </div>
    </div>
  );
}
