import type { Metadata } from "next";
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

export const metadata: Metadata = {
  title: "Copy Trading - Yieldr",
  description: "Manual copy trading dashboard for Polymarket",
};

export default async function CopyTradingRootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const secret = process.env.DASHBOARD_SECRET;
  if (secret) {
    const cookieStore = await cookies();
    const token = cookieStore.get('dashboard_auth')?.value;
    if (token !== secret) {
      redirect('https://yieldr.org');
    }
  }
  return <>{children}</>;
}
