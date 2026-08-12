'use client';

import dynamic from 'next/dynamic';

// WalletConnect's SDK touches `localStorage` during its own setup, which
// doesn't exist during Next's server-side render. This was always a latent
// risk for any page under (main) using <Providers>, but it only ever
// surfaced now that a page lives at the literal root `/` - every other
// page here was reached via client-side navigation, never a cold SSR hit.
// ssr:false keeps Providers (and everything that touches wallet storage)
// off the server render entirely.
const Providers = dynamic(() => import('@/components/RainbowKitProvider').then((m) => m.Providers), {
  ssr: false,
});

export default function MainLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <Providers>
      {children}
    </Providers>
  );
}
