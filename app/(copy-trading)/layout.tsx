import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Copy Trading - Yieldr",
  description: "Manual copy trading dashboard for Polymarket",
};

export default function CopyTradingRootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // No providers needed - this route group doesn't use wallet connection
  return <>{children}</>;
}
