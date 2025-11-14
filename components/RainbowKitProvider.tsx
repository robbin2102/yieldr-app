'use client';

import '@rainbow-me/rainbowkit/styles.css';
import { RainbowKitProvider, connectorsForWallets } from '@rainbow-me/rainbowkit';
import {
  metaMaskWallet,
  rainbowWallet,
  coinbaseWallet,
  walletConnectWallet,
  trustWallet,
} from '@rainbow-me/rainbowkit/wallets';
import { WagmiProvider } from 'wagmi';
import { createConfig, http } from 'wagmi';
import { base } from 'wagmi/chains';
import { QueryClientProvider, QueryClient } from '@tanstack/react-query';
import { ReactNode } from 'react';

const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || '';
const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://yieldr.app';

const connectors = connectorsForWallets(
  [
    {
      groupName: 'Popular',
      wallets: [
        metaMaskWallet,
        rainbowWallet,
        coinbaseWallet,
        trustWallet,
        walletConnectWallet,
      ],
    },
  ],
  {
    appName: 'Yieldr',
    appDescription: 'Co-invest with top crypto asset managers',
    appUrl: appUrl,
    appIcon: `${appUrl}/icon.png`,
    projectId,
  }
);

const config = createConfig({
  connectors,
  chains: [base],
  transports: {
    [base.id]: http(),
  },
  ssr: true,
});

const queryClient = new QueryClient();

export function Providers({ children }: { children: ReactNode }) {
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider
          modalSize="compact"
          initialChain={base}
          appInfo={{
            appName: 'Yieldr',
            learnMoreUrl: appUrl,
          }}
        >
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
