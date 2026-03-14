'use client';

import { useAccount } from 'wagmi';
import { useEffect, useState } from 'react';

export default function WalletHandler() {
  const { address, isConnected } = useAccount();
  const [isProcessing, setIsProcessing] = useState(false);

  useEffect(() => {
    if (isConnected && address && !isProcessing) {
      handleWalletConnected(address);
    }
  }, [isConnected, address]);

  const handleWalletConnected = async (walletAddress: string) => {
    setIsProcessing(true);
    
    try {
      console.log('🔗 Connected wallet:', walletAddress);
      localStorage.setItem('connectedWallet', walletAddress);

      // Step 1: Check if this exact wallet already has an account
      console.log('📡 Checking if wallet is already in use...');
      const walletCheckResponse = await fetch('/api/wallets/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ walletAddress }),
      });

      const walletCheckData = await walletCheckResponse.json();

      if (walletCheckData.inUse) {
        console.log('⚠️ Wallet already in use by:', walletCheckData.owner?.username);

        // Check if it's the same user reconnecting
        const existingUsername = walletCheckData.owner?.username;

        if (existingUsername) {
          console.log('✅ Existing user reconnecting — redirecting to terminal');
          localStorage.setItem('managerUsername', existingUsername);
          localStorage.setItem('yieldr_auth_wallet', walletAddress.toLowerCase());
          window.location.href = '/demo/chat';
          return;
        }
      }

      // Step 2: If wallet not in use, check users collection
      console.log('📡 Checking users collection...');
      const checkResponse = await fetch('/api/users/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ walletAddress }),
      });

      const checkData = await checkResponse.json();
      console.log('✅ User check:', checkData);

      if (!checkData.exists) {
        // Attempt to create new user
        console.log('🆕 Creating new account...');
        const createResponse = await fetch('/api/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            walletAddress,
            role: 'manager',
            status: 'pending_verification'
          }),
        });

        const createData = await createResponse.json();

        // Check if user already existed (race condition handling)
        if (createData.alreadyExists && createData.user) {
          console.log('✅ User already exists, checking profile...');
          // Treat as existing user and check their profile
          const profileResponse = await fetch(
            `/api/managers/profile?walletAddress=${encodeURIComponent(walletAddress)}`
          );

          if (profileResponse.ok) {
            const profileData = await profileResponse.json();
            if (profileData.success && profileData.data?.username) {
              const username = profileData.data.username;
              console.log('✅ Profile found, redirecting to terminal');
              localStorage.setItem('managerUsername', username);
              localStorage.setItem('yieldr_auth_wallet', walletAddress.toLowerCase());
              window.location.href = '/demo/chat';
              return;
            }
          }

          // Profile incomplete, continue with onboarding → new terminal
          console.log('➡️ Profile incomplete, redirecting to terminal');
          localStorage.setItem('yieldr_auth_wallet', walletAddress.toLowerCase());
          window.location.href = '/demo/chat';
          return;
        }

        // New user successfully created
        console.log('➡️ Redirecting to profile');
        window.location.href = `/onboarding/verify-method.html?address=${walletAddress}`;
        return;
      }

      // Existing manager - check profile
      if (checkData.user.role === 'manager') {
        console.log('📡 Checking manager profile...');
        
        const profileResponse = await fetch(
          `/api/managers/profile?walletAddress=${encodeURIComponent(walletAddress)}`
        );
        
        if (profileResponse.ok) {
          const profileData = await profileResponse.json();
          
          if (profileData.success && profileData.data?.username) {
            const username = profileData.data.username;
            console.log('✅ Profile found:', username);
            localStorage.setItem('managerUsername', username);
            localStorage.setItem('yieldr_auth_wallet', walletAddress.toLowerCase());
            console.log('➡️ Redirecting to terminal');
            window.location.href = '/demo/chat';
            return;
          }
        }

        console.log('➡️ Profile incomplete, redirecting to terminal');
        localStorage.setItem('yieldr_auth_wallet', walletAddress.toLowerCase());
        window.location.href = '/demo/chat';
      } else {
        console.log('➡️ Non-manager user');
        window.location.href = '/';
      }

    } catch (error) {
      console.error('❌ Error:', error);
      setIsProcessing(false);
    }
  };

  return null;
}
