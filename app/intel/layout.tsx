import { Providers } from "@/components/RainbowKitProvider";

export default function IntelLayout({ children }: { children: React.ReactNode }) {
  return <Providers>{children}</Providers>;
}
