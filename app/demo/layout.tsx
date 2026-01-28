'use client';

import { Providers } from '@/components/RainbowKitProvider';

export default function DemoLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <Providers>
      <div className="min-h-screen bg-black text-white">
        {children}
      </div>
    </Providers>
  );
}
