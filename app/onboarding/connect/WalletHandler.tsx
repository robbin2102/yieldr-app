'use client';

import { useAccount } from 'wagmi';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

export default function WalletHandler() {
  const { address, isConnected } = useAccount();
  const router = useRouter();

  useEffect(() => {
    if (isConnected && address) {
      localStorage.setItem('connectedWallet', address);
      
      fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          walletAddress: address,
          userType: 'manager'
        })
      }).then(() => {
        router.push('/onboarding/verify-method.html');
      }).catch(console.error);
    }
  }, [isConnected, address, router]);

  return null;
}
