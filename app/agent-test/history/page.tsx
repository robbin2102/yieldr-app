'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

interface SessionRow {
  session_id: string;
  test_label: string;
  created_at: string;
  status: 'active' | 'completed' | 'abandoned';
  state: {
    exchange_count: number;
    outcome?: string;
    vault_interest?: string;
  };
}

const STATUS_COLORS: Record<string, string> = {
  active: 'text-green-400 bg-green-400/10',
  completed: 'text-blue-400 bg-blue-400/10',
  abandoned: 'text-red-400 bg-red-400/10',
};

const OUTCOME_COLORS: Record<string, string> = {
  purchased: 'text-emerald-400',
  declined: 'text-red-400',
  alerts_set: 'text-yellow-400',
  community_joined: 'text-purple-400',
};

export default function HistoryPage() {
  const router = useRouter();
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState('');
  const [filterLabel, setFilterLabel] = useState('');
  const [sortBy, setSortBy] = useState<'date' | 'exchanges'>('date');

  const fetchSessions = useCallback(async () => {
    setLoading(true);
    const res = await fetch('/api/agent-test/sessions');
    const data = await res.json();
    setSessions(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  const filtered = sessions
    .filter((s) => (filterStatus ? s.status === filterStatus : true))
    .filter((s) =>
      filterLabel ? s.test_label?.toLowerCase().includes(filterLabel.toLowerCase()) : true
    )
    .sort((a, b) => {
      if (sortBy === 'exchanges') {
        return (b.state?.exchange_count || 0) - (a.state?.exchange_count || 0);
      }
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });

  const handleRowClick = (sid: string) => {
    router.push(`/agent-test?session=${sid}`);
  };

  return (
    <div className="min-h-screen bg-[#0d0d0f] text-white" style={{ fontFamily: 'Inter, sans-serif' }}>
      {/* Header */}
      <header className="border-b border-white/10 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link
            href="/agent-test"
            className="text-xs text-white/40 hover:text-white/70 transition-colors"
          >
            ← Back to Test
          </Link>
          <h1 className="text-sm font-semibold text-white/80">Session History</h1>
          <span className="text-xs text-white/30">{sessions.length} sessions</span>
        </div>
        <button
          onClick={fetchSessions}
          className="text-xs bg-white/5 hover:bg-white/10 border border-white/10 rounded px-3 py-1.5 text-white/60 transition-colors"
        >
          Refresh
        </button>
      </header>

      {/* Filters */}
      <div className="px-6 py-3 border-b border-white/5 flex items-center gap-3">
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
          className="text-xs bg-white/5 border border-white/10 rounded px-3 py-1.5 text-white/60 focus:outline-none"
        >
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="completed">Completed</option>
          <option value="abandoned">Abandoned</option>
        </select>

        <input
          type="text"
          placeholder="Filter by label…"
          value={filterLabel}
          onChange={(e) => setFilterLabel(e.target.value)}
          className="text-xs bg-white/5 border border-white/10 rounded px-3 py-1.5 text-white/60 placeholder-white/25 focus:outline-none w-48"
        />

        <div className="flex items-center gap-1 ml-auto">
          <span className="text-[10px] text-white/30 mr-1">Sort:</span>
          <button
            onClick={() => setSortBy('date')}
            className={`text-[10px] px-2 py-1 rounded transition-colors ${
              sortBy === 'date' ? 'bg-white/15 text-white/80' : 'text-white/40 hover:text-white/60'
            }`}
          >
            Date
          </button>
          <button
            onClick={() => setSortBy('exchanges')}
            className={`text-[10px] px-2 py-1 rounded transition-colors ${
              sortBy === 'exchanges' ? 'bg-white/15 text-white/80' : 'text-white/40 hover:text-white/60'
            }`}
          >
            Exchanges
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="px-6 py-4">
        {loading ? (
          <p className="text-white/30 text-sm text-center py-12">Loading…</p>
        ) : filtered.length === 0 ? (
          <p className="text-white/30 text-sm text-center py-12">No sessions found</p>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-white/30 border-b border-white/5">
                <th className="text-left pb-2 font-medium pr-4">Session ID</th>
                <th className="text-left pb-2 font-medium pr-4">Label</th>
                <th className="text-left pb-2 font-medium pr-4">Date</th>
                <th className="text-center pb-2 font-medium pr-4">Exchanges</th>
                <th className="text-left pb-2 font-medium pr-4">Status</th>
                <th className="text-left pb-2 font-medium pr-4">Vault Interest</th>
                <th className="text-left pb-2 font-medium">Outcome</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((s) => (
                <tr
                  key={s.session_id}
                  onClick={() => handleRowClick(s.session_id)}
                  className="border-b border-white/5 hover:bg-white/3 cursor-pointer transition-colors"
                >
                  <td className="py-2.5 pr-4 font-mono text-white/50">
                    {s.session_id.slice(0, 12)}…
                  </td>
                  <td className="py-2.5 pr-4 text-white/70">
                    {s.test_label || <span className="text-white/25 italic">untitled</span>}
                  </td>
                  <td className="py-2.5 pr-4 text-white/40">
                    {new Date(s.created_at).toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </td>
                  <td className="py-2.5 pr-4 text-center text-white/70 font-mono">
                    {s.state?.exchange_count ?? 0}
                  </td>
                  <td className="py-2.5 pr-4">
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${STATUS_COLORS[s.status] || ''}`}>
                      {s.status}
                    </span>
                  </td>
                  <td className="py-2.5 pr-4 text-white/50">
                    {s.state?.vault_interest || <span className="text-white/20">—</span>}
                  </td>
                  <td className={`py-2.5 font-medium ${OUTCOME_COLORS[s.state?.outcome || ''] || 'text-white/25'}`}>
                    {s.state?.outcome || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
