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

const WALLET_STORAGE_KEY = 'copyTradingWallet';

export default function PositionsPage() {
  const [positionsByTrader, setPositionsByTrader] = useState<Record<string, Position[]>>({});
  const [unmatchedPositions, setUnmatchedPositions] = useState<Position[]>([]);
  const [summary, setSummary] = useState<PositionsSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [expandedTraders, setExpandedTraders] = useState<Set<string>>(new Set());
  const [wallet, setWallet] = useState('');
  const [walletInput, setWalletInput] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Load saved wallet from localStorage on mount
  useEffect(() => {
    const savedWallet = localStorage.getItem(WALLET_STORAGE_KEY);
    if (savedWallet) {
      setWallet(savedWallet);
      setWalletInput(savedWallet);
    }
  }, []);

  // Fetch positions when wallet changes
  useEffect(() => {
    if (!wallet) return;
    fetchPositions(wallet);
  }, [wallet]);

  async function fetchPositions(walletAddress: string) {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/copy-trading/positions?wallet=${walletAddress}`);
      const data = await response.json();

      if (data.success) {
        setPositionsByTrader(data.positionsByTrader);
        setUnmatchedPositions(data.unmatchedPositions);
        setSummary(data.summary);
        // Expand all traders by default
        setExpandedTraders(new Set(Object.keys(data.positionsByTrader)));
      } else {
        setError(data.error || 'Failed to fetch positions');
      }
    } catch (err) {
      console.error('Failed to fetch positions:', err);
      setError('Failed to fetch positions');
    } finally {
      setLoading(false);
    }
  }

  function handleSetWallet(e: React.FormEvent) {
    e.preventDefault();
    if (!walletInput.trim()) return;
    const cleanWallet = walletInput.trim().toLowerCase();
    localStorage.setItem(WALLET_STORAGE_KEY, cleanWallet);
    setWallet(cleanWallet);
  }

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

  // No wallet configured yet
  if (!wallet) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold text-white">My Positions</h1>
        <div className="bg-[#0A0A0A] border border-[#1E1E1E] rounded-xl p-6">
          <h2 className="text-lg font-semibold text-white mb-2">Configure Your Wallet</h2>
          <p className="text-sm text-[#6E6E6E] mb-4">
            Enter your Polymarket wallet address to see your copied positions and P&L attribution by trader.
          </p>
          <form onSubmit={handleSetWallet} className="flex gap-2">
            <input
              type="text"
              value={walletInput}
              onChange={(e) => setWalletInput(e.target.value)}
              placeholder="0x..."
              className="flex-1 px-4 py-2 bg-[#111] border border-[#2A2A2A] rounded-lg text-white text-sm placeholder-[#4E4E4E] focus:outline-none focus:border-primary-green font-mono"
            />
            <button
              type="submit"
              className="px-4 py-2 bg-primary-green text-black text-sm font-semibold rounded-lg hover:bg-primary-green/90 transition-colors"
            >
              Load Positions
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">My Positions</h1>
          <div className="text-xs text-[#6E6E6E] font-mono mt-1">
            {wallet.slice(0, 6)}...{wallet.slice(-4)}
            <button
              onClick={() => {
                localStorage.removeItem(WALLET_STORAGE_KEY);
                setWallet('');
                setWalletInput('');
                setPositionsByTrader({});
                setUnmatchedPositions([]);
                setSummary(null);
              }}
              className="ml-2 text-[#9E9E9E] hover:text-red-400 transition-colors"
            >
              (change)
            </button>
          </div>
        </div>
        {loading && (
          <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-primary-green" />
        )}
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 text-red-400 text-sm">
          {error}
        </div>
      )}

      {/* Summary Cards */}
      {summary && !loading && (
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

        {Object.keys(positionsByTrader).length === 0 && !loading && (
          <div className="bg-[#0A0A0A] border border-[#1E1E1E] rounded-xl p-8 text-center">
            <div className="text-[#6E6E6E] text-sm">No matched positions</div>
            <div className="text-[#4E4E4E] text-xs mt-1">
              Copy trades from tracked traders to see P&L attribution
            </div>
          </div>
        )}

        {loading && (
          <div className="bg-[#0A0A0A] border border-[#1E1E1E] rounded-xl p-8 text-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-green mx-auto mb-2" />
            <div className="text-[#6E6E6E] text-sm">Loading positions and matching to traders...</div>
            <div className="text-[#4E4E4E] text-xs mt-1">This may take a moment</div>
          </div>
        )}
      </div>

      {/* Unmatched Positions */}
      {unmatchedPositions.length > 0 && !loading && (
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
