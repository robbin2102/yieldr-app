import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "@/components/RainbowKitProvider";

export const metadata: Metadata = {
  title: "Yieldr - Discover Asset Managers",
  description: "Co-invest with top crypto asset managers",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">
        <Providers>
          {children}
        </Providers>
      </body>
    </html>
  );
}
