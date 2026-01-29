'use client';

import { useState, useEffect } from 'react';
import { useAccount } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useRouter } from 'next/navigation';

type Market = 'perps' | 'predictions' | 'liquidity';

const marketConfig: Array<{
  id: Market;
  icon: string;
  name: string;
  desc: string;
  platforms: string[];
}> = [
  {
    id: 'perps',
    icon: '\u26A1',
    name: 'Perpetuals',
    desc: 'Leveraged trading on perp DEXs',
    platforms: ['Avantis', 'Hyperliquid'],
  },
  {
    id: 'predictions',
    icon: '\uD83C\uDFB2',
    name: 'Prediction Markets',
    desc: 'Event-driven trading and forecasting',
    platforms: ['Polymarket', 'Limitless'],
  },
  {
    id: 'liquidity',
    icon: '\uD83D\uDCA7',
    name: 'Liquidity',
    desc: 'LP positions and yield farming',
    platforms: ['Uniswap', 'Aerodrome'],
  },
];

const marketNames: Record<Market, string> = {
  perps: 'Perpetuals',
  predictions: 'Prediction Markets',
  liquidity: 'Liquidity',
};

export default function CreateAgentPage() {
  const [mounted, setMounted] = useState(false);
  const router = useRouter();
  const { address, isConnected } = useAccount();
  const [agentName, setAgentName] = useState('');
  const [selectedMarkets, setSelectedMarkets] = useState<Market[]>([]);
  const [pendingConnect, setPendingConnect] = useState(false);

  useEffect(() => { setMounted(true); }, []);

  // Load saved data
  useEffect(() => {
    if (!mounted) return;
    const saved = localStorage.getItem('agentSetup');
    if (saved) {
      try {
        const data = JSON.parse(saved);
        if (data.name) setAgentName(data.name);
        if (data.markets && Array.isArray(data.markets)) setSelectedMarkets(data.markets);
      } catch {}
    }
  }, [mounted]);

  // After wallet connects, save and navigate
  useEffect(() => {
    if (isConnected && address && pendingConnect) {
      localStorage.setItem('agentSetup', JSON.stringify({
        name: agentName,
        markets: selectedMarkets,
        wallet: address,
        createdAt: Date.now(),
      }));
      router.push('/demo/launching');
    }
  }, [isConnected, address, pendingConnect, agentName, selectedMarkets, router]);

  const toggleMarket = (marketId: Market) => {
    setSelectedMarkets(prev =>
      prev.includes(marketId)
        ? prev.filter(m => m !== marketId)
        : [...prev, marketId]
    );
  };

  const canContinue = agentName.trim().length > 0 && selectedMarkets.length > 0;

  const selectionText = (() => {
    if (selectedMarkets.length === 0) return '';
    if (selectedMarkets.length === 3) return '\u2713 All markets selected';
    return `\u2713 ${selectedMarkets.map(m => marketNames[m]).join(' + ')}`;
  })();

  if (!mounted) return null;

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }}>
      <div style={{ maxWidth: 520, width: '100%' }}>
        {/* Logo */}
        <div style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '1.25rem', fontWeight: 700, color: '#00C805', letterSpacing: '-0.02em' }}>
            YIELDR
          </span>
        </div>

        {/* Header */}
        <div style={{ marginBottom: '1.25rem' }}>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: '0.35rem', letterSpacing: '-0.02em' }}>
            Create Your AI Agent
          </h1>
          <p style={{ fontSize: '0.85rem', color: '#9E9E9E', lineHeight: 1.5 }}>
            Your agent learns from top traders and helps you understand market moves.
          </p>
        </div>

        {/* Agent Name */}
        <div style={{ marginBottom: '1.25rem' }}>
          <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, marginBottom: '0.5rem', color: '#FFFFFF' }}>
            Name your agent
          </label>
          <input
            type="text"
            value={agentName}
            onChange={(e) => setAgentName(e.target.value)}
            placeholder="e.g. AlphaHunter, YieldBot, TrendSeeker"
            maxLength={20}
            autoComplete="off"
            style={{
              width: '100%',
              padding: '0.75rem 1rem',
              background: '#0A0A0A',
              border: '2px solid #1E1E1E',
              borderRadius: 8,
              color: '#FFFFFF',
              fontSize: '0.95rem',
              fontFamily: "'Inter', sans-serif",
              outline: 'none',
              transition: 'all 0.2s ease',
            }}
            onFocus={(e) => { e.target.style.borderColor = '#00C805'; e.target.style.background = '#111111'; }}
            onBlur={(e) => { e.target.style.borderColor = '#1E1E1E'; e.target.style.background = '#0A0A0A'; }}
          />
        </div>

        {/* Market Selection */}
        <div style={{ marginBottom: '1.25rem' }}>
          <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, marginBottom: '0.5rem', color: '#FFFFFF' }}>
            Which markets will your agent focus on?
            <span style={{ fontWeight: 400, color: '#6E6E6E', marginLeft: '0.25rem' }}>(select one or more)</span>
          </label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {marketConfig.map((market) => {
              const selected = selectedMarkets.includes(market.id);
              return (
                <button
                  key={market.id}
                  type="button"
                  onClick={() => toggleMarket(market.id)}
                  style={{
                    background: selected ? 'rgba(0, 200, 5, 0.05)' : '#0A0A0A',
                    border: `2px solid ${selected ? '#00C805' : '#1E1E1E'}`,
                    borderRadius: 10,
                    padding: '0.875rem 1rem',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '1rem',
                    transition: 'all 0.2s ease',
                    textAlign: 'left',
                    width: '100%',
                    color: '#FFFFFF',
                  }}
                >
                  {/* Icon */}
                  <div style={{
                    fontSize: '1.5rem',
                    width: 40,
                    height: 40,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: selected ? 'rgba(0, 200, 5, 0.15)' : '#111111',
                    borderRadius: 10,
                    flexShrink: 0,
                  }}>
                    {market.icon}
                  </div>

                  {/* Info */}
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '0.25rem' }}>
                      {market.name}
                    </div>
                    <div style={{ fontSize: '0.75rem', color: '#9E9E9E', marginBottom: '0.5rem', lineHeight: 1.4 }}>
                      {market.desc}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
                      {market.platforms.map((p) => (
                        <span key={p} style={{
                          fontFamily: "'JetBrains Mono', monospace",
                          fontSize: '0.6rem',
                          fontWeight: 600,
                          padding: '0.25rem 0.5rem',
                          background: selected ? 'rgba(0, 200, 5, 0.1)' : '#1A1A1A',
                          border: `1px solid ${selected ? 'rgba(0, 200, 5, 0.2)' : '#1E1E1E'}`,
                          borderRadius: 4,
                          color: selected ? '#00C805' : '#6E6E6E',
                          textTransform: 'uppercase' as const,
                          letterSpacing: '0.03em',
                        }}>
                          {p}
                        </span>
                      ))}
                    </div>
                  </div>

                  {/* Checkbox */}
                  <div style={{
                    width: 22,
                    height: 22,
                    border: `2px solid ${selected ? '#00C805' : '#2A2A2A'}`,
                    borderRadius: 4,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                    background: selected ? '#00C805' : 'transparent',
                    transition: 'all 0.2s ease',
                  }}>
                    {selected && (
                      <span style={{ color: '#000', fontSize: '0.75rem', fontWeight: 700 }}>{'\u2713'}</span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Selection Summary */}
          <div style={{
            marginTop: '0.75rem',
            fontSize: '0.75rem',
            color: selectedMarkets.length > 0 ? '#00C805' : '#6E6E6E',
            minHeight: '1.2em',
          }}>
            {selectionText}
          </div>
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1.5rem' }}>
          <button
            type="button"
            onClick={() => router.push('/')}
            style={{
              flex: '0 0 auto',
              width: '30%',
              padding: '1rem 1.5rem',
              borderRadius: 8,
              fontSize: '0.95rem',
              fontWeight: 600,
              cursor: 'pointer',
              background: 'transparent',
              border: '2px solid #1E1E1E',
              color: '#FFFFFF',
              fontFamily: "'Inter', sans-serif",
              transition: 'all 0.2s ease',
            }}
          >
            Back
          </button>

          {!isConnected ? (
            <div style={{ flex: 1 }}>
              {canContinue ? (
                <ConnectButton.Custom>
                  {({ openConnectModal }) => (
                    <button
                      onClick={() => {
                        setPendingConnect(true);
                        localStorage.setItem('agentSetup', JSON.stringify({
                          name: agentName,
                          markets: selectedMarkets,
                          createdAt: Date.now(),
                        }));
                        openConnectModal();
                      }}
                      style={{
                        width: '100%',
                        padding: '1rem 1.5rem',
                        borderRadius: 8,
                        fontSize: '0.95rem',
                        fontWeight: 600,
                        cursor: 'pointer',
                        background: '#00C805',
                        border: 'none',
                        color: '#000000',
                        fontFamily: "'Inter', sans-serif",
                        transition: 'all 0.2s ease',
                      }}
                    >
                      Connect Wallet
                    </button>
                  )}
                </ConnectButton.Custom>
              ) : (
                <button
                  disabled
                  style={{
                    width: '100%',
                    padding: '1rem 1.5rem',
                    borderRadius: 8,
                    fontSize: '0.95rem',
                    fontWeight: 600,
                    background: '#00C805',
                    border: 'none',
                    color: '#000000',
                    fontFamily: "'Inter', sans-serif",
                    opacity: 0.4,
                    cursor: 'not-allowed',
                  }}
                >
                  Connect Wallet
                </button>
              )}
            </div>
          ) : (
            <button
              onClick={() => {
                localStorage.setItem('agentSetup', JSON.stringify({
                  name: agentName,
                  markets: selectedMarkets,
                  wallet: address,
                  createdAt: Date.now(),
                }));
                router.push('/demo/launching');
              }}
              disabled={!canContinue}
              style={{
                flex: 1,
                padding: '1rem 1.5rem',
                borderRadius: 8,
                fontSize: '0.95rem',
                fontWeight: 600,
                cursor: canContinue ? 'pointer' : 'not-allowed',
                background: '#00C805',
                border: 'none',
                color: '#000000',
                fontFamily: "'Inter', sans-serif",
                opacity: canContinue ? 1 : 0.4,
                transition: 'all 0.2s ease',
              }}
            >
              Continue &rarr;
            </button>
          )}
        </div>

        {/* Footer */}
        <div style={{ textAlign: 'center', marginTop: '1.25rem', fontSize: '0.7rem', color: '#6E6E6E' }}>
          By connecting, you agree to our <a href="#" style={{ color: '#00C805', textDecoration: 'none' }}>Terms</a> and <a href="#" style={{ color: '#00C805', textDecoration: 'none' }}>Privacy Policy</a>
        </div>
      </div>
    </div>
  );
}
