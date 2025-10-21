'use client';

import { useEffect, useState } from 'react';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useAccount } from 'wagmi';
import { useRouter } from 'next/navigation';

export default function ConnectWallet() {
  const { address, isConnected } = useAccount();
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (isConnected && address) {
      handleWalletConnected(address);
    }
  }, [isConnected, address]);

  const handleWalletConnected = async (walletAddress: string) => {
    setIsLoading(true);
    
    try {
      // Store wallet address in localStorage
      localStorage.setItem('connectedWallet', walletAddress);
      
      const response = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ walletAddress }),
      });

      const data = await response.json();

      if (response.ok) {
        console.log('User created/found:', data);
        
        setTimeout(() => {
          router.push('/onboarding/verify-method.html');
        }, 1000);
      }
    } catch (error) {
      console.error('Error saving user:', error);
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-black flex items-center justify-center p-4">
      <div className="max-w-md w-full">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-white mb-2">
            Connect Your Wallet
          </h1>
          <p className="text-gray-400">
            Connect your wallet to verify your trading performance on Base
          </p>
        </div>

        <div className="bg-[#0A0A0A] border border-[#1A1A1A] rounded-xl p-8">
          {!isConnected ? (
            <div className="space-y-6">
              <div className="bg-[#00C805]/10 border border-[#00C805]/20 rounded-lg p-4">
                <p className="text-sm text-gray-300">
                  We'll analyze your trading history on Base to calculate your performance metrics
                </p>
              </div>

              <div className="flex justify-center">
                <ConnectButton />
              </div>

              <div className="text-center">
                <p className="text-xs text-gray-500 mb-2">Supports all EVM wallets</p>
                <div className="flex justify-center gap-2 text-xs text-gray-600">
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

              {isLoading && (
                <div className="mt-4">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#00C805] mx-auto"></div>
                  <p className="text-sm text-gray-400 mt-2">Setting up your account...</p>
                </div>
              )}
            </div>
          )}
        </div>

        <p className="text-center text-xs text-gray-600 mt-6">
          Your wallet remains in your control. We only read transaction data.
        </p>
      </div>
    </div>
  );
}
