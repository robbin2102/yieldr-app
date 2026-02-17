'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
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

interface MarketPerformance {
  category: string;
  trades: number;
  wins: number;
  winRate: number;
  totalPnl: number;
}

interface HighConvictionTrade {
  timestamp: string;
  side: string;
  market: string;
  outcome: string;
  price: number;
  usdcSize: number;
  sizeMultiplier: number;
  txHash: string;
}

interface ClosedPosition {
  title: string;
  outcome: string;
  size: number;
  avgPrice: number;
  realizedPnl: number;
  timestamp: string;
  status: 'REDEEMED' | 'WON' | 'LOST';
}

interface PeriodInfo {
  requestedDays: number;
  actualDays: number;
  hitApiLimit: boolean;
  startDate: string | null;
  endDate: string | null;
  activitiesCount: number;
  lastActiveAt: string | null;
}

interface CashFlowPnL {
  totalPnl: number;
  totalBuys: number;
  totalSells: number;
  totalRedeems: number;
  endingValue: number;
  positionsWithActivity: number;
  wins: number;
  losses: number;
  winRate: number;
}

interface TraderProfile {
  wallet: string;
  label: string;
  profiledAt: string;
  periodDays: number;

  // Period coverage info (shows actual date range when API limit is hit)
  periodInfo?: PeriodInfo | null;

  // Cash Flow P&L - Most accurate calculation
  cashFlowPnL?: CashFlowPnL | null;

  // Activity stats
  totalActivities: number;
  buyCount: number;
  sellCount: number;
  redeemCount: number;

  // Classification
  tradesPerDay: number;
  volumeLabel: string;
  strategyLabel: string;
  buyRatio: number;

  // Performance (legacy - kept for backwards compatibility)
  closedPositionsCount: number;
  wins: number;
  losses: number;
  winRate: number;
  grossProfit: number;
  grossLoss: number;
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
  profitFactor: number;

  // Open positions
  openPositionsCount: number;
  openValue: number;
  unrealizedPnl: number;

  // Trade sizing
  avgTradeSize: number;
  medianTradeSize: number;
  maxTradeSize: number;

  // Specialty
  specialty: string | null;
  strengths: MarketPerformance[];
  weaknesses: MarketPerformance[];

  // High conviction
  asymmetricThreshold: number;
  asymmetricTradesCount: number;
  recentHighConvictionTrades: HighConvictionTrade[];

  // Top positions
  topOpenPositions: Position[];

  // Recent closed positions
  recentClosedPositions: ClosedPosition[];

  // Tracking status
  isTracking: boolean;
}

