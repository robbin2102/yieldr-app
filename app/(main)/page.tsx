'use client';

import { useState } from 'react';
import { useAccount } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useRouter } from 'next/navigation';
import styles from './landing.module.css';

type MarketId = 'base' | 'hood' | 'solana';

const MARKETS: Array<{ id: MarketId; icon: string; name: string; disabled?: boolean }> = [
  { id: 'base', icon: '🔵', name: 'Base' },
  { id: 'hood', icon: '🟢', name: 'Robinhood Chain' },
  { id: 'solana', icon: '🟣', name: 'Solana', disabled: true },
];

export default function LandingPage() {
  const { address, isConnected } = useAccount();
  const router = useRouter();
  const [selected, setSelected] = useState<MarketId[]>(['base', 'hood']);

  const toggleMarket = (id: MarketId) => {
    if (MARKETS.find((m) => m.id === id)?.disabled) return;
    setSelected((prev) => (prev.includes(id) ? prev.filter((m) => m !== id) : [...prev, id]));
  };

  const canLaunch = selected.length > 0;

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <div className={styles.logo}>YIELDR</div>
        <div className={styles.title}>Find your edge</div>
        <div className={styles.subtitle}>
          Connect your wallet and the Quant Agent pulls your last 90 days of trades, then breaks down
          your entry, exit, and sizing to show you where your edge actually lives.
        </div>

        <div className={styles.label}>Select markets to analyze</div>
        <div className={styles.markets}>
          {MARKETS.map((m) => (
            <button
              key={m.id}
              type="button"
              className={`${styles.marketChip} ${selected.includes(m.id) ? styles.selected : ''} ${m.disabled ? styles.disabled : ''}`}
              onClick={() => toggleMarket(m.id)}
            >
              <div className={styles.marketIcon}>{m.icon}</div>
              <div className={styles.marketName}>{m.name}</div>
              {m.disabled && <div className={styles.marketTag}>Coming soon</div>}
            </button>
          ))}
        </div>

        {isConnected && address && (
          <div className={styles.walletAddr}>{address.slice(0, 6)}...{address.slice(-4)} connected</div>
        )}

        {!isConnected ? (
          <ConnectButton.Custom>
            {({ openConnectModal }) => (
              <button className={styles.launchBtn} onClick={openConnectModal} disabled={!canLaunch}>
                Connect Wallet to Launch Quant Agent
              </button>
            )}
          </ConnectButton.Custom>
        ) : (
          <button className={styles.launchBtn} onClick={() => router.push(`/edge/${address}`)} disabled={!canLaunch}>
            Launch Quant Agent →
          </button>
        )}
      </div>
    </div>
  );
}
