'use client';

import { useState } from 'react';

export default function TestLPPositions() {
  const [walletAddress, setWalletAddress] = useState('0x67d6f959519731ea3402f23767585991f04cdb67');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState('');

  const fetchPositions = async () => {
    if (!walletAddress) {
      setError('Please enter a wallet address');
      return;
    }

    setLoading(true);
    setError('');
    setResult(null);

    try {
      const response = await fetch('/api/positions/lp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ walletAddress }),
      });

      const data = await response.json();

      if (response.ok) {
        setResult(data);
      } else {
        setError(data.error || 'Failed to fetch positions');
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-black text-white p-8">
      <div className="max-w-6xl mx-auto">
        <h1 className="text-3xl font-bold mb-8">💧 LP Positions Tracker (Base Chain)</h1>

        <div className="bg-[#0A0A0A] border border-[#1A1A1A] rounded-xl p-6 mb-6">
          <label className="block text-sm font-medium mb-2">Wallet Address</label>
          <input
            type="text"
            value={walletAddress}
            onChange={(e) => setWalletAddress(e.target.value)}
            placeholder="0x..."
            className="w-full p-3 bg-black border border-[#1A1A1A] rounded-lg text-white mb-4"
          />
          
          <button
            onClick={fetchPositions}
            disabled={loading}
            className="w-full py-3 bg-[#00C805] text-black font-semibold rounded-lg hover:bg-[#00A000] disabled:opacity-50"
          >
            {loading ? '⚡ Fetching... (~3 seconds)' : '🔍 Fetch LP Positions'}
          </button>
        </div>

        {error && (
          <div className="bg-red-500/10 border border-red-500/50 rounded-lg p-4 mb-6">
            <p className="text-red-500">❌ {error}</p>
          </div>
        )}

        {result && (
          <div className="space-y-6">
            {/* Summary */}
            <div className="bg-[#0A0A0A] border border-[#1A1A1A] rounded-xl p-6">
              <h2 className="text-xl font-bold mb-4">📊 Summary (Last 30 Days)</h2>
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-black p-4 rounded-lg border border-green-500/30">
                  <p className="text-gray-400 text-sm">Open Positions</p>
                  <p className="text-3xl font-bold text-green-500">{result.positions.counts.open}</p>
                </div>
                <div className="bg-black p-4 rounded-lg border border-red-500/30">
                  <p className="text-gray-400 text-sm">Closed Positions</p>
                  <p className="text-3xl font-bold text-red-500">{result.positions.counts.closed}</p>
                </div>
              </div>
            </div>

            {/* Open Positions */}
            {result.positions.counts.open > 0 && (
              <div className="bg-[#0A0A0A] border border-[#1A1A1A] rounded-xl p-6">
                <h2 className="text-xl font-bold mb-4">🟢 Open Positions ({result.positions.counts.open})</h2>
                <div className="space-y-4">
                  {result.positions.open.map((pos: any, idx: number) => (
                    <div key={idx} className="bg-black p-6 rounded-lg border border-green-500/30">
                      <div className="flex justify-between items-start mb-4">
                        <div>
                          <div className="flex items-center gap-3 mb-2">
                            <span className="text-xl font-bold">{pos.pool.token0.symbol}/{pos.pool.token1.symbol}</span>
                            <span className="px-2 py-1 bg-blue-500/20 text-blue-400 text-xs rounded">{pos.protocol}</span>
                          </div>
                          <p className="text-sm text-gray-400">Chain: Base</p>
                        </div>
                        <div className="text-right">
                          <p className="text-sm text-gray-400">Total Value</p>
                          <p className="text-2xl font-bold text-[#00C805]">${pos.liquidityUsd?.toFixed(2) || '0.00'}</p>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-4 mb-4">
                        <div>
                          <p className="text-sm text-gray-400">Token0 Amount</p>
                          <p className="font-mono">{parseFloat(pos.amount0).toFixed(4)} {pos.pool.token0.symbol}</p>
                        </div>
                        <div>
                          <p className="text-sm text-gray-400">Token1 Amount</p>
                          <p className="font-mono">{parseFloat(pos.amount1).toFixed(4)} {pos.pool.token1.symbol}</p>
                        </div>
                      </div>

                      <div className="grid grid-cols-3 gap-4 pt-4 border-t border-gray-800">
                        <div>
                          <p className="text-sm text-gray-400">Unrealized PnL</p>
                          <p className={`font-bold ${pos.unrealizedPnl >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                            ${pos.unrealizedPnl?.toFixed(2) || '0.00'}
                          </p>
                        </div>
                        <div>
                          <p className="text-sm text-gray-400">Fees Earned</p>
                          <p className="font-bold text-blue-400">${pos.feesEarnedUsd?.toFixed(2) || '0.00'}</p>
                        </div>
                        <div>
                          <p className="text-sm text-gray-400">APR</p>
                          <p className="font-bold text-purple-400">{pos.apr?.toFixed(2) || '0.00'}%</p>
                        </div>
                      </div>

                      <div className="mt-4 pt-4 border-t border-gray-800">
                        <p className="text-xs text-gray-500">
                          Position ID: {pos.id} | Last Action: {new Date(pos.lastActionAt * 1000).toLocaleDateString()}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Closed Positions */}
            {result.positions.counts.closed > 0 && (
              <div className="bg-[#0A0A0A] border border-[#1A1A1A] rounded-xl p-6">
                <h2 className="text-xl font-bold mb-4">🔴 Closed Positions ({result.positions.counts.closed})</h2>
                <div className="space-y-4">
                  {result.positions.closed.map((pos: any, idx: number) => (
                    <div key={idx} className="bg-black p-6 rounded-lg border border-red-500/30">
                      <div className="flex justify-between items-start mb-4">
                        <div>
                          <div className="flex items-center gap-3 mb-2">
                            <span className="text-xl font-bold">{pos.pool.token0.symbol}/{pos.pool.token1.symbol}</span>
                            <span className="px-2 py-1 bg-blue-500/20 text-blue-400 text-xs rounded">{pos.protocol}</span>
                          </div>
                          <p className="text-sm text-gray-400">Closed on {new Date(pos.lastActionAt * 1000).toLocaleDateString()}</p>
                        </div>
                        <div className="text-right">
                          <p className="text-sm text-gray-400">Realized PnL</p>
                          <p className={`text-2xl font-bold ${pos.realizedPnl >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                            ${pos.realizedPnl?.toFixed(2) || '0.00'}
                          </p>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <p className="text-sm text-gray-400">Fees Earned</p>
                          <p className="font-bold text-blue-400">${pos.feesEarnedUsd?.toFixed(2) || '0.00'}</p>
                        </div>
                        <div>
                          <p className="text-sm text-gray-400">ROI</p>
                          <p className={`font-bold ${pos.roi >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                            {pos.roi?.toFixed(2) || '0.00'}%
                          </p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
