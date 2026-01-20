'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

interface Position {
  title: string;
  outcome: string;
  size: number;
  avgPrice: number;
  curPrice: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
}

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
  netPnl?: number;
  lastSeenTimestamp?: number;
  isActive: boolean;
  isTracking: boolean;
  totalAlerts: number;
  totalCopied: number;
  totalPnl: number;
  // Position data
  positionCount: number;
  totalPositionValue: number;
  totalUnrealizedPnl: number;
  topPositions: Position[];
  positionsUpdatedAt?: string;
}

export default function TradersPage() {
  const [traders, setTraders] = useState<TrackedTrader[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [newWallet, setNewWallet] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [profiling, setProfiling] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    fetchTraders();
    // Refresh every 60s
    const interval = setInterval(fetchTraders, 60000);
    return () => clearInterval(interval);
  }, []);

  async function fetchTraders() {
    try {
      const response = await fetch('/api/copy-trading/traders?positions=true');
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

  async function handleProfileTrader(e: React.FormEvent) {
    e.preventDefault();
    if (!newWallet) return;

    setProfiling(true);
    try {
      const response = await fetch('/api/copy-trading/profile-trader', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wallet: newWallet.trim().toLowerCase(),
          label: newLabel.trim() || `Trader-${newWallet.slice(0, 6)}`,
        }),
      });
      const data = await response.json();

      if (data.success) {
        await fetchTraders();
        setShowAddModal(false);
        setNewWallet('');
        setNewLabel('');
      } else {
        alert(data.error || 'Failed to profile trader');
      }
    } catch (error) {
      console.error('Failed to profile trader:', error);
      alert('Failed to profile trader');
    } finally {
      setProfiling(false);
    }
  }

  async function handleStartTracking(wallet: string) {
    try {
      await fetch('/api/copy-trading/traders', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet, action: 'startTracking' }),
      });
      await fetchTraders();
    } catch (error) {
      console.error('Failed to start tracking:', error);
    }
  }

  async function handleStopTracking(wallet: string) {
    try {
      await fetch('/api/copy-trading/traders', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet, action: 'stopTracking' }),
      });
      await fetchTraders();
    } catch (error) {
      console.error('Failed to stop tracking:', error);
    }
  }

  async function handleRemoveTrader(wallet: string) {
    if (!confirm('Remove this trader completely?')) return;
    try {
      await fetch(`/api/copy-trading/traders?wallet=${wallet}`, { method: 'DELETE' });
      setTraders(prev => prev.filter(t => t.wallet !== wallet));
    } catch (error) {
      console.error('Failed to remove trader:', error);
    }
  }

  async function refreshPositions() {
    setRefreshing(true);
    try {
      await fetch('/api/copy-trading/refresh-positions', { method: 'POST' });
      await fetchTraders();
    } catch (error) {
      console.error('Failed to refresh positions:', error);
    } finally {
      setRefreshing(false);
    }
  }

  const formatValue = (v: number) => {
    if (Math.abs(v) >= 1000000) return `$${(v / 1000000).toFixed(1)}M`;
    if (Math.abs(v) >= 1000) return `$${(v / 1000).toFixed(1)}K`;
    return `$${v.toFixed(0)}`;
  };

  const timeAgo = (timestamp: number | undefined) => {
    if (!timestamp) return '-';
    const seconds = Math.floor(Date.now() / 1000 - timestamp);
    if (seconds < 60) return 'Now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
    return `${Math.floor(seconds / 86400)}d`;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-green" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-white">Tracked Traders</h1>
        <div className="flex gap-2">
          <button
            onClick={refreshPositions}
            disabled={refreshing}
            className="px-3 py-2 bg-[#1A1A1A] text-[#9E9E9E] text-sm font-medium rounded-lg hover:bg-[#2A2A2A] transition-colors disabled:opacity-50"
          >
            {refreshing ? 'Refreshing...' : '↻ Refresh'}
          </button>
          <button
            onClick={() => setShowAddModal(true)}
            className="px-4 py-2 bg-primary-green text-black text-sm font-semibold rounded-lg hover:bg-primary-green/90 transition-colors"
          >
            + Profile Trader
          </button>
        </div>
      </div>

      {/* Traders Grid - 3x3 */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {traders.map((trader) => {
          const isRecentlyActive = trader.lastSeenTimestamp &&
            (Date.now() / 1000 - trader.lastSeenTimestamp) < 3600;

          return (
            <div
              key={trader._id}
              className="bg-[#0A0A0A] border border-[#1E1E1E] rounded-xl overflow-hidden hover:border-primary-green/30 transition-all"
            >
              {/* Card Header */}
              <Link
                href={`/copy-trading/traders/${trader.wallet}`}
                className="block p-4 hover:bg-[#111] transition-colors"
              >
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full ${isRecentlyActive ? 'bg-primary-green' : 'bg-[#4E4E4E]'}`} />
                    <span className="font-bold text-white text-base">{trader.label}</span>
                    {trader.isTracking && (
                      <span className="px-1.5 py-0.5 text-[10px] bg-primary-green/20 text-primary-green rounded">
                        TRACKING
                      </span>
                    )}
                  </div>
                  <span className="text-xs text-[#6E6E6E]">{timeAgo(trader.lastSeenTimestamp)}</span>
                </div>

                {/* Key Metrics Row */}
                <div className="grid grid-cols-4 gap-2 mb-3">
                  <div className="text-center">
                    <div className="text-[10px] text-[#6E6E6E] uppercase">Win Rate</div>
                    <div className="text-sm font-semibold text-white">
                      {trader.winRate ? `${trader.winRate.toFixed(0)}%` : '-'}
                    </div>
                  </div>
                  <div className="text-center">
                    <div className="text-[10px] text-[#6E6E6E] uppercase">Net P&L</div>
                    <div className={`text-sm font-semibold ${(trader.netPnl || 0) >= 0 ? 'text-primary-green' : 'text-red-400'}`}>
                      {formatValue(trader.netPnl || 0)}
                    </div>
                  </div>
                  <div className="text-center">
                    <div className="text-[10px] text-[#6E6E6E] uppercase">Value</div>
                    <div className="text-sm font-semibold text-white">
                      {formatValue(trader.totalPositionValue || 0)}
                    </div>
                  </div>
                  <div className="text-center">
                    <div className="text-[10px] text-[#6E6E6E] uppercase">Alerts</div>
                    <div className="text-sm font-semibold text-white">{trader.totalAlerts || 0}</div>
                  </div>
                </div>

                {/* Strategy Badge */}
                {(trader.strategyLabel || trader.specialty) && (
                  <div className="flex gap-1.5 mb-3">
                    {trader.strategyLabel && (
                      <span className="px-2 py-0.5 text-[10px] bg-[#1A1A1A] text-[#9E9E9E] rounded">
                        {trader.strategyLabel.replace(/_/g, ' ')}
                      </span>
                    )}
                    {trader.specialty && (
                      <span className="px-2 py-0.5 text-[10px] bg-primary-green/10 text-primary-green rounded">
                        {trader.specialty}
                      </span>
                    )}
                  </div>
                )}

                {/* Open Positions */}
                <div className="border-t border-[#1E1E1E] pt-3">
                  <div className="text-[10px] text-[#6E6E6E] uppercase mb-2">
                    Top Positions ({trader.positionCount || 0} total)
                  </div>
                  <div className="space-y-1.5 max-h-[140px] overflow-y-auto scrollbar-thin">
                    {trader.topPositions && trader.topPositions.length > 0 ? (
                      trader.topPositions.map((pos, idx) => (
                        <div key={idx} className="flex items-center justify-between text-xs bg-[#111] rounded px-2 py-1.5">
                          <div className="truncate flex-1 min-w-0">
                            <div className="text-[#6E6E6E] text-[10px] truncate">{pos.title?.substring(0, 30)}...</div>
                            <div className="text-white truncate">{pos.outcome}</div>
                          </div>
                          <div className="text-right ml-2 flex-shrink-0">
                            <div className={`font-mono ${pos.cashPnl >= 0 ? 'text-primary-green' : 'text-red-400'}`}>
                              {pos.cashPnl >= 0 ? '+' : ''}{formatValue(pos.cashPnl)}
                            </div>
                            <div className="text-[#6E6E6E] text-[10px]">
                              {(pos.avgPrice * 100).toFixed(0)}¢→{(pos.curPrice * 100).toFixed(0)}¢
                            </div>
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="text-xs text-[#4E4E4E] text-center py-2">
                        No significant positions
                      </div>
                    )}
                  </div>
                </div>
              </Link>

              {/* Action Buttons */}
              <div className="flex border-t border-[#1E1E1E]">
                {trader.isTracking ? (
                  <button
                    onClick={() => handleStopTracking(trader.wallet)}
                    className="flex-1 px-3 py-2 text-xs font-medium text-[#9E9E9E] hover:bg-[#1A1A1A] transition-colors"
                  >
                    Stop Tracking
                  </button>
                ) : (
                  <button
                    onClick={() => handleStartTracking(trader.wallet)}
                    className="flex-1 px-3 py-2 text-xs font-medium text-primary-green hover:bg-primary-green/10 transition-colors"
                  >
                    Start Tracking
                  </button>
                )}
                <div className="w-px bg-[#1E1E1E]" />
                <button
                  onClick={() => handleRemoveTrader(trader.wallet)}
                  className="px-3 py-2 text-xs font-medium text-[#6E6E6E] hover:bg-red-500/10 hover:text-red-400 transition-colors"
                >
                  Remove
                </button>
              </div>
            </div>
          );
        })}

        {traders.length === 0 && (
          <div className="col-span-full bg-[#0A0A0A] border border-[#1E1E1E] rounded-xl p-8 text-center">
            <div className="text-[#6E6E6E] text-sm mb-4">No traders profiled yet</div>
            <p className="text-[#4E4E4E] text-xs mb-4">
              Add a Polymarket wallet to profile the trader and view their stats.
            </p>
            <button
              onClick={() => setShowAddModal(true)}
              className="px-4 py-2 bg-primary-green text-black text-sm font-semibold rounded-lg hover:bg-primary-green/90 transition-colors"
            >
              + Profile Your First Trader
            </button>
          </div>
        )}
      </div>

      {/* Add/Profile Trader Modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
          <div className="bg-[#0A0A0A] border border-[#1E1E1E] rounded-xl p-5 w-full max-w-md">
            <h2 className="text-lg font-bold text-white mb-1">Profile Trader</h2>
            <p className="text-xs text-[#6E6E6E] mb-4">
              Enter a wallet address to analyze the trader's activity, win rate, and positions.
            </p>

            <form onSubmit={handleProfileTrader} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-[#6E6E6E] uppercase mb-1">
                  Wallet Address *
                </label>
                <input
                  type="text"
                  value={newWallet}
                  onChange={(e) => setNewWallet(e.target.value)}
                  placeholder="0x..."
                  className="w-full px-3 py-2.5 bg-[#111] border border-[#2A2A2A] rounded-lg text-white text-sm placeholder-[#4E4E4E] focus:outline-none focus:border-primary-green font-mono"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-[#6E6E6E] uppercase mb-1">
                  Label (optional)
                </label>
                <input
                  type="text"
                  value={newLabel}
                  onChange={(e) => setNewLabel(e.target.value)}
                  placeholder="e.g. JC00, NBAWhale"
                  className="w-full px-3 py-2.5 bg-[#111] border border-[#2A2A2A] rounded-lg text-white text-sm placeholder-[#4E4E4E] focus:outline-none focus:border-primary-green"
                />
              </div>

              <div className="bg-[#111] border border-[#2A2A2A] rounded-lg p-3">
                <div className="text-xs text-[#9E9E9E] mb-2">This will:</div>
                <ul className="text-xs text-[#6E6E6E] space-y-1">
                  <li>• Fetch last 30 days of activity</li>
                  <li>• Calculate win rate, P&L, and trade sizing</li>
                  <li>• Identify market strengths/weaknesses</li>
                  <li>• Save profile to database</li>
                </ul>
                <div className="text-[10px] text-[#4E4E4E] mt-2">
                  Tracking won't start until you click "Start Tracking".
                </div>
              </div>

              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="flex-1 px-4 py-2.5 bg-[#1A1A1A] text-[#9E9E9E] text-sm font-medium rounded-lg hover:bg-[#2A2A2A] transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={profiling || !newWallet}
                  className="flex-1 px-4 py-2.5 bg-primary-green text-black text-sm font-semibold rounded-lg hover:bg-primary-green/90 transition-colors disabled:opacity-50"
                >
                  {profiling ? 'Profiling...' : 'Profile Trader'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
