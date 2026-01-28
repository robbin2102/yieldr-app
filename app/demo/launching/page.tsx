'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAccount } from 'wagmi';
import { useRouter } from 'next/navigation';

interface LogStep {
  id: number;
  text: string;
  detail?: string;
  status: 'pending' | 'loading' | 'success';
}

interface PositionData {
  avantis: number;
  hyperliquid: number;
  polymarket: number;
  totalValue: number;
}

interface TraderData {
  wallets: string[];
  count: number;
}

export default function LaunchingPage() {
  const router = useRouter();
  const { address, isConnected } = useAccount();
  const [agentName, setAgentName] = useState('AlphaHunter');
  const [progress, setProgress] = useState(0);
  const [isReady, setIsReady] = useState(false);
  const [showDiscovery, setShowDiscovery] = useState(false);
  const [showCTA, setShowCTA] = useState(false);

  const [logs, setLogs] = useState<LogStep[]>([
    { id: 1, text: 'Initializing agent', status: 'pending' },
    { id: 2, text: 'Connecting wallet', status: 'pending' },
    { id: 3, text: 'Loading market context', status: 'pending' },
    { id: 4, text: 'Scanning positions', status: 'pending' },
    { id: 5, text: 'Following top traders', status: 'pending' },
  ]);

  const [positionData, setPositionData] = useState<PositionData>({
    avantis: 0,
    hyperliquid: 0,
    polymarket: 0,
    totalValue: 0,
  });

  const [traderData, setTraderData] = useState<TraderData>({
    wallets: [],
    count: 0,
  });

  // Load setup data
  useEffect(() => {
    const setup = localStorage.getItem('agentSetup');
    if (setup) {
      const data = JSON.parse(setup);
      if (data.name) setAgentName(data.name);
    }

    // Redirect if no wallet connected
    if (!isConnected) {
      router.push('/demo');
    }
  }, [isConnected, router]);

  const shortWallet = address
    ? `${address.slice(0, 6)}...${address.slice(-4)}`
    : '';

  const updateLog = useCallback((id: number, updates: Partial<LogStep>) => {
    setLogs(prev =>
      prev.map(log => (log.id === id ? { ...log, ...updates } : log))
    );
  }, []);

  // Scan positions from MCP server
  const scanPositions = useCallback(async () => {
    if (!address) return { avantis: 0, hyperliquid: 0, polymarket: 0, totalValue: 0 };

    const mcpUrl = process.env.NEXT_PUBLIC_MCP_SERVER_URL || 'https://mcp-demo-production-59da.up.railway.app';

    try {
      // Fetch positions in parallel
      const [avantisRes, hlRes, pmRes] = await Promise.allSettled([
        fetch(`${mcpUrl}/tools/get_avantis_live_positions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ walletAddress: address }),
        }),
        fetch(`${mcpUrl}/tools/get_hl_live_positions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ walletAddress: address }),
        }),
        fetch(`${mcpUrl}/tools/get_pm_live_positions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ walletAddress: address }),
        }),
      ]);

      let avantisCount = 0, hlCount = 0, pmCount = 0, totalValue = 0;

      if (avantisRes.status === 'fulfilled' && avantisRes.value.ok) {
        const data = await avantisRes.value.json();
        avantisCount = data.totalPositions || 0;
        totalValue += data.summary?.totalMargin || 0;
      }

      if (hlRes.status === 'fulfilled' && hlRes.value.ok) {
        const data = await hlRes.value.json();
        hlCount = data.totalPositions || 0;
        totalValue += data.summary?.accountValue || 0;
      }

      if (pmRes.status === 'fulfilled' && pmRes.value.ok) {
        const data = await pmRes.value.json();
        pmCount = data.totalPositions || 0;
        totalValue += data.summary?.totalValue || 0;
      }

      return { avantis: avantisCount, hyperliquid: hlCount, polymarket: pmCount, totalValue };
    } catch (error) {
      console.error('Error scanning positions:', error);
      return { avantis: 0, hyperliquid: 0, polymarket: 0, totalValue: 0 };
    }
  }, [address]);

  // Fetch top traders to follow
  const fetchTopTraders = useCallback(async () => {
    const mcpUrl = process.env.NEXT_PUBLIC_MCP_SERVER_URL || 'https://mcp-demo-production-59da.up.railway.app';

    try {
      const [perpRes, pmRes] = await Promise.allSettled([
        fetch(`${mcpUrl}/tools/get_top_perp_traders`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sortBy: 'totalPnl', limit: 3 }),
        }),
        fetch(`${mcpUrl}/tools/get_top_pm_traders`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sortBy: 'netPnl', limit: 3 }),
        }),
      ]);

      const wallets: string[] = [];

      if (perpRes.status === 'fulfilled' && perpRes.value.ok) {
        const data = await perpRes.value.json();
        (data.traders || []).forEach((t: any) => {
          if (t.wallet && !wallets.includes(t.wallet)) {
            wallets.push(t.wallet);
          }
        });
      }

      if (pmRes.status === 'fulfilled' && pmRes.value.ok) {
        const data = await pmRes.value.json();
        (data.traders || []).forEach((t: any) => {
          if (t.wallet && !wallets.includes(t.wallet)) {
            wallets.push(t.wallet);
          }
        });
      }

      return { wallets, count: wallets.length };
    } catch (error) {
      console.error('Error fetching traders:', error);
      return { wallets: [], count: 0 };
    }
  }, []);

  // Save agent to database
  const saveAgent = useCallback(async (positions: PositionData, traders: TraderData) => {
    if (!address) return;

    try {
      const setup = JSON.parse(localStorage.getItem('agentSetup') || '{}');

      await fetch('/api/demo/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: agentName,
          ownerWallet: address,
          goals: setup.goals || ['invest'],
          positions,
          followedTraders: traders.wallets,
        }),
      });
    } catch (error) {
      console.error('Error saving agent:', error);
    }
  }, [address, agentName]);

  // Run the animation sequence
  useEffect(() => {
    if (!address) return;

    const runSequence = async () => {
      // Step 1: Initialize
      updateLog(1, { status: 'loading' });
      await new Promise(r => setTimeout(r, 1000));
      updateLog(1, { status: 'success' });
      setProgress(20);

      // Step 2: Connect wallet
      updateLog(2, { status: 'loading' });
      await new Promise(r => setTimeout(r, 800));
      updateLog(2, { status: 'success', detail: shortWallet });
      setProgress(40);

      // Step 3: Load market context
      updateLog(3, { status: 'loading' });
      await new Promise(r => setTimeout(r, 1200));
      updateLog(3, { status: 'success', detail: 'BTC, ETH, SOL trends loaded' });
      setProgress(60);

      // Step 4: Scan positions
      updateLog(4, { status: 'loading' });
      const positions = await scanPositions();
      setPositionData(positions);

      const perpCount = positions.avantis + positions.hyperliquid;
      let posDetail = '';
      if (perpCount > 0 && positions.polymarket > 0) {
        posDetail = `Found ${perpCount} positions on Avantis + Hyperliquid\nFound ${positions.polymarket} positions on Polymarket`;
      } else if (perpCount > 0) {
        posDetail = `Found ${perpCount} positions on Avantis + Hyperliquid`;
      } else if (positions.polymarket > 0) {
        posDetail = `Found ${positions.polymarket} positions on Polymarket`;
      } else {
        posDetail = 'No positions found';
      }

      updateLog(4, { status: 'success', detail: posDetail });
      setProgress(80);

      // Step 5: Follow traders
      updateLog(5, { status: 'loading' });
      const traders = await fetchTopTraders();
      setTraderData(traders);

      let traderDetail = '';
      if (traders.wallets.length > 3) {
        const shortWallets = traders.wallets.slice(0, 3).map(w => `${w.slice(0, 6)}...${w.slice(-2)}`);
        traderDetail = `${shortWallets.join(', ')} +${traders.wallets.length - 3} more`;
      } else if (traders.wallets.length > 0) {
        traderDetail = traders.wallets.map(w => `${w.slice(0, 6)}...${w.slice(-2)}`).join(', ');
      } else {
        traderDetail = 'Following default traders';
      }

      updateLog(5, { status: 'success', detail: traderDetail });
      setProgress(100);

      // Save agent
      await saveAgent(positions, traders);

      // Show completion
      await new Promise(r => setTimeout(r, 500));
      setIsReady(true);
      setShowDiscovery(true);

      await new Promise(r => setTimeout(r, 500));
      setShowCTA(true);
    };

    runSequence();
  }, [address, shortWallet, scanPositions, fetchTopTraders, saveAgent, updateLog]);

  const handleLetsGo = () => {
    // Save completion state
    localStorage.setItem('agentCreated', JSON.stringify({
      name: agentName,
      wallet: address,
      traders: traderData.wallets,
      positions: positionData,
      createdAt: Date.now(),
    }));

    router.push('/demo/chat');
  };

  const totalPositions = positionData.avantis + positionData.hyperliquid + positionData.polymarket;

  return (
    <div className="min-h-screen flex items-center justify-center p-4 md:p-8">
      <div className="max-w-[480px] w-full bg-[#0A0A0A] border border-[#1E1E1E] rounded-2xl p-8 shadow-2xl">
        {/* Agent Avatar */}
        <div className="flex justify-center mb-6">
          <div
            className={`w-20 h-20 rounded-[20px] flex items-center justify-center text-4xl relative ${
              isReady
                ? 'bg-gradient-to-br from-[#00C805] to-[#0088FF] shadow-[0_0_30px_rgba(0,200,5,0.3)]'
                : 'bg-gradient-to-br from-[#00C805] to-[#0088FF] animate-pulse'
            }`}
          >
            🤖
            {isReady && (
              <>
                <span className="absolute -top-2 -right-2 text-base animate-bounce">✨</span>
                <span className="absolute -bottom-2 -left-2 text-base animate-bounce delay-150">✨</span>
              </>
            )}
          </div>
        </div>

        {/* Title */}
        <h1 className="text-center text-2xl font-bold mb-2">
          {isReady ? (
            <>{agentName} is Ready!</>
          ) : (
            <>Creating {agentName}</>
          )}
        </h1>
        <p className="text-center text-sm text-[#9E9E9E] mb-8">
          {isReady
            ? 'Your agent is ready to monitor and learn.'
            : 'Setting up your trading agent...'}
        </p>

        {/* Progress Bar */}
        <div className="mb-8">
          <div className="h-1 bg-[#1E1E1E] rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-[#00C805] to-[#0088FF] transition-all duration-500 ease-out"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>

        {/* Log Container */}
        <div className="bg-[#111111] border border-[#1E1E1E] rounded-xl p-4 mb-6 min-h-[180px]">
          {logs.map((log) => (
            <div
              key={log.id}
              className={`flex items-start gap-3 py-2 transition-all duration-300 ${
                log.status === 'pending' ? 'opacity-40' : 'opacity-100'
              }`}
            >
              {/* Icon */}
              <div
                className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] flex-shrink-0 mt-0.5 ${
                  log.status === 'pending'
                    ? 'bg-[#1A1A1A] border-2 border-[#2A2A2A] text-[#6E6E6E]'
                    : log.status === 'loading'
                    ? 'bg-[#1A1A1A] border-2 border-[#FFD000] text-[#FFD000] animate-spin'
                    : 'bg-[#00C805] border-2 border-[#00C805] text-black font-bold'
                }`}
              >
                {log.status === 'success' ? '✓' : '○'}
              </div>

              {/* Content */}
              <div className="flex-1">
                <div className="text-sm text-white">{log.text}</div>
                {log.detail && (
                  <div
                    className={`text-[11px] font-mono mt-1 whitespace-pre-line ${
                      log.id === 3 ? 'text-[#00C805] font-semibold' : 'text-[#6E6E6E]'
                    }`}
                  >
                    {log.detail}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Discovery Box */}
        {showDiscovery && (
          <div className="bg-[#00C805]/10 border border-[#00C805]/20 rounded-xl p-4 mb-6 animate-fade-in">
            <div className="text-2xl mb-2">🎉</div>
            <div className="text-sm font-semibold text-[#00C805] mb-1">
              Portfolio Discovered!
            </div>
            <div className="text-2xl font-bold font-mono mb-1">
              ${positionData.totalValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}
            </div>
            <div className="text-xs text-[#9E9E9E]">
              {totalPositions} positions across {[
                positionData.avantis > 0 && 'Avantis',
                positionData.hyperliquid > 0 && 'Hyperliquid',
                positionData.polymarket > 0 && 'Polymarket',
              ].filter(Boolean).join(' + ') || 'all protocols'}
            </div>
          </div>
        )}

        {/* CTA Button */}
        {showCTA && (
          <button
            onClick={handleLetsGo}
            className="w-full py-4 rounded-lg bg-[#00C805] text-black text-base font-bold hover:bg-[#00E006] hover:-translate-y-0.5 hover:shadow-[0_4px_20px_rgba(0,200,5,0.4)] transition-all animate-fade-in"
          >
            Let&apos;s Go →
          </button>
        )}
      </div>

      <style jsx>{`
        @keyframes fade-in {
          from {
            opacity: 0;
            transform: translateY(10px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        .animate-fade-in {
          animation: fade-in 0.4s ease-out forwards;
        }
      `}</style>
    </div>
  );
}
