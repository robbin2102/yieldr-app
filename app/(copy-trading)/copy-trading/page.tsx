'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

// Types
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
}

interface TrackedTrader {
  _id: string;
  wallet: string;
  label: string;
  lastSeenTimestamp?: number;
  isActive: boolean;
}

interface Position {
  title: string;
  outcome: string;
  avgPrice: number;
  curPrice: number;
  size: number;
  initialValue: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
  matchedTrader?: string;
}

interface SummaryStats {
  totalPnl: number;
  openValue: number;
  pendingAlerts: number;
  trackedTraders: number;
  activeTraders: number;
}

// Summary Card Component
function SummaryCard({
  label,
  value,
  subtext,
  trend,
}: {
  label: string;
  value: string;
  subtext?: string;
  trend?: 'up' | 'down' | 'neutral';
}) {
  const trendColors = {
    up: 'text-primary-green',
    down: 'text-red-500',
    neutral: 'text-[#9E9E9E]',
  };

  return (
    <div className="bg-[#0A0A0A] border border-[#1E1E1E] rounded-xl p-5 hover:border-[#2A2A2A] transition-colors">
      <div className="text-xs font-semibold text-[#6E6E6E] uppercase tracking-wider mb-2">
        {label}
      </div>
      <div className={`text-2xl font-bold ${trend ? trendColors[trend] : 'text-white'}`}>
        {value}
      </div>
      {subtext && (
        <div className="text-xs text-[#6E6E6E] mt-1">{subtext}</div>
      )}
    </div>
  );
}

// Alert Card Component
function AlertCard({ alert }: { alert: Alert }) {
  const timeAgo = (date: Date) => {
    const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  };

  const sideColor = alert.side === 'BUY' ? 'text-primary-green' : 'text-red-400';

  return (
    <div className="bg-[#0A0A0A] border border-[#1E1E1E] rounded-lg p-4 hover:border-[#2A2A2A] transition-colors">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-primary-green" />
          <span className="font-semibold text-white">{alert.traderLabel}</span>
        </div>
        <span className="text-xs text-[#6E6E6E]">{timeAgo(alert.timestamp)}</span>
      </div>

      <div className="mb-2">
        <span className={`font-semibold ${sideColor}`}>{alert.side}</span>
        <span className="text-[#9E9E9E] ml-2">{alert.title?.substring(0, 40)}...</span>
      </div>

      <div className="flex items-center justify-between">
        <div className="text-sm">
          <span className="text-white">{alert.outcome}</span>
          <span className="text-[#6E6E6E] ml-2">@ {((alert.price || 0) * 100).toFixed(0)}¢</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-white font-mono">${alert.usdcSize?.toFixed(2)}</span>
          {alert.isHighConviction && (
            <span className="text-orange-500" title="High Conviction">🔥</span>
          )}
        </div>
      </div>

      <div className="flex gap-2 mt-3">
        <button className="flex-1 px-3 py-1.5 bg-primary-green/10 text-primary-green text-xs font-semibold rounded-md hover:bg-primary-green/20 transition-colors">
          COPY
        </button>
        <button className="px-3 py-1.5 bg-[#1A1A1A] text-[#9E9E9E] text-xs font-semibold rounded-md hover:bg-[#2A2A2A] transition-colors">
          SKIP
        </button>
        <Link
          href={`/copy-trading/traders/${alert.traderWallet}`}
          className="px-3 py-1.5 bg-[#1A1A1A] text-[#9E9E9E] text-xs font-semibold rounded-md hover:bg-[#2A2A2A] transition-colors"
        >
          VIEW
        </Link>
      </div>
    </div>
  );
}

