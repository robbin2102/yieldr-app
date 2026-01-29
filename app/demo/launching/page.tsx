'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useAccount } from 'wagmi';
import { useRouter } from 'next/navigation';

interface LogStep {
  id: number;
  text: string;
  detail?: string;
  status: 'pending' | 'loading' | 'success';
  highlight?: boolean;
  visible: boolean;
}

export default function LaunchingPage() {
  const [mounted, setMounted] = useState(false);
  const router = useRouter();
  const { address, isConnected } = useAccount();
  const sequenceStarted = useRef(false);

  const [agentName, setAgentName] = useState('AlphaHunter');
  const [progress, setProgress] = useState(0);
  const [isReady, setIsReady] = useState(false);
  const [discoveryVisible, setDiscoveryVisible] = useState(false);
  const [ctaVisible, setCtaVisible] = useState(false);

  const [logs, setLogs] = useState<LogStep[]>([
    { id: 1, text: 'Initializing agent', status: 'pending', visible: false },
    { id: 2, text: 'Connecting wallet', status: 'pending', visible: false },
    { id: 3, text: 'Scanning positions', status: 'pending', visible: false },
    { id: 4, text: 'Following top traders', status: 'pending', visible: false },
  ]);

  const [portfolioValue, setPortfolioValue] = useState(0);
  const [portfolioDetail, setPortfolioDetail] = useState('');

  useEffect(() => { setMounted(true); }, []);

  // Load setup data
  useEffect(() => {
    if (!mounted) return;
    const setup = localStorage.getItem('agentSetup');
    if (setup) {
      try {
        const data = JSON.parse(setup);
        if (data.name) setAgentName(data.name);
      } catch {}
    }
  }, [mounted]);

  const updateLog = useCallback((id: number, updates: Partial<LogStep>) => {
    setLogs(prev => prev.map(log => (log.id === id ? { ...log, ...updates } : log)));
  }, []);

  const startStep = useCallback((id: number) => {
    updateLog(id, { status: 'loading', visible: true });
  }, [updateLog]);

  const completeStep = useCallback((id: number, detail?: string, highlight?: boolean) => {
    updateLog(id, { status: 'success', detail, highlight });
  }, [updateLog]);

  // Scan positions using existing production APIs + MCP for Polymarket
  const scanPositions = useCallback(async (walletAddress: string) => {
    const [avantisRes, hlRes, lpRes, pmRes] = await Promise.allSettled([
      fetch(`/api/avantis-positions?address=${walletAddress}`),
      fetch(`/api/hyperliquid-positions?address=${walletAddress}`),
      fetch(`/api/lp-positions?address=${walletAddress}`),
      fetch(`/api/polymarket-positions?address=${walletAddress}`),
    ]);

    let avantisPositions: any[] = [];
    let hlPositions: any[] = [];
    let lpPositions: any[] = [];
    let pmPositions: any[] = [];
    let totalValue = 0;

    if (avantisRes.status === 'fulfilled' && avantisRes.value.ok) {
      const json = await avantisRes.value.json();
      const d = json.data || json;
      avantisPositions = d.positions || [];
      totalValue += d.summary?.totalMargin || 0;
      console.log('[scan] Avantis:', avantisPositions.length, 'positions');
    } else {
      console.log('[scan] Avantis failed:', avantisRes.status === 'fulfilled' ? avantisRes.value.status : 'rejected');
    }

    if (hlRes.status === 'fulfilled' && hlRes.value.ok) {
      const json = await hlRes.value.json();
      const d = json.data || json;
      hlPositions = d.positions || [];
      totalValue += d.summary?.accountValue || d.summary?.totalMargin || 0;
      console.log('[scan] HL:', hlPositions.length, 'positions');
    } else {
      console.log('[scan] HL failed:', hlRes.status === 'fulfilled' ? hlRes.value.status : 'rejected');
    }

    if (lpRes.status === 'fulfilled' && lpRes.value.ok) {
      const json = await lpRes.value.json();
      const d = json.data || json;
      lpPositions = d.positions || [];
      totalValue += d.summary?.totalLiquidity || 0;
      console.log('[scan] LP:', lpPositions.length, 'positions');
    } else {
      console.log('[scan] LP failed:', lpRes.status === 'fulfilled' ? lpRes.value.status : 'rejected');
    }

    if (pmRes.status === 'fulfilled' && pmRes.value.ok) {
      const json = await pmRes.value.json();
      const d = json.data || json;
      pmPositions = d.positions || [];
      totalValue += d.summary?.totalValue || 0;
      console.log('[scan] PM:', pmPositions.length, 'positions');
    } else {
      console.log('[scan] PM failed:', pmRes.status === 'fulfilled' ? pmRes.value.status : 'rejected');
    }

    return {
      avantisPositions,
      hlPositions,
      lpPositions,
      pmPositions,
      counts: {
        avantis: avantisPositions.length,
        hyperliquid: hlPositions.length,
        lp: lpPositions.length,
        polymarket: pmPositions.length,
      },
      totalValue,
    };
  }, []);

  // Save positions to MongoDB - both /api/positions (production) and /api/demo/agents (agent record)
  const saveData = useCallback(async (walletAddress: string, data: any) => {
    const setup = JSON.parse(localStorage.getItem('agentSetup') || '{}');

    // Save to production positions collection
    try {
      await fetch('/api/positions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          walletAddress,
          lpPositions: data.lpPositions || [],
          avantisPositions: data.avantisPositions || [],
          hyperliquidPositions: data.hlPositions || [],
          polymarketPositions: data.pmPositions || [],
          metrics: { totalPnL: 0, totalAUM: data.totalValue, totalROI: 0 },
        }),
      });
    } catch (error) {
      console.error('Error saving positions:', error);
    }

    // Save to agents collection
    try {
      await fetch('/api/demo/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: setup.name || 'AlphaHunter',
          ownerWallet: walletAddress,
          markets: setup.markets || ['perps'],
          positions: data,
        }),
      });
    } catch (error) {
      console.error('Error saving agent:', error);
    }
  }, []);

  // Run animation sequence
  useEffect(() => {
    if (!mounted || !address || sequenceStarted.current) return;
    sequenceStarted.current = true;

    const shortWallet = `${address.slice(0, 6)}...${address.slice(-4)}`;
    const setup = JSON.parse(localStorage.getItem('agentSetup') || '{}');
    const markets: string[] = setup.markets || ['perps'];

    const run = async () => {
      // Step 1: Initialize
      startStep(1);
      await new Promise(r => setTimeout(r, 1500));
      completeStep(1);
      setProgress(25);

      // Step 2: Connect wallet
      await new Promise(r => setTimeout(r, 200));
      startStep(2);
      await new Promise(r => setTimeout(r, 1500));
      completeStep(2, shortWallet);
      setProgress(50);

      // Step 3: Scan positions (real API calls)
      await new Promise(r => setTimeout(r, 200));
      startStep(3);
      const posData = await scanPositions(address);
      const parts: string[] = [];
      const perpCount = posData.counts.avantis + posData.counts.hyperliquid;
      if (perpCount > 0) parts.push(`${perpCount} perp positions`);
      if (posData.counts.lp > 0) parts.push(`${posData.counts.lp} LP positions`);
      if (posData.counts.polymarket > 0) parts.push(`${posData.counts.polymarket} prediction positions`);
      const posDetail = parts.length > 0 ? `Found ${parts.join(' + ')}` : 'No positions found';
      completeStep(3, posDetail, true);
      setProgress(75);

      // Save positions to MongoDB (before step 4 so agent exists)
      await saveData(address, posData);

      // Step 4: Follow top traders (real API call)
      await new Promise(r => setTimeout(r, 200));
      startStep(4);
      let followDetail = 'No traders found';
      try {
        const followRes = await fetch('/api/demo/agents/follow-traders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ wallet: address }),
        });
        if (followRes.ok) {
          const followData = await followRes.json();
          const count = followData.count || 0;
          if (count > 0) {
            followDetail = `Following ${count} top traders`;
          }
        }
      } catch (e) {
        console.error('Follow traders failed:', e);
      }
      completeStep(4, followDetail, true);
      setProgress(100);

      // Show discovery
      const totalPositions = perpCount + posData.counts.lp + posData.counts.polymarket;
      setPortfolioValue(posData.totalValue);
      if (totalPositions > 0) {
        setPortfolioDetail(`${totalPositions} positions across ${[
          posData.counts.avantis > 0 || posData.counts.hyperliquid > 0 ? 'Perps' : '',
          posData.counts.lp > 0 ? 'LP' : '',
          posData.counts.polymarket > 0 ? 'Polymarket' : '',
        ].filter(Boolean).join(' + ')}`);
      } else {
        setPortfolioDetail('Ready to start trading');
      }

      await new Promise(r => setTimeout(r, 500));
      setIsReady(true);
      setDiscoveryVisible(true);

      await new Promise(r => setTimeout(r, 500));
      setCtaVisible(true);
    };

    run();
  }, [mounted, address, startStep, completeStep, scanPositions, saveData]);

  const handleLetsGo = () => {
    localStorage.setItem('agentCreated', JSON.stringify({
      name: agentName,
      wallet: address,
      createdAt: Date.now(),
    }));
    router.push('/demo/chat');
  };

  if (!mounted) return null;

  // Redirect if no wallet
  if (!isConnected && mounted) {
    router.push('/demo');
    return null;
  }

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '2rem',
      fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
    }}>
      <div style={{
        maxWidth: 480,
        width: '100%',
        background: '#0A0A0A',
        border: '1px solid #1E1E1E',
        borderRadius: 16,
        padding: '2.5rem 2rem',
        boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.8)',
      }}>
        {/* Agent Avatar */}
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '1.5rem' }}>
          <div style={{
            width: 80,
            height: 80,
            background: 'linear-gradient(135deg, #00C805 0%, #0088FF 100%)',
            borderRadius: 20,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '2.5rem',
            position: 'relative',
            boxShadow: isReady ? '0 0 30px rgba(0, 200, 5, 0.3)' : undefined,
            animation: isReady ? 'none' : undefined,
          }}
          className={isReady ? '' : 'avatar-pulse'}
          >
            {'\uD83E\uDD16'}
            {isReady && (
              <>
                <span className="sparkle sparkle-1">{'\u2728'}</span>
                <span className="sparkle sparkle-2">{'\u2728'}</span>
                <span className="sparkle sparkle-3">{'\u2728'}</span>
              </>
            )}
          </div>
        </div>

        {/* Title */}
        <h1 style={{ textAlign: 'center', fontSize: '1.5rem', fontWeight: 700, marginBottom: '0.5rem', letterSpacing: '-0.02em' }}>
          {isReady ? `${agentName} is Ready!` : `Creating ${agentName}`}
        </h1>
        <p style={{ textAlign: 'center', fontSize: '0.85rem', color: '#9E9E9E', marginBottom: '2rem' }}>
          {isReady ? 'Your agent is ready to monitor and learn.' : 'Setting up your trading agent...'}
        </p>

        {/* Progress Bar */}
        <div style={{ marginBottom: '2rem' }}>
          <div style={{ height: 4, background: '#1E1E1E', borderRadius: 2, overflow: 'hidden' }}>
            <div style={{
              height: '100%',
              background: 'linear-gradient(90deg, #00C805 0%, #0088FF 100%)',
              width: `${progress}%`,
              transition: 'width 0.5s ease',
              borderRadius: 2,
            }} />
          </div>
        </div>

        {/* Log Container */}
        <div style={{
          background: '#111111',
          border: '1px solid #1E1E1E',
          borderRadius: 10,
          padding: '1rem',
          marginBottom: '1.5rem',
          minHeight: 200,
        }}>
          {logs.map((log) => (
            <div
              key={log.id}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: '0.75rem',
                padding: '0.5rem 0',
                opacity: log.visible ? (log.status === 'pending' ? 0.5 : 1) : 0,
                transform: log.visible ? 'translateY(0)' : 'translateY(10px)',
                transition: 'all 0.3s ease',
              }}
            >
              {/* Icon */}
              <div
                className={log.status === 'loading' ? 'spin-icon' : ''}
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: '50%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '0.65rem',
                  flexShrink: 0,
                  marginTop: 2,
                  ...(log.status === 'pending' ? {
                    background: '#1A1A1A',
                    border: '2px solid #2A2A2A',
                    color: '#6E6E6E',
                  } : log.status === 'loading' ? {
                    background: '#1A1A1A',
                    border: '2px solid #FFD000',
                    color: '#FFD000',
                  } : {
                    background: '#00C805',
                    border: '2px solid #00C805',
                    color: '#000',
                    fontWeight: 700,
                  }),
                }}
              >
                {log.status === 'success' ? '\u2713' : '\u25CB'}
              </div>

              {/* Content */}
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: '0.85rem', color: '#FFFFFF', marginBottom: '0.15rem' }}>
                  {log.text}
                </div>
                {log.detail && (
                  <div style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: '0.7rem',
                    color: log.highlight ? '#00C805' : '#6E6E6E',
                    fontWeight: log.highlight ? 600 : 400,
                  }}>
                    {log.detail}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Discovery Box */}
        <div style={{
          background: 'rgba(0, 200, 5, 0.08)',
          border: '1px solid rgba(0, 200, 5, 0.2)',
          borderRadius: 8,
          padding: '1rem',
          marginBottom: '1.5rem',
          opacity: discoveryVisible ? 1 : 0,
          transform: discoveryVisible ? 'translateY(0)' : 'translateY(10px)',
          transition: 'all 0.4s ease',
          display: discoveryVisible ? 'block' : 'none',
        }}>
          <div style={{ fontSize: '1.25rem', marginBottom: '0.5rem' }}>{'\uD83C\uDF89'}</div>
          <div style={{ fontSize: '0.9rem', fontWeight: 600, color: '#00C805', marginBottom: '0.25rem' }}>
            Portfolio Discovered!
          </div>
          <div style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '1.5rem',
            fontWeight: 700,
            color: '#FFFFFF',
            marginBottom: '0.25rem',
          }}>
            ${portfolioValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}
          </div>
          <div style={{ fontSize: '0.75rem', color: '#9E9E9E' }}>
            {portfolioDetail}
          </div>
        </div>

        {/* CTA Button */}
        <div style={{
          opacity: ctaVisible ? 1 : 0,
          transform: ctaVisible ? 'translateY(0)' : 'translateY(10px)',
          transition: 'all 0.4s ease',
          display: ctaVisible ? 'block' : 'none',
        }}>
          <button
            onClick={handleLetsGo}
            style={{
              width: '100%',
              padding: '1rem 1.5rem',
              background: '#00C805',
              border: 'none',
              borderRadius: 8,
              color: '#000',
              fontSize: '1rem',
              fontWeight: 700,
              cursor: 'pointer',
              fontFamily: "'Inter', sans-serif",
              transition: 'all 0.2s ease',
            }}
          >
            {"Let's Go \u2192"}
          </button>
        </div>
      </div>

      <style jsx>{`
        @keyframes pulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(0, 200, 5, 0.4); }
          50% { box-shadow: 0 0 20px 10px rgba(0, 200, 5, 0.1); }
        }
        .avatar-pulse {
          animation: pulse 2s ease-in-out infinite;
        }
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        .spin-icon {
          animation: spin 1s linear infinite;
        }
        @keyframes sparkleAnim {
          0%, 100% { opacity: 0; transform: scale(0.5); }
          50% { opacity: 1; transform: scale(1); }
        }
        .sparkle {
          position: absolute;
          font-size: 1rem;
          animation: sparkleAnim 1s ease-in-out infinite;
        }
        .sparkle-1 { top: -8px; right: -8px; animation-delay: 0s; }
        .sparkle-2 { bottom: -8px; left: -8px; animation-delay: 0.3s; }
        .sparkle-3 { top: -8px; left: -8px; animation-delay: 0.6s; }
      `}</style>
    </div>
  );
}
