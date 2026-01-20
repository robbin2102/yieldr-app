'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const navItems = [
  { href: '/copy-trading', label: 'Dashboard', icon: '📊' },
  { href: '/copy-trading/alerts', label: 'Alerts', icon: '🔔' },
  { href: '/copy-trading/positions', label: 'Positions', icon: '💰' },
  { href: '/copy-trading/traders', label: 'Traders', icon: '👥' },
];

export default function CopyTradingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();

  return (
    <div className="min-h-screen bg-black">
      {/* Header */}
      <header className="border-b border-[#1E1E1E] bg-[#0A0A0A]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            {/* Logo */}
            <Link href="/copy-trading" className="flex items-center gap-2">
              <span className="font-mono text-xl font-bold text-primary-green">
                YIELDR
              </span>
              <span className="text-[#6E6E6E] text-sm font-medium">
                Copy Trading
              </span>
            </Link>

            {/* Navigation */}
            <nav className="flex items-center gap-1">
              {navItems.map((item) => {
                const isActive = pathname === item.href ||
                  (item.href !== '/copy-trading' && pathname?.startsWith(item.href));

                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`
                      px-4 py-2 rounded-lg text-sm font-medium transition-all
                      ${isActive
                        ? 'bg-primary-green/10 text-primary-green'
                        : 'text-[#9E9E9E] hover:text-white hover:bg-[#1A1A1A]'
                      }
                    `}
                  >
                    <span className="mr-2">{item.icon}</span>
                    {item.label}
                  </Link>
                );
              })}
            </nav>

            {/* Wallet indicator */}
            <div className="flex items-center gap-3">
              <div className="text-xs text-[#6E6E6E] font-mono">
                0x01ba...4ba
              </div>
              <div className="w-2 h-2 rounded-full bg-primary-green animate-pulse" />
            </div>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {children}
      </main>
    </div>
  );
}
