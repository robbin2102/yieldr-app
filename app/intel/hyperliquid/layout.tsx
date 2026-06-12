"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { label: "DASHBOARD", href: "/intel/hyperliquid" },
  { label: "COHORT",    href: "/intel/hyperliquid/cohort" },
  { label: "ALERTS",    href: "/intel/hyperliquid/alerts" },
  { label: "AGENT",     href: "/intel/hyperliquid/agent" },
];

export default function HyperliquidLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  const isActive = (href: string) =>
    href === "/intel/hyperliquid"
      ? pathname === "/intel/hyperliquid"
      : pathname.startsWith(href);

  return (
    <div className="min-h-screen bg-[#0B0E13] text-zinc-100 font-mono text-sm">
      {/* Top nav bar */}
      <div className="sticky top-0 z-50 bg-[#0B0E13] border-b border-zinc-800">
        <div className="px-4 flex items-stretch h-11">
          <span className="flex items-center text-orange-500 font-bold text-sm tracking-widest mr-8 shrink-0">
            HL SIGNALS <span className="text-orange-700 ml-1.5">▶</span>
          </span>
          <div className="flex items-stretch gap-0">
            {TABS.map((tab) => (
              <Link
                key={tab.href}
                href={tab.href}
                className={`flex items-center px-5 text-xs font-bold tracking-widest border-b-2 transition-colors ${
                  isActive(tab.href)
                    ? "border-orange-500 text-orange-400"
                    : "border-transparent text-zinc-500 hover:text-zinc-200"
                }`}
              >
                {tab.label}
              </Link>
            ))}
          </div>
          <div className="ml-auto flex items-center text-[10px] text-zinc-700">
            auto-refresh 30s
          </div>
        </div>
      </div>
      {children}
    </div>
  );
}
