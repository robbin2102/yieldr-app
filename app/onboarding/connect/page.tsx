'use client';

import dynamic from 'next/dynamic';
import { useEffect } from 'react';

// Dynamically import wallet components with no SSR
const ConnectButton = dynamic(
  () => import('@rainbow-me/rainbowkit').then((mod) => mod.ConnectButton),
  { ssr: false }
);

const WalletHandler = dynamic(
  () => import('./WalletHandler'),
  { ssr: false }
);

export default function ConnectWallet() {
  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#000000',
      color: '#FFFFFF',
      fontFamily: 'Inter, sans-serif'
    }}>
      <div style={{
        textAlign: 'center',
        maxWidth: '500px',
        padding: '40px'
      }}>
        <h1 style={{
          fontSize: '32px',
          fontWeight: '700',
          marginBottom: '16px'
        }}>
          Connect Your Wallet
        </h1>
        <p style={{
          fontSize: '16px',
          color: '#8A8A8A',
          marginBottom: '40px'
        }}>
          Connect your wallet to verify your trading performance
        </p>
        <ConnectButton />
        <WalletHandler />
      </div>
    </div>
  );
}
