import type { Metadata } from "next";
import "../globals.css";

export const metadata: Metadata = {
  title: "Copy Trading - Yieldr",
  description: "Manual copy trading dashboard for Polymarket",
};

export default function CopyTradingRootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="antialiased">
        {children}
      </body>
    </html>
  );
}
