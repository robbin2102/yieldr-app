'use client';

import dynamic from 'next/dynamic';

const Providers = dynamic(
  () => import('@/components/RainbowKitProvider').then(mod => mod.Providers),
  { ssr: false }
);

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
