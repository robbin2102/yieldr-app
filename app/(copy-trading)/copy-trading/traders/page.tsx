'use client';

import { useEffect, useState } from 'react';

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
  lastSeenTimestamp?: number;
  isActive: boolean;
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
  const [newTrader, setNewTrader] = useState({ wallet: '', label: '', notes: '' });
  const [adding, setAdding] = useState(false);
  const [hoveredTrader, setHoveredTrader] = useState<string | null>(null);
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
        await fetchTraders();
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
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-bold text-white">Tracked Traders</h1>
        <div className="flex gap-2">
          <button
            onClick={refreshPositions}
            disabled={refreshing}
            className="px-3 py-1.5 bg-[#1A1A1A] text-[#9E9E9E] text-xs font-medium rounded-lg hover:bg-[#2A2A2A] transition-colors disabled:opacity-50"
          >
            {refreshing ? 'Refreshing...' : 'Refresh'}
          </button>
          <button
            onClick={() => setShowAddModal(true)}
            className="px-3 py-1.5 bg-primary-green text-black text-xs font-semibold rounded-lg hover:bg-primary-green/90 transition-colors"
          >
            + Add
          </button>
        </div>
      </div>

      {/* Traders Grid - Compact 3x3 */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
        {traders.map((trader) => {
          const isActive = trader.lastSeenTimestamp &&
            (Date.now() / 1000 - trader.lastSeenTimestamp) < 3600;
          const isHovered = hoveredTrader === trader._id;

          return (
            <div
              key={trader._id}
              className="relative bg-[#0A0A0A] border border-[#1E1E1E] rounded-lg p-2.5 hover:border-primary-green/30 transition-all cursor-pointer"
              onMouseEnter={() => setHoveredTrader(trader._id)}
              onMouseLeave={() => setHoveredTrader(null)}
            >
              {/* Header Row */}
              <div className="flex items-center justify-between mb-1.5">
                <div className="flex items-center gap-1.5">
                  <div className={`w-1.5 h-1.5 rounded-full ${isActive ? 'bg-primary-green' : 'bg-[#4E4E4E]'}`} />
                  <span className="font-semibold text-white text-xs">{trader.label}</span>
                </div>
                <span className="text-[9px] text-[#6E6E6E]">{timeAgo(trader.lastSeenTimestamp)}</span>
              </div>

              {/* Stats Row - Compact */}
              <div className="grid grid-cols-4 gap-1 mb-1.5">
                <div className="text-center">
                  <div className="text-[8px] text-[#6E6E6E]">Win</div>
                  <div className="text-[10px] font-medium text-white">
                    {trader.winRate ? `${trader.winRate.toFixed(0)}%` : '-'}
                  </div>
                </div>
                <div className="text-center">
                  <div className="text-[8px] text-[#6E6E6E]">Alerts</div>
                  <div className="text-[10px] font-medium text-white">{trader.totalAlerts || 0}</div>
                </div>
                <div className="text-center">
                  <div className="text-[8px] text-[#6E6E6E]">Value</div>
                  <div className="text-[10px] font-medium text-white">
                    {formatValue(trader.totalPositionValue || 0)}
                  </div>
                </div>
                <div className="text-center">
                  <div className="text-[8px] text-[#6E6E6E]">P&L</div>
                  <div className={`text-[10px] font-medium ${(trader.totalUnrealizedPnl || 0) >= 0 ? 'text-primary-green' : 'text-red-400'}`}>
                    {(trader.totalUnrealizedPnl || 0) >= 0 ? '+' : ''}{formatValue(trader.totalUnrealizedPnl || 0)}
                  </div>
                </div>
              </div>

              {/* Top Positions (compact scrollable) */}
              <div className="max-h-[60px] overflow-y-auto border-t border-[#1E1E1E] pt-1.5 space-y-0.5">
                {trader.topPositions && trader.topPositions.length > 0 ? (
                  trader.topPositions.slice(0, 3).map((pos, idx) => (
                    <div key={idx} className="flex items-center justify-between text-[9px]">
                      <div className="truncate flex-1 text-[#9E9E9E]">
                        {pos.outcome.substring(0, 15)} - {pos.title?.substring(0, 12)}...
                      </div>
                      <div className={`ml-1 font-mono ${pos.cashPnl >= 0 ? 'text-primary-green' : 'text-red-400'}`}>
                        {pos.cashPnl >= 0 ? '+' : ''}{formatValue(pos.cashPnl)}
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="text-[9px] text-[#4E4E4E] text-center">
                    {trader.positionCount > 0 ? `${trader.positionCount} pos` : 'No positions'}
                  </div>
                )}
              </div>

              {/* Quick Actions */}
              <div className="flex gap-1 mt-1.5 pt-1.5 border-t border-[#1E1E1E]">
                <button
                  onClick={() => handleRemoveTrader(trader.wallet)}
                  className="flex-1 px-1.5 py-1 text-center bg-[#1A1A1A] text-[#6E6E6E] text-[9px] font-medium rounded hover:bg-red-500/20 hover:text-red-400 transition-colors"
                >
                  Remove
                </button>
              </div>

              {/* Hover Card - Full Profile */}
              {isHovered && (
                <div className="absolute z-50 left-full ml-2 top-0 w-64 bg-[#111] border border-[#2A2A2A] rounded-lg p-3 shadow-xl pointer-events-none">
                  <div className="text-sm font-semibold text-white mb-1">{trader.label}</div>
                  <div className="text-[9px] text-[#6E6E6E] font-mono mb-2 break-all">
                    {trader.wallet}
                  </div>

                  <div className="grid grid-cols-2 gap-2 mb-2">
                    <div>
                      <div className="text-[8px] text-[#6E6E6E]">Win Rate</div>
                      <div className="text-xs text-white">{trader.winRate?.toFixed(1) || '-'}%</div>
                    </div>
                    <div>
                      <div className="text-[8px] text-[#6E6E6E]">Profit Factor</div>
                      <div className="text-xs text-white">{trader.profitFactor?.toFixed(2) || '-'}</div>
                    </div>
                    <div>
                      <div className="text-[8px] text-[#6E6E6E]">Avg Trade</div>
                      <div className="text-xs text-white">{formatValue(trader.avgTradeSize || 0)}</div>
                    </div>
                    <div>
                      <div className="text-[8px] text-[#6E6E6E]">Positions</div>
                      <div className="text-xs text-white">{trader.positionCount || 0}</div>
                    </div>
                  </div>

                  {trader.specialty && (
                    <div className="mb-2">
                      <span className="px-1.5 py-0.5 text-[8px] bg-primary-green/10 text-primary-green rounded">
                        {trader.specialty}
                      </span>
                    </div>
                  )}

                  <div className="text-[8px] text-[#6E6E6E] mb-1">Top Positions</div>
                  <div className="space-y-1 max-h-28 overflow-y-auto">
                    {trader.topPositions?.slice(0, 5).map((pos, idx) => (
                      <div key={idx} className="flex justify-between text-[9px] bg-[#0A0A0A] p-1.5 rounded">
                        <div className="truncate flex-1 min-w-0">
                          <div className="text-white truncate">{pos.outcome}</div>
                          <div className="text-[#6E6E6E] truncate">{pos.title?.substring(0, 20)}...</div>
                        </div>
                        <div className="text-right ml-1 flex-shrink-0">
                          <div className={pos.cashPnl >= 0 ? 'text-primary-green' : 'text-red-400'}>
                            {pos.cashPnl >= 0 ? '+' : ''}{formatValue(pos.cashPnl)}
                          </div>
                          <div className="text-[#6E6E6E]">{(pos.avgPrice * 100).toFixed(0)}c→{(pos.curPrice * 100).toFixed(0)}c</div>
                        </div>
                      </div>
                    ))}
                    {(!trader.topPositions || trader.topPositions.length === 0) && (
                      <div className="text-[9px] text-[#4E4E4E] text-center py-2">No significant positions</div>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {traders.length === 0 && (
          <div className="col-span-full bg-[#0A0A0A] border border-[#1E1E1E] rounded-lg p-6 text-center">
            <div className="text-[#6E6E6E] text-sm mb-3">No traders tracked yet</div>
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
          <div className="bg-[#0A0A0A] border border-[#1E1E1E] rounded-xl p-4 w-full max-w-sm">
            <h2 className="text-lg font-bold text-white mb-3">Add Trader</h2>

            <form onSubmit={handleAddTrader} className="space-y-3">
              <div>
                <label className="block text-[10px] font-semibold text-[#6E6E6E] uppercase mb-1">
                  Wallet Address
                </label>
                <input
                  type="text"
                  value={newTrader.wallet}
                  onChange={(e) => setNewTrader(prev => ({ ...prev, wallet: e.target.value }))}
                  placeholder="0x..."
                  className="w-full px-3 py-2 bg-[#111] border border-[#2A2A2A] rounded-lg text-white text-sm placeholder-[#4E4E4E] focus:outline-none focus:border-primary-green"
                  required
                />
              </div>

              <div>
                <label className="block text-[10px] font-semibold text-[#6E6E6E] uppercase mb-1">
                  Label
                </label>
                <input
                  type="text"
                  value={newTrader.label}
                  onChange={(e) => setNewTrader(prev => ({ ...prev, label: e.target.value }))}
                  placeholder="e.g. JC00, Whale1"
                  className="w-full px-3 py-2 bg-[#111] border border-[#2A2A2A] rounded-lg text-white text-sm placeholder-[#4E4E4E] focus:outline-none focus:border-primary-green"
                  required
                />
              </div>

              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="flex-1 px-3 py-2 bg-[#1A1A1A] text-[#9E9E9E] text-sm font-medium rounded-lg hover:bg-[#2A2A2A] transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={adding}
                  className="flex-1 px-3 py-2 bg-primary-green text-black text-sm font-semibold rounded-lg hover:bg-primary-green/90 transition-colors disabled:opacity-50"
                >
                  {adding ? 'Adding...' : 'Add'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