// Trader Mini Card Component
function TraderMiniCard({ trader }: { trader: TrackedTrader }) {
  const lastActive = trader.lastSeenTimestamp
    ? new Date(trader.lastSeenTimestamp * 1000)
    : null;

  const timeAgo = (date: Date | null) => {
    if (!date) return 'Never';
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 60) return 'Active now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  };

  const isRecentlyActive = lastActive && (Date.now() - lastActive.getTime()) < 3600000;

  return (
    <div className="bg-[#0A0A0A] border border-[#1E1E1E] rounded-lg p-4 hover:border-[#2A2A2A] transition-colors">
      <div className="flex items-center justify-between mb-2">
        <span className="font-semibold text-white">{trader.label}</span>
        <div className="flex items-center gap-1.5">
          <div className={`w-2 h-2 rounded-full ${isRecentlyActive ? 'bg-primary-green' : 'bg-[#6E6E6E]'}`} />
          <span className="text-xs text-[#6E6E6E]">{timeAgo(lastActive)}</span>
        </div>
      </div>
      <div className="text-xs text-[#6E6E6E] font-mono truncate">
        {trader.wallet.slice(0, 10)}...{trader.wallet.slice(-8)}
      </div>
      <Link
        href={`/copy-trading/traders/${trader.wallet}`}
        className="block mt-3 text-center px-3 py-1.5 bg-[#1A1A1A] text-[#9E9E9E] text-xs font-semibold rounded-md hover:bg-[#2A2A2A] transition-colors"
      >
        View Profile
      </Link>
    </div>
  );
}

