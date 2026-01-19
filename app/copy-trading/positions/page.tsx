'use client';

import { useEffect, useState } from 'react';

interface Position {
  conditionId: string;
  title: string;
  outcome: string;
  size: number;
  avgPrice: number;
  curPrice: number;
  initialValue: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
}

interface PositionsSummary {
  totalPositions: number;
  matchedPositions: number;
  unmatchedCount: number;
  totalPnl: number;
  totalValue: number;
  totalInvested: number;
  pnlPercent: number;
}

export default function PositionsPage() {
  const [positionsByTrader, setPositionsByTrader] = useState<Record<string, Position[]>>({});
  const [unmatchedPositions, setUnmatchedPositions] = useState<Position[]>([]);
  const [summary, setSummary] = useState<PositionsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedTraders, setExpandedTraders] = useState<Set<string>>(new Set());

  useEffect(() => {
    async function fetchPositions() {
      try {
        const response = await fetch('/api/copy-trading/positions');
        const data = await response.json();

        if (data.success) {
          setPositionsByTrader(data.positionsByTrader);
          setUnmatchedPositions(data.unmatchedPositions);
          setSummary(data.summary);
          // Expand all traders by default
          setExpandedTraders(new Set(Object.keys(data.positionsByTrader)));
        }
      } catch (error) {
        console.error('Failed to fetch positions:', error);
      } finally {
        setLoading(false);
      }
    }

    fetchPositions();
  }, []);

  const toggleTrader = (trader: string) => {
    setExpandedTraders(prev => {
      const newSet = new Set(prev);
      if (newSet.has(trader)) {
        newSet.delete(trader);
      } else {
        newSet.add(trader);
      }
      return newSet;
    });
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
        <h1 className="text-2xl font-bold text-white">My Positions</h1>
      </div>

      {/* Summary Cards */}
      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="bg-[#0A0A0A] border border-[#1E1E1E] rounded-xl p-4">
            <div className="text-xs text-[#6E6E6E] uppercase mb-1">Total P&L</div>
            <div className={`text-xl font-bold ${summary.totalPnl >= 0 ? 'text-primary-green' : 'text-red-400'}`}>
              {summary.totalPnl >= 0 ? '+' : ''}${summary.totalPnl.toFixed(2)}
            </div>
            <div className="text-xs text-[#6E6E6E]">
              {summary.pnlPercent >= 0 ? '+' : ''}{summary.pnlPercent.toFixed(1)}%
            </div>
          </div>

          <div className="bg-[#0A0A0A] border border-[#1E1E1E] rounded-xl p-4">
            <div className="text-xs text-[#6E6E6E] uppercase mb-1">Current Value</div>
            <div className="text-xl font-bold text-white">
              ${summary.totalValue.toFixed(2)}
            </div>
            <div className="text-xs text-[#6E6E6E]">
              {summary.totalPositions} positions
            </div>
          </div>

          <div className="bg-[#0A0A0A] border border-[#1E1E1E] rounded-xl p-4">
            <div className="text-xs text-[#6E6E6E] uppercase mb-1">Total Invested</div>
            <div className="text-xl font-bold text-white">
              ${summary.totalInvested.toFixed(2)}
            </div>
          </div>

          <div className="bg-[#0A0A0A] border border-[#1E1E1E] rounded-xl p-4">
            <div className="text-xs text-[#6E6E6E] uppercase mb-1">Matched</div>
            <div className="text-xl font-bold text-white">
              {summary.matchedPositions}/{summary.totalPositions}
            </div>
            <div className="text-xs text-[#6E6E6E]">
              {summary.unmatchedCount} unmatched
            </div>
          </div>
        </div>
      )}

      {/* Positions by Trader */}
      <div className="space-y-4">
        <h2 className="text-lg font-semibold text-white">Positions by Trader</h2>

        {Object.entries(positionsByTrader).map(([trader, positions]) => {
          const totalPnl = positions.reduce((sum, p) => sum + p.cashPnl, 0);
          const totalValue = positions.reduce((sum, p) => sum + p.currentValue, 0);
          const isExpanded = expandedTraders.has(trader);

          return (
            <div
              key={trader}
              className="bg-[#0A0A0A] border border-[#1E1E1E] rounded-xl overflow-hidden"
            >
              {/* Trader Header */}
              <button
                onClick={() => toggleTrader(trader)}
                className="w-full flex items-center justify-between p-4 hover:bg-[#111] transition-colors"
              >
                <div className="flex items-center gap-4">
                  <span className="text-lg font-semibold text-white">{trader}</span>
                  <span className="text-sm text-[#6E6E6E]">
                    {positions.length} position{positions.length !== 1 ? 's' : ''}
                  </span>
                </div>
                <div className="flex items-center gap-4">
                  <div className="text-right">
                    <div className={`font-mono font-semibold ${totalPnl >= 0 ? 'text-primary-green' : 'text-red-400'}`}>
                      {totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}
                    </div>
                    <div className="text-xs text-[#6E6E6E]">
                      ${totalValue.toFixed(2)} value
                    </div>
                  </div>
                  <span className="text-[#6E6E6E]">{isExpanded ? '▲' : '▼'}</span>
                </div>
              </button>

              {/* Positions List */}
              {isExpanded && (
                <div className="border-t border-[#1E1E1E]">
                  {positions.map((pos, idx) => (
                    <div
                      key={`${pos.conditionId}-${idx}`}
                      className="flex items-center justify-between px-4 py-3 border-b border-[#1E1E1E] last:border-b-0 hover:bg-[#111] transition-colors"
                    >
                      <div className="flex-1">
                        <div className="text-sm text-white">
                          {pos.title?.substring(0, 40)}...
                        </div>
                        <div className="text-xs text-[#6E6E6E] flex items-center gap-2">
                          <span>{pos.outcome}</span>
                          <span className="text-[#4E4E4E]">|</span>
                          <span>{(pos.avgPrice * 100).toFixed(0)}¢ → {(pos.curPrice * 100).toFixed(0)}¢</span>
                          <span className="text-[#4E4E4E]">|</span>
                          <span>{pos.size.toFixed(0)} shares</span>
                        </div>
                      </div>
                      <div className="text-right ml-4">
                        <div className={`font-mono text-sm ${pos.cashPnl >= 0 ? 'text-primary-green' : 'text-red-400'}`}>
                          {pos.cashPnl >= 0 ? '+' : ''}${pos.cashPnl.toFixed(2)}
                        </div>
                        <div className="text-xs text-[#6E6E6E]">
                          ${pos.currentValue.toFixed(2)}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}

        {Object.keys(positionsByTrader).length === 0 && (
          <div className="bg-[#0A0A0A] border border-[#1E1E1E] rounded-xl p-8 text-center">
            <div className="text-[#6E6E6E] text-sm">No matched positions</div>
            <div className="text-[#4E4E4E] text-xs mt-1">
              Copy trades from tracked traders to see P&L attribution
            </div>
          </div>
        )}
      </div>

      {/* Unmatched Positions */}
      {unmatchedPositions.length > 0 && (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold text-white flex items-center gap-2">
            Unmatched Positions
            <span className="text-sm font-normal text-[#6E6E6E]">
              ({unmatchedPositions.length})
            </span>
          </h2>

          <div className="bg-[#0A0A0A] border border-[#1E1E1E] rounded-xl overflow-hidden">
            {unmatchedPositions.map((pos, idx) => (
              <div
                key={`unmatched-${idx}`}
                className="flex items-center justify-between px-4 py-3 border-b border-[#1E1E1E] last:border-b-0 hover:bg-[#111] transition-colors"
              >
                <div className="flex-1">
                  <div className="text-sm text-white">
                    {pos.title?.substring(0, 40)}...
                  </div>
                  <div className="text-xs text-[#6E6E6E]">
                    {pos.outcome} @ {(pos.avgPrice * 100).toFixed(0)}¢ → {(pos.curPrice * 100).toFixed(0)}¢
                  </div>
                </div>
                <div className="text-right ml-4">
                  <div className={`font-mono text-sm ${pos.cashPnl >= 0 ? 'text-primary-green' : 'text-red-400'}`}>
                    {pos.cashPnl >= 0 ? '+' : ''}${pos.cashPnl.toFixed(2)}
                  </div>
                  <div className="text-xs text-[#6E6E6E]">
                    ${pos.currentValue.toFixed(2)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
