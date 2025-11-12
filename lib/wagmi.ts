'use client';

import { connectorsForWallets } from '@rainbow-me/rainbowkit';
import {
  metaMaskWallet,
  rainbowWallet,
  coinbaseWallet,
  walletConnectWallet,
  trustWallet,
} from '@rainbow-me/rainbowkit/wallets';
import { createConfig, http } from 'wagmi';
import { base, baseSepolia } from 'wagmi/chains';

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

export const config = createConfig({
  connectors,
  chains: [base, baseSepolia],
  transports: {
    [base.id]: http(),
    [baseSepolia.id]: http(),
  },
  ssr: true,
});
