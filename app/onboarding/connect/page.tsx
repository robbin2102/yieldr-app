'use client';

import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useAccount } from 'wagmi';
import WalletHandler from './WalletHandler';
import { useEffect, useState } from 'react';

export default function ConnectWallet() {
  const { address, isConnected } = useAccount();
  const [isChecking, setIsChecking] = useState(true);

  // Wait a moment for wagmi to initialize
  useEffect(() => {
    const timer = setTimeout(() => {
      setIsChecking(false);
    }, 500);
    return () => clearTimeout(timer);
  }, []);

  return (
    <>
      {/* Only handle wallet connection if connected */}
      {isConnected && <WalletHandler />}
      
      <div className="min-h-screen bg-black flex items-center justify-center p-4">
        <div className="max-w-md w-full">
          <div className="text-center mb-8">
            <div className="text-2xl font-extrabold tracking-[0.15em] text-white mb-6">YIELDR</div>
            <h1 className="text-3xl font-bold text-white mb-2">
              Connect Your Wallet
            </h1>
            <p className="text-gray-400">
              Connect your wallet to get started as an asset manager
            </p>
          </div>

          <div className="bg-[#0A0A0A] border border-[#1A1A1A] rounded-xl p-8">
            {isChecking ? (
              // Initial loading state
              <div className="text-center py-8">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#00C805] mx-auto"></div>
                <p className="text-sm text-gray-400 mt-4">Loading...</p>
              </div>
            ) : !isConnected ? (
              // Not connected - show connect button
              <div className="space-y-6">
                <div className="bg-[#00C805]/10 border border-[#00C805]/20 rounded-lg p-4">
                  <p className="text-sm text-gray-300">
                    We'll analyze your trading history and calculate your performance metrics
                  </p>
                </div>

                <div className="flex justify-center">
                  <ConnectButton />
                </div>

                <div className="text-center">
                  <p className="text-xs text-gray-500 mb-2">Supports all EVM wallets</p>
                  <div className="flex justify-center gap-2 text-xs text-gray-600 flex-wrap">
                    <span>MetaMask</span>
                    <span>•</span>
                    <span>Coinbase Wallet</span>
                    <span>•</span>
                    <span>Rainbow</span>
                    <span>•</span>
                    <span>WalletConnect</span>
                  </div>
                </div>
              </div>
            ) : (
              // Connected - show success and redirecting
              <div className="text-center space-y-4">
                <div className="w-16 h-16 bg-[#00C805] rounded-full flex items-center justify-center mx-auto mb-4">
                  <svg className="w-8 h-8 text-black" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                
                <h2 className="text-xl font-semibold text-white">Wallet Connected!</h2>
                <p className="text-sm text-gray-400 font-mono">
                  {address?.slice(0, 6)}...{address?.slice(-4)}
                </p>

                <div className="mt-4">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#00C805] mx-auto"></div>
                  <p className="text-sm text-gray-400 mt-2">Setting up your account...</p>
                </div>
              </div>
            )}
          </div>

          <p className="text-center text-xs text-gray-600 mt-6">
            Your wallet remains in your control. We only read transaction data.
          </p>

          <div className="text-center mt-4">
            <a href="/" className="text-sm text-gray-500 hover:text-[#00C805] transition-colors">
              ← Back to Discovery
            </a>
          </div>
        </div>
      </div>
    </>
  );
}
