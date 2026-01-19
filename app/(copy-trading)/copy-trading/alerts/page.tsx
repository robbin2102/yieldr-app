'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

interface Alert {
  _id: string;
  traderWallet: string;
  traderLabel: string;
  type: string;
  side?: string;
  title: string;
  outcome?: string;
  price?: number;
  usdcSize: number;
  timestamp: Date;
  isHighConviction?: boolean;
  sizeMultiplier?: number;
  copyRecommendation?: string;
  acknowledged?: boolean;
  copied?: boolean;
}

// Filter options
const SIDE_OPTIONS = ['ALL', 'BUY', 'SELL'];
const TYPE_OPTIONS = ['ALL', 'TRADE', 'REDEEM', 'MERGE', 'SPLIT'];

export default function AlertsPage() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);
  const [sideFilter, setSideFilter] = useState('ALL');
  const [typeFilter, setTypeFilter] = useState('TRADE');
  const [traderFilter, setTraderFilter] = useState('ALL');
  const [traders, setTraders] = useState<string[]>([]);

  useEffect(() => {
    async function fetchAlerts() {
      try {
        const params = new URLSearchParams({ limit: '100' });
        if (typeFilter !== 'ALL') params.set('type', typeFilter);

        const response = await fetch(`/api/copy-trading/alerts?${params}`);
        const data = await response.json();

        if (data.success) {
          setAlerts(data.alerts);

          // Extract unique traders
          const uniqueTraders = [...new Set(data.alerts.map((a: Alert) => a.traderLabel))];
          setTraders(uniqueTraders as string[]);
        }
      } catch (error) {
        console.error('Failed to fetch alerts:', error);
      } finally {
        setLoading(false);
      }
    }

    fetchAlerts();
  }, [typeFilter]);

  // Filter alerts
  const filteredAlerts = alerts.filter(alert => {
    if (sideFilter !== 'ALL' && alert.side !== sideFilter) return false;
    if (traderFilter !== 'ALL' && alert.traderLabel !== traderFilter) return false;
    return true;
  });

  const handleAction = async (alertId: string, action: 'acknowledge' | 'copy' | 'skip') => {
    try {
      await fetch('/api/copy-trading/alerts', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertId, action }),
      });

      // Update local state
      setAlerts(prev => prev.map(a =>
        a._id === alertId
          ? { ...a, acknowledged: true, copied: action === 'copy' }
          : a
      ));
    } catch (error) {
      console.error('Failed to update alert:', error);
    }
  };

  const timeAgo = (date: Date) => {
    const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
    if (seconds < 60) return `${seconds}s`;
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
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">Trade Alerts</h1>
        <div className="text-sm text-[#6E6E6E]">
          {filteredAlerts.length} alerts
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-4 p-4 bg-[#0A0A0A] border border-[#1E1E1E] rounded-xl">
        {/* Side filter */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-[#6E6E6E] uppercase">Side:</span>
          <div className="flex gap-1">
            {SIDE_OPTIONS.map(option => (
              <button
                key={option}
                onClick={() => setSideFilter(option)}
                className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                  sideFilter === option
                    ? 'bg-primary-green/20 text-primary-green'
                    : 'bg-[#1A1A1A] text-[#9E9E9E] hover:bg-[#2A2A2A]'
                }`}
              >
                {option}
              </button>
            ))}
          </div>
        </div>

        {/* Type filter */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-[#6E6E6E] uppercase">Type:</span>
          <div className="flex gap-1">
            {TYPE_OPTIONS.map(option => (
              <button
                key={option}
                onClick={() => setTypeFilter(option)}
                className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                  typeFilter === option
                    ? 'bg-primary-green/20 text-primary-green'
                    : 'bg-[#1A1A1A] text-[#9E9E9E] hover:bg-[#2A2A2A]'
                }`}
              >
                {option}
              </button>
            ))}
          </div>
        </div>

        {/* Trader filter */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-[#6E6E6E] uppercase">Trader:</span>
          <select
            value={traderFilter}
            onChange={(e) => setTraderFilter(e.target.value)}
            className="px-3 py-1 text-xs font-medium rounded-md bg-[#1A1A1A] text-[#9E9E9E] border border-[#2A2A2A] focus:outline-none focus:border-primary-green"
          >
            <option value="ALL">All Traders</option>
            {traders.map(trader => (
              <option key={trader} value={trader}>{trader}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Alerts Table */}
      <div className="bg-[#0A0A0A] border border-[#1E1E1E] rounded-xl overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-[#1E1E1E]">
              <th className="px-4 py-3 text-left text-xs font-semibold text-[#6E6E6E] uppercase">Time</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-[#6E6E6E] uppercase">Trader</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-[#6E6E6E] uppercase">Side</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-[#6E6E6E] uppercase">Market</th>
              <th className="px-4 py-3 text-right text-xs font-semibold text-[#6E6E6E] uppercase">Size</th>
              <th className="px-4 py-3 text-right text-xs font-semibold text-[#6E6E6E] uppercase">Price</th>
              <th className="px-4 py-3 text-center text-xs font-semibold text-[#6E6E6E] uppercase">Status</th>
              <th className="px-4 py-3 text-right text-xs font-semibold text-[#6E6E6E] uppercase">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredAlerts.map((alert) => (
              <tr
                key={alert._id}
                className={`border-b border-[#1E1E1E] hover:bg-[#111] transition-colors ${
                  alert.acknowledged ? 'opacity-50' : ''
                }`}
              >
                <td className="px-4 py-3 text-sm text-[#9E9E9E] font-mono">
                  {timeAgo(alert.timestamp)}
                </td>
                <td className="px-4 py-3">
                  <Link
                    href={`/copy-trading/traders/${alert.traderWallet}`}
                    className="text-sm text-white hover:text-primary-green transition-colors"
                  >
                    {alert.traderLabel}
                  </Link>
                </td>
                <td className="px-4 py-3">
                  <span className={`text-sm font-semibold ${
                    alert.side === 'BUY' ? 'text-primary-green' : 'text-red-400'
                  }`}>
                    {alert.side || alert.type}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <div className="text-sm text-white truncate max-w-[200px]">
                    {alert.title?.substring(0, 35)}...
                  </div>
                  <div className="text-xs text-[#6E6E6E]">
                    {alert.outcome}
                  </div>
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="text-sm text-white font-mono">
                    ${alert.usdcSize?.toFixed(2)}
                  </div>
                  {alert.isHighConviction && (
                    <div className="text-xs text-orange-500">
                      🔥 {alert.sizeMultiplier?.toFixed(0)}x
                    </div>
                  )}
                </td>
                <td className="px-4 py-3 text-right text-sm text-[#9E9E9E] font-mono">
                  {((alert.price || 0) * 100).toFixed(0)}¢
                </td>
                <td className="px-4 py-3 text-center">
                  {alert.copied ? (
                    <span className="px-2 py-1 text-xs font-medium rounded-full bg-primary-green/20 text-primary-green">
                      COPIED
                    </span>
                  ) : alert.acknowledged ? (
                    <span className="px-2 py-1 text-xs font-medium rounded-full bg-[#2A2A2A] text-[#6E6E6E]">
                      SKIPPED
                    </span>
                  ) : (
                    <span className="px-2 py-1 text-xs font-medium rounded-full bg-yellow-500/20 text-yellow-500">
                      PENDING
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-right">
                  {!alert.acknowledged && (
                    <div className="flex justify-end gap-2">
                      <button
                        onClick={() => handleAction(alert._id, 'copy')}
                        className="px-2 py-1 text-xs font-medium rounded-md bg-primary-green/20 text-primary-green hover:bg-primary-green/30 transition-colors"
                      >
                        COPY
                      </button>
                      <button
                        onClick={() => handleAction(alert._id, 'skip')}
                        className="px-2 py-1 text-xs font-medium rounded-md bg-[#1A1A1A] text-[#6E6E6E] hover:bg-[#2A2A2A] transition-colors"
                      >
                        SKIP
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {filteredAlerts.length === 0 && (
          <div className="p-8 text-center">
            <div className="text-[#6E6E6E] text-sm">No alerts found</div>
            <div className="text-[#4E4E4E] text-xs mt-1">
              Try adjusting your filters
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