// Position Group Component
function PositionGroup({
  traderLabel,
  positions,
}: {
  traderLabel: string;
  positions: Position[];
}) {
  const totalPnl = positions.reduce((sum, p) => sum + p.cashPnl, 0);
  const [isExpanded, setIsExpanded] = useState(true);

  return (
    <div className="bg-[#0A0A0A] border border-[#1E1E1E] rounded-lg overflow-hidden">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center justify-between p-4 hover:bg-[#111] transition-colors"
      >
        <div className="flex items-center gap-3">
          <span className="font-semibold text-white">{traderLabel}</span>
          <span className="text-xs text-[#6E6E6E]">{positions.length} positions</span>
        </div>
        <div className="flex items-center gap-3">
          <span className={`font-mono font-semibold ${totalPnl >= 0 ? 'text-primary-green' : 'text-red-400'}`}>
            {totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}
          </span>
          <span className="text-[#6E6E6E]">{isExpanded ? '▲' : '▼'}</span>
        </div>
      </button>

      {isExpanded && (
        <div className="border-t border-[#1E1E1E]">
          {positions.map((pos, idx) => (
            <div
              key={idx}
              className="flex items-center justify-between px-4 py-3 border-b border-[#1E1E1E] last:border-b-0 hover:bg-[#111] transition-colors"
            >
              <div>
                <div className="text-sm text-white">{pos.title?.substring(0, 35)}...</div>
                <div className="text-xs text-[#6E6E6E]">
                  {pos.outcome} @ {(pos.avgPrice * 100).toFixed(0)}¢ → {(pos.curPrice * 100).toFixed(0)}¢
                </div>
              </div>
              <div className="text-right">
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
}

// Main Dashboard Component
export default function CopyTradingDashboard() {
  const [stats, setStats] = useState<SummaryStats>({
    totalPnl: 0,
    openValue: 0,
    pendingAlerts: 0,
    trackedTraders: 0,
    activeTraders: 0,
  });
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [traders, setTraders] = useState<TrackedTrader[]>([]);
  const [positions, setPositions] = useState<Record<string, Position[]>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      try {
        // Fetch all data in parallel
        const [alertsRes, tradersRes, positionsRes] = await Promise.all([
          fetch('/api/copy-trading/alerts?limit=10'),
          fetch('/api/copy-trading/traders'),
          fetch('/api/copy-trading/positions'),
        ]);

        const alertsData = await alertsRes.json();
        const tradersData = await tradersRes.json();
        const positionsData = await positionsRes.json();

        setAlerts(alertsData.alerts || []);
        setTraders(tradersData.traders || []);
        setPositions(positionsData.positionsByTrader || {});

        // Calculate stats
        const totalPnl = Object.values(positionsData.positionsByTrader || {})
          .flat()
          .reduce((sum: number, p: any) => sum + (p.cashPnl || 0), 0);

        const openValue = Object.values(positionsData.positionsByTrader || {})
          .flat()
          .reduce((sum: number, p: any) => sum + (p.currentValue || 0), 0);

        const activeTraders = (tradersData.traders || []).filter((t: TrackedTrader) => {
          if (!t.lastSeenTimestamp) return false;
          return Date.now() - t.lastSeenTimestamp * 1000 < 3600000;
        }).length;

        setStats({
          totalPnl,
          openValue,
          pendingAlerts: alertsData.alerts?.length || 0,
          trackedTraders: tradersData.traders?.length || 0,
          activeTraders,
        });
      } catch (error) {
        console.error('Failed to fetch dashboard data:', error);
      } finally {
        setLoading(false);
      }
    }

    fetchData();

    // Poll for updates every 60 seconds
    const interval = setInterval(fetchData, 60000);
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-green" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <SummaryCard
          label="Total P&L"
          value={`${stats.totalPnl >= 0 ? '+' : ''}$${stats.totalPnl.toFixed(2)}`}
          trend={stats.totalPnl >= 0 ? 'up' : 'down'}
        />
        <SummaryCard
          label="Open Value"
          value={`$${stats.openValue.toFixed(2)}`}
          subtext={`${Object.values(positions).flat().length} positions`}
        />
        <SummaryCard
          label="Pending Alerts"
          value={String(stats.pendingAlerts)}
          subtext="last hour"
        />
        <SummaryCard
          label="Tracked Traders"
          value={String(stats.trackedTraders)}
          subtext={`${stats.activeTraders} active`}
        />
      </div>

      {/* Main Content Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Live Alerts */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-white flex items-center gap-2">
              <span>🔔</span> Live Alerts
            </h2>
            <Link
              href="/copy-trading/alerts"
              className="text-sm text-primary-green hover:underline"
            >
              View All →
            </Link>
          </div>

          <div className="space-y-3">
            {alerts.length > 0 ? (
              alerts.slice(0, 5).map((alert) => (
                <AlertCard key={alert._id} alert={alert} />
              ))
            ) : (
              <div className="bg-[#0A0A0A] border border-[#1E1E1E] rounded-lg p-8 text-center">
                <div className="text-[#6E6E6E] text-sm">No recent alerts</div>
                <div className="text-[#4E4E4E] text-xs mt-1">
                  Alerts will appear when tracked traders make trades
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Positions by Trader */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-white flex items-center gap-2">
              <span>💰</span> My Positions
            </h2>
            <Link
              href="/copy-trading/positions"
              className="text-sm text-primary-green hover:underline"
            >
              View All →
            </Link>
          </div>

          <div className="space-y-3">
            {Object.keys(positions).length > 0 ? (
              Object.entries(positions).slice(0, 3).map(([label, pos]) => (
                <PositionGroup
                  key={label}
                  traderLabel={label}
                  positions={pos}
                />
              ))
            ) : (
              <div className="bg-[#0A0A0A] border border-[#1E1E1E] rounded-lg p-8 text-center">
                <div className="text-[#6E6E6E] text-sm">No positions yet</div>
                <div className="text-[#4E4E4E] text-xs mt-1">
                  Copy trades from alerts to build your portfolio
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Tracked Traders */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white flex items-center gap-2">
            <span>👥</span> Tracked Traders
          </h2>
          <Link
            href="/copy-trading/traders"
            className="text-sm text-primary-green hover:underline"
          >
            Manage →
          </Link>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {traders.length > 0 ? (
            traders.slice(0, 4).map((trader) => (
              <TraderMiniCard key={trader._id} trader={trader} />
            ))
          ) : (
            <div className="col-span-full bg-[#0A0A0A] border border-[#1E1E1E] rounded-lg p-8 text-center">
              <div className="text-[#6E6E6E] text-sm">No traders tracked</div>
              <Link
                href="/copy-trading/traders"
                className="inline-block mt-3 px-4 py-2 bg-primary-green text-black text-sm font-semibold rounded-lg hover:bg-primary-green/90 transition-colors"
              >
                + Add Trader
              </Link>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