export default function TraderProfilePage() {
  const params = useParams();
  const router = useRouter();
  const wallet = params.wallet as string;

  const [profile, setProfile] = useState<TraderProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [profiling, setProfiling] = useState(false);
  const [labelInput, setLabelInput] = useState('');
  const [profileProgress, setProfileProgress] = useState('');

  useEffect(() => {
    fetchProfile();
  }, [wallet]);

  async function fetchProfile() {
    setLoading(true);
    setNotFound(false);
    setError(null);
    try {
      const response = await fetch(`/api/copy-trading/profile?wallet=${wallet}`);
      const data = await response.json();

      if (data.success) {
        setProfile(data.profile);
        setLabelInput(data.profile.label || '');
      } else if (response.status === 404 || data.error?.includes('not found')) {
        setNotFound(true);
        // Generate default label from wallet
        setLabelInput(`Trader_${wallet.slice(2, 8)}`);
      } else {
        setError(data.error || 'Failed to load profile');
      }
    } catch (err) {
      setError('Failed to load profile');
    } finally {
      setLoading(false);
    }
  }

  async function handleProfileTrader() {
    if (!labelInput.trim()) return;
    setProfiling(true);
    setProfileProgress('Fetching trading activity...');
    try {
      const response = await fetch('/api/copy-trading/profile-trader', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet, label: labelInput.trim() }),
      });
      setProfileProgress('Analyzing performance...');
      const data = await response.json();
      if (data.success) {
        setProfileProgress('Profile complete!');
        setNotFound(false);
        await fetchProfile();
      } else {
        setError(data.error || 'Failed to profile trader');
      }
    } catch (err) {
      setError('Failed to profile trader');
    } finally {
      setProfiling(false);
      setProfileProgress('');
    }
  }

  async function handleRefreshProfile() {
    setRefreshing(true);
    try {
      const response = await fetch('/api/copy-trading/profile-trader', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet, label: profile?.label }),
      });
      const data = await response.json();
      if (data.success) {
        await fetchProfile();
      }
    } catch (err) {
      console.error('Failed to refresh profile:', err);
    } finally {
      setRefreshing(false);
    }
  }

  async function handleToggleTracking() {
    if (!profile) return;
    try {
      await fetch('/api/copy-trading/traders', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wallet,
          action: profile.isTracking ? 'stopTracking' : 'startTracking',
        }),
      });
      await fetchProfile();
    } catch (err) {
      console.error('Failed to toggle tracking:', err);
    }
  }

  const formatValue = (v: number | undefined | null) => {
    if (v === undefined || v === null) return '$0.00';
    if (Math.abs(v) >= 1000000) return `$${(v / 1000000).toFixed(1)}M`;
    if (Math.abs(v) >= 1000) return `$${(v / 1000).toFixed(1)}K`;
    return `$${v.toFixed(2)}`;
  };

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  // Relative time for high conviction trades (converts to local time)
  const timeAgo = (dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);

    if (seconds < 60) return 'Just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
    // If older than 7 days, show date
    return formatDate(dateStr);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-green" />
      </div>
    );
  }

  // Profile not found - show profiling UI
  if (notFound) {
    return (
      <div className="space-y-6">
        <Link href="/copy-trading/traders" className="text-sm text-[#6E6E6E] hover:text-white">
          ← Back to Traders
        </Link>

        <div className="bg-[#0A0A0A] border border-[#1E1E1E] rounded-xl p-8">
          <div className="max-w-md mx-auto text-center">
            <div className="w-16 h-16 rounded-full bg-[#1A1A1A] flex items-center justify-center mx-auto mb-4">
              <span className="text-2xl">📊</span>
            </div>
            <h2 className="text-xl font-bold text-white mb-2">Profile This Trader</h2>
            <p className="text-sm text-[#6E6E6E] mb-6">
              Analyze this wallet&apos;s trading history to see win rate, P&L, market specialty, and high conviction trades.
            </p>

            <div className="text-xs text-[#6E6E6E] font-mono mb-6 break-all">
              {wallet}
            </div>

            {error && (
              <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 mb-4 text-red-400 text-sm">
                {error}
              </div>
            )}

            <div className="space-y-4">
              <div>
                <label className="block text-sm text-[#9E9E9E] mb-2 text-left">Label (for your reference)</label>
                <input
                  type="text"
                  value={labelInput}
                  onChange={(e) => setLabelInput(e.target.value)}
                  placeholder="e.g., Whale_Politics, High_WR_Crypto"
                  className="w-full px-4 py-3 bg-[#111] border border-[#2A2A2A] rounded-lg text-white text-sm placeholder-[#4E4E4E] focus:outline-none focus:border-primary-green"
                  disabled={profiling}
                />
              </div>

              <button
                onClick={handleProfileTrader}
                disabled={profiling || !labelInput.trim()}
                className="w-full px-6 py-3 bg-primary-green text-black text-sm font-semibold rounded-lg hover:bg-primary-green/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {profiling ? (
                  <span className="flex items-center justify-center gap-2">
                    <span className="animate-spin rounded-full h-4 w-4 border-b-2 border-black" />
                    {profileProgress || 'Profiling...'}
                  </span>
                ) : (
                  'Profile Trader'
                )}
              </button>

              <p className="text-xs text-[#4E4E4E]">
                This will analyze the last 30 days of trading activity. Takes 10-30 seconds.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Other errors
  if (error || !profile) {
    return (
      <div className="space-y-4">
        <Link href="/copy-trading/traders" className="text-sm text-[#6E6E6E] hover:text-white">
          ← Back to Traders
        </Link>
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-6 text-center">
          <div className="text-red-400 mb-2">{error || 'Failed to load profile'}</div>
          <button
            onClick={() => fetchProfile()}
            className="mt-2 px-4 py-2 bg-[#1A1A1A] text-[#9E9E9E] text-sm rounded-lg hover:bg-[#2A2A2A] transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <Link href="/copy-trading/traders" className="text-sm text-[#6E6E6E] hover:text-white mb-2 inline-block">
            ← Back to Traders
          </Link>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-white">{profile.label}</h1>
            {profile.isTracking && (
              <span className="px-2 py-1 text-xs bg-primary-green/20 text-primary-green rounded flex items-center gap-1.5">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary-green opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-primary-green"></span>
                </span>
                TRACKING
              </span>
            )}
          </div>
          <div className="text-xs text-[#6E6E6E] font-mono mt-1">{profile.wallet}</div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={handleRefreshProfile}
            disabled={refreshing}
            className="px-3 py-2 bg-[#1A1A1A] text-[#9E9E9E] text-sm font-medium rounded-lg hover:bg-[#2A2A2A] transition-colors disabled:opacity-50"
          >
            {refreshing ? 'Refreshing...' : '↻ Re-Profile'}
          </button>
          <button
            onClick={handleToggleTracking}
            className={`px-4 py-2 text-sm font-semibold rounded-lg transition-colors ${
              profile.isTracking
                ? 'bg-[#1A1A1A] text-[#9E9E9E] hover:bg-red-500/20 hover:text-red-400'
                : 'bg-primary-green text-black hover:bg-primary-green/90'
            }`}
          >
            {profile.isTracking ? 'Stop Tracking' : 'Start Tracking'}
          </button>
        </div>
      </div>

      {/* Profile Info */}
      <div className="text-xs text-[#6E6E6E]">
        Profiled {formatDate(profile.profiledAt)} • {profile.periodInfo?.hitApiLimit ? (
          <span className="text-yellow-500">
            ⚠️ {profile.periodInfo.actualDays.toFixed(1)} days of activity (API limit hit, requested {profile.periodDays}d)
          </span>
        ) : (
          `Last ${profile.periodDays} days of activity`
        )}
        {profile.periodInfo?.lastActiveAt && (
          <span className="ml-2">
            • Last active: {timeAgo(profile.periodInfo.lastActiveAt)}
          </span>
        )}
      </div>
      {profile.periodInfo?.hitApiLimit && profile.periodInfo.startDate && profile.periodInfo.endDate && (
        <div className="text-xs text-yellow-500/70">
          Data covers: {formatDate(profile.periodInfo.startDate)} → {formatDate(profile.periodInfo.endDate)}
        </div>
      )}

      {/* Key Stats Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
        <div className="bg-[#0A0A0A] border border-[#1E1E1E] rounded-xl p-4">
          <div className="text-xs text-[#6E6E6E] uppercase mb-1">Win Rate</div>
          <div className="text-xl font-bold text-white">
            {(profile.cashFlowPnL?.winRate ?? profile.winRate).toFixed(1)}%
          </div>
          <div className="text-xs text-[#6E6E6E]">
            {profile.cashFlowPnL?.wins ?? profile.wins}W / {profile.cashFlowPnL?.losses ?? profile.losses}L
          </div>
        </div>
        <div className="bg-[#0A0A0A] border border-[#1E1E1E] rounded-xl p-4">
          <div className="text-xs text-[#6E6E6E] uppercase mb-1">
            {profile.periodInfo?.actualDays ? `${profile.periodInfo.actualDays.toFixed(1)}D` : `${profile.periodDays}D`} P&L
          </div>
          <div className={`text-xl font-bold ${(profile.cashFlowPnL?.totalPnl ?? profile.realizedPnl) >= 0 ? 'text-primary-green' : 'text-red-400'}`}>
            {(profile.cashFlowPnL?.totalPnl ?? profile.realizedPnl) >= 0 ? '+' : ''}{formatValue(profile.cashFlowPnL?.totalPnl ?? profile.realizedPnl)}
          </div>
          <div className="text-xs text-[#6E6E6E]">{profile.cashFlowPnL?.positionsWithActivity ?? profile.closedPositionsCount} positions</div>
        </div>
        <div className="bg-[#0A0A0A] border border-[#1E1E1E] rounded-xl p-4">
          <div className="text-xs text-[#6E6E6E] uppercase mb-1">Profit Factor</div>
          <div className="text-xl font-bold text-white">{profile.profitFactor.toFixed(2)}</div>
          <div className="text-xs text-[#6E6E6E]">Gross P / L</div>
        </div>
        <div className="bg-[#0A0A0A] border border-[#1E1E1E] rounded-xl p-4">
          <div className="text-xs text-[#6E6E6E] uppercase mb-1">Open Value</div>
          <div className="text-xl font-bold text-white">{formatValue(profile.openValue)}</div>
          <div className={`text-xs ${profile.unrealizedPnl >= 0 ? 'text-primary-green' : 'text-red-400'}`}>
            {profile.unrealizedPnl >= 0 ? '+' : ''}{formatValue(profile.unrealizedPnl)} unrealized
          </div>
        </div>
        <div className="bg-[#0A0A0A] border border-[#1E1E1E] rounded-xl p-4">
          <div className="text-xs text-[#6E6E6E] uppercase mb-1">Avg Trade</div>
          <div className="text-xl font-bold text-white">{formatValue(profile.avgTradeSize)}</div>
          <div className="text-xs text-[#6E6E6E]">Median: {formatValue(profile.medianTradeSize)}</div>
        </div>
        <div className="bg-[#0A0A0A] border border-[#1E1E1E] rounded-xl p-4">
          <div className="text-xs text-[#6E6E6E] uppercase mb-1">Activity</div>
          <div className="text-xl font-bold text-white">{profile.tradesPerDay.toFixed(1)}/day</div>
          <div className="text-xs text-[#6E6E6E]">{profile.volumeLabel} volume</div>
        </div>
      </div>

      {/* Strategy & Specialty */}
      <div className="flex flex-wrap gap-2">
        <span className="px-3 py-1.5 text-sm bg-[#1A1A1A] text-[#9E9E9E] rounded-lg">
          {profile.strategyLabel.replace(/_/g, ' ')}
        </span>
        <span className="px-3 py-1.5 text-sm bg-[#1A1A1A] text-[#9E9E9E] rounded-lg">
          {profile.buyRatio.toFixed(0)}% Buys
        </span>
        {profile.specialty && (
          <span className="px-3 py-1.5 text-sm bg-primary-green/20 text-primary-green rounded-lg">
            {profile.specialty} Specialist
          </span>
        )}
      </div>

      {/* Two Column Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Strengths & Weaknesses */}
        <div className="space-y-4">
          {profile.strengths.length > 0 && (
            <div className="bg-[#0A0A0A] border border-[#1E1E1E] rounded-xl p-4">
              <h3 className="text-sm font-semibold text-white mb-3">Strengths (Profitable Markets)</h3>
              <div className="space-y-2">
                {profile.strengths.map((s, i) => (
                  <div key={i} className="flex items-center justify-between text-sm">
                    <div className="flex items-center gap-2">
                      <span className="text-primary-green">●</span>
                      <span className="text-white">{s.category}</span>
                      <span className="text-[#6E6E6E]">({s.trades} trades)</span>
                    </div>
                    <div className="text-right">
                      <span className="text-primary-green font-mono">+{formatValue(s.totalPnl)}</span>
                      <span className="text-[#6E6E6E] ml-2">{s.winRate.toFixed(0)}% WR</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {profile.weaknesses.length > 0 && (
            <div className="bg-[#0A0A0A] border border-[#1E1E1E] rounded-xl p-4">
              <h3 className="text-sm font-semibold text-white mb-3">Weaknesses (Losing Markets)</h3>
              <div className="space-y-2">
                {profile.weaknesses.map((w, i) => (
                  <div key={i} className="flex items-center justify-between text-sm">
                    <div className="flex items-center gap-2">
                      <span className="text-red-400">●</span>
                      <span className="text-white">{w.category}</span>
                      <span className="text-[#6E6E6E]">({w.trades} trades)</span>
                    </div>
                    <div className="text-right">
                      <span className="text-red-400 font-mono">{formatValue(w.totalPnl)}</span>
                      <span className="text-[#6E6E6E] ml-2">{w.winRate.toFixed(0)}% WR</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Open Positions */}
        <div className="bg-[#0A0A0A] border border-[#1E1E1E] rounded-xl p-4">
          <h3 className="text-sm font-semibold text-white mb-3">
            Top Open Positions ({profile.openPositionsCount} total)
          </h3>
          <div className="space-y-2 max-h-[300px] overflow-y-auto">
            {profile.topOpenPositions.length > 0 ? (
              profile.topOpenPositions.map((pos, i) => (
                <div key={i} className="bg-[#111] rounded-lg p-3">
                  <div className="flex items-start justify-between">
                    <div className="flex-1 min-w-0">
                      <div className="text-xs text-[#6E6E6E] truncate">{pos.title}</div>
                      <div className="text-sm text-white">{pos.outcome}</div>
                    </div>
                    <div className="text-right ml-2">
                      <div className={`text-sm font-mono ${pos.cashPnl >= 0 ? 'text-primary-green' : 'text-red-400'}`}>
                        {pos.cashPnl >= 0 ? '+' : ''}{formatValue(pos.cashPnl)}
                      </div>
                      <div className="text-xs text-[#6E6E6E]">{formatValue(pos.currentValue)}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 mt-2 text-xs text-[#6E6E6E]">
                    <span>Entry: {((pos.avgPrice ?? 0) * 100).toFixed(0)}¢</span>
                    <span>→</span>
                    <span>Now: {((pos.curPrice ?? 0) * 100).toFixed(0)}¢</span>
                    <span className="ml-auto">{(pos.size ?? 0).toFixed(0)} shares</span>
                  </div>
                </div>
              ))
            ) : (
              <div className="text-sm text-[#4E4E4E] text-center py-4">No open positions</div>
            )}
          </div>
        </div>
      </div>

      {/* Recent Closed Positions */}
      {profile.recentClosedPositions && profile.recentClosedPositions.length > 0 && (
        <div className="bg-[#0A0A0A] border border-[#1E1E1E] rounded-xl p-4">
          <h3 className="text-sm font-semibold text-white mb-3">
            Recent Closed Positions
          </h3>
          <div className="space-y-2 max-h-[300px] overflow-y-auto">
            {profile.recentClosedPositions.map((pos, i) => (
              <div key={i} className="bg-[#111] rounded-lg p-3">
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`px-1.5 py-0.5 text-[10px] font-semibold rounded ${
                        pos.status === 'WON' || (pos.status === 'REDEEMED' && pos.realizedPnl >= 0)
                          ? 'bg-primary-green/20 text-primary-green'
                          : 'bg-red-500/20 text-red-400'
                      }`}>
                        {pos.status}
                      </span>
                      <span className="text-xs text-[#6E6E6E]">{timeAgo(pos.timestamp)}</span>
                    </div>
                    <div className="text-xs text-[#6E6E6E] truncate">{pos.title}</div>
                    <div className="text-sm text-white">{pos.outcome}</div>
                  </div>
                  <div className="text-right ml-2">
                    <div className={`text-sm font-mono ${pos.realizedPnl >= 0 ? 'text-primary-green' : 'text-red-400'}`}>
                      {pos.realizedPnl >= 0 ? '+' : ''}{formatValue(pos.realizedPnl)}
                    </div>
                    <div className="text-xs text-[#6E6E6E]">
                      {(pos.size ?? 0).toFixed(0)} @ {((pos.avgPrice ?? 0) * 100).toFixed(0)}¢
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* High Conviction Trades */}
      {profile.recentHighConvictionTrades.length > 0 && (
        <div className="bg-[#0A0A0A] border border-[#1E1E1E] rounded-xl p-4">
          <h3 className="text-sm font-semibold text-white mb-1">
            High Conviction Trades ({profile.asymmetricTradesCount} total)
          </h3>
          <p className="text-xs text-[#6E6E6E] mb-4">
            Trades &gt;{profile.asymmetricThreshold?.toFixed(0)}x average size ({formatValue(profile.avgTradeSize)} avg)
          </p>
          <div className="space-y-2 max-h-[400px] overflow-y-auto">
            {profile.recentHighConvictionTrades.map((trade, i) => (
              <div key={i} className="bg-[#111] rounded-lg p-3">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className={`px-2 py-0.5 text-xs font-semibold rounded ${
                      trade.side === 'BUY' ? 'bg-primary-green/20 text-primary-green' : 'bg-red-500/20 text-red-400'
                    }`}>
                      {trade.side}
                    </span>
                    <span className="text-sm font-mono text-white">{formatValue(trade.usdcSize)}</span>
                    <span className="text-xs text-orange-400">🔥 {(trade.sizeMultiplier ?? 0).toFixed(0)}x</span>
                  </div>
                  <div className="text-xs text-[#6E6E6E]">
                    {timeAgo(trade.timestamp)}
                  </div>
                </div>
                <div className="text-xs text-[#6E6E6E] truncate">{trade.market}</div>
                <div className="text-sm text-white">{trade.outcome}</div>
                <div className="flex items-center justify-between mt-2 text-xs text-[#6E6E6E]">
                  <span>Entry: {((trade.price ?? 0) * 100).toFixed(0)}¢</span>
                  <a
                    href={`https://polygonscan.com/tx/${trade.txHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary-green hover:underline"
                  >
                    View TX →
                  </a>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

    </div>
  );
}
