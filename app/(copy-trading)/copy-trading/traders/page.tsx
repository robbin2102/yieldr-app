'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

interface TrackedTrader {
  _id: string;
  wallet: string;
  label: string;
  notes?: string;
  volumeLabel?: string;
  strategyLabel?: string;
  specialty?: string;
  winRate?: number;
  profitFactor?: number;
  avgTradeSize?: number;
  copyMultiplier: number;
  maxCopySize: number;
  lastSeenTimestamp?: number;
  isActive: boolean;
  totalAlerts: number;
  totalCopied: number;
  totalPnl: number;
  addedAt: Date;
  profiledAt?: Date;
}

export default function TradersPage() {
  const [traders, setTraders] = useState<TrackedTrader[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [newTrader, setNewTrader] = useState({ wallet: '', label: '', notes: '' });
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    fetchTraders();
  }, []);

  async function fetchTraders() {
    try {
      const response = await fetch('/api/copy-trading/traders');
      const data = await response.json();
      if (data.success) {
        setTraders(data.traders);
      }
    } catch (error) {
      console.error('Failed to fetch traders:', error);
    } finally {
      setLoading(false);
    }
  }

  async function handleAddTrader(e: React.FormEvent) {
    e.preventDefault();
    if (!newTrader.wallet || !newTrader.label) return;

    setAdding(true);
    try {
      const response = await fetch('/api/copy-trading/traders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newTrader),
      });
      const data = await response.json();

      if (data.success) {
        setTraders(prev => [...prev, data.trader]);
        setShowAddModal(false);
        setNewTrader({ wallet: '', label: '', notes: '' });
      } else {
        alert(data.error || 'Failed to add trader');
      }
    } catch (error) {
      console.error('Failed to add trader:', error);
    } finally {
      setAdding(false);
    }
  }

  async function handleRemoveTrader(wallet: string) {
    if (!confirm('Remove this trader from tracking?')) return;

    try {
      await fetch(`/api/copy-trading/traders?wallet=${wallet}`, {
        method: 'DELETE',
      });
      setTraders(prev => prev.filter(t => t.wallet !== wallet));
    } catch (error) {
      console.error('Failed to remove trader:', error);
    }
  }

  const timeAgo = (timestamp: number | undefined) => {
    if (!timestamp) return 'Never';
    const seconds = Math.floor(Date.now() / 1000 - timestamp);
    if (seconds < 60) return 'Active now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-green" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">Tracked Traders</h1>
        <button
          onClick={() => setShowAddModal(true)}
          className="px-4 py-2 bg-primary-green text-black text-sm font-semibold rounded-lg hover:bg-primary-green/90 transition-colors"
        >
          + Add Trader
        </button>
      </div>

      {/* Traders Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {traders.map((trader) => {
          const isActive = trader.lastSeenTimestamp &&
            (Date.now() / 1000 - trader.lastSeenTimestamp) < 3600;

          return (
            <div
              key={trader._id}
              className="bg-[#0A0A0A] border border-[#1E1E1E] rounded-xl p-5 hover:border-[#2A2A2A] transition-colors"
            >
              {/* Header */}
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="text-lg font-semibold text-white">{trader.label}</h3>
                  <div className="text-xs text-[#6E6E6E] font-mono">
                    {trader.wallet.slice(0, 10)}...{trader.wallet.slice(-8)}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <div className={`w-2 h-2 rounded-full ${isActive ? 'bg-primary-green' : 'bg-[#4E4E4E]'}`} />
                  <span className="text-xs text-[#6E6E6E]">
                    {timeAgo(trader.lastSeenTimestamp)}
                  </span>
                </div>
              </div>

              {/* Stats */}
              <div className="grid grid-cols-3 gap-4 mb-4 p-3 bg-[#111] rounded-lg">
                <div className="text-center">
                  <div className="text-xs text-[#6E6E6E] uppercase mb-1">Win Rate</div>
                  <div className="text-sm font-semibold text-white">
                    {trader.winRate ? `${trader.winRate.toFixed(1)}%` : '-'}
                  </div>
                </div>
                <div className="text-center">
                  <div className="text-xs text-[#6E6E6E] uppercase mb-1">Alerts</div>
                  <div className="text-sm font-semibold text-white">
                    {trader.totalAlerts || 0}
                  </div>
                </div>
                <div className="text-center">
                  <div className="text-xs text-[#6E6E6E] uppercase mb-1">Copied</div>
                  <div className="text-sm font-semibold text-white">
                    {trader.totalCopied || 0}
                  </div>
                </div>
              </div>

              {/* Tags */}
              <div className="flex flex-wrap gap-2 mb-4">
                {trader.volumeLabel && (
                  <span className="px-2 py-1 text-xs font-medium rounded-full bg-[#1A1A1A] text-[#9E9E9E]">
                    {trader.volumeLabel}
                  </span>
                )}
                {trader.strategyLabel && (
                  <span className="px-2 py-1 text-xs font-medium rounded-full bg-[#1A1A1A] text-[#9E9E9E]">
                    {trader.strategyLabel.replace('_', ' ')}
                  </span>
                )}
                {trader.specialty && (
                  <span className="px-2 py-1 text-xs font-medium rounded-full bg-primary-green/10 text-primary-green">
                    {trader.specialty}
                  </span>
                )}
              </div>

              {/* Notes */}
              {trader.notes && (
                <div className="text-xs text-[#6E6E6E] mb-4 line-clamp-2">
                  {trader.notes}
                </div>
              )}

              {/* Actions */}
              <div className="flex gap-2">
                <Link
                  href={`/copy-trading/traders/${trader.wallet}`}
                  className="flex-1 px-3 py-2 text-center bg-[#1A1A1A] text-[#9E9E9E] text-sm font-medium rounded-lg hover:bg-[#2A2A2A] transition-colors"
                >
                  View Profile
                </Link>
                <button
                  onClick={() => handleRemoveTrader(trader.wallet)}
                  className="px-3 py-2 bg-red-500/10 text-red-400 text-sm font-medium rounded-lg hover:bg-red-500/20 transition-colors"
                >
                  Remove
                </button>
              </div>
            </div>
          );
        })}

        {traders.length === 0 && (
          <div className="col-span-full bg-[#0A0A0A] border border-[#1E1E1E] rounded-xl p-8 text-center">
            <div className="text-[#6E6E6E] text-sm mb-4">No traders tracked yet</div>
            <button
              onClick={() => setShowAddModal(true)}
              className="px-4 py-2 bg-primary-green text-black text-sm font-semibold rounded-lg hover:bg-primary-green/90 transition-colors"
            >
              + Add Your First Trader
            </button>
          </div>
        )}
      </div>

      {/* Add Trader Modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
          <div className="bg-[#0A0A0A] border border-[#1E1E1E] rounded-xl p-6 w-full max-w-md">
            <h2 className="text-xl font-bold text-white mb-4">Add Trader</h2>

            <form onSubmit={handleAddTrader} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-[#6E6E6E] uppercase mb-2">
                  Wallet Address
                </label>
                <input
                  type="text"
                  value={newTrader.wallet}
                  onChange={(e) => setNewTrader(prev => ({ ...prev, wallet: e.target.value }))}
                  placeholder="0x..."
                  className="w-full px-4 py-3 bg-[#111] border border-[#2A2A2A] rounded-lg text-white placeholder-[#4E4E4E] focus:outline-none focus:border-primary-green"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-[#6E6E6E] uppercase mb-2">
                  Label
                </label>
                <input
                  type="text"
                  value={newTrader.label}
                  onChange={(e) => setNewTrader(prev => ({ ...prev, label: e.target.value }))}
                  placeholder="e.g. JC00, Whale1"
                  className="w-full px-4 py-3 bg-[#111] border border-[#2A2A2A] rounded-lg text-white placeholder-[#4E4E4E] focus:outline-none focus:border-primary-green"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-[#6E6E6E] uppercase mb-2">
                  Notes (optional)
                </label>
                <textarea
                  value={newTrader.notes}
                  onChange={(e) => setNewTrader(prev => ({ ...prev, notes: e.target.value }))}
                  placeholder="Any notes about this trader..."
                  rows={3}
                  className="w-full px-4 py-3 bg-[#111] border border-[#2A2A2A] rounded-lg text-white placeholder-[#4E4E4E] focus:outline-none focus:border-primary-green resize-none"
                />
              </div>

              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="flex-1 px-4 py-3 bg-[#1A1A1A] text-[#9E9E9E] text-sm font-semibold rounded-lg hover:bg-[#2A2A2A] transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={adding}
                  className="flex-1 px-4 py-3 bg-primary-green text-black text-sm font-semibold rounded-lg hover:bg-primary-green/90 transition-colors disabled:opacity-50"
                >
                  {adding ? 'Adding...' : 'Add Trader'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
