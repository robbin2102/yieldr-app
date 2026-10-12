import Link from "next/link";
export function Header({
  label = "Edge Detection",
  landing = false,
}: {
  label?: string;
  landing?: boolean;
}) {
  return (
    <header className={`edge-header ${landing ? "landing-header" : ""}`}>
      <Link href="/edge" className="edge-brand">
        <img className="brand-mark" src="/edge/yieldr-icon.png" alt="" width={28} height={28} />
        Yieldr
      </Link>
      <nav aria-label="Main navigation">
        <span className="edge-chip">{label}</span>
        <Link href={landing ? "#how" : "/edge"}>
          {landing ? "How it works" : "New wallet"}
        </Link>
      </nav>
    </header>
  );
}
export function money(v: string | null) {
  if (v === null) return "Unavailable";
  const n = Number(v);
  return Number.isFinite(n)
    ? new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 2,
      }).format(n)
    : "Unavailable";
}
export function pct(v: string | null) {
  return v === null ? "Unavailable" : `${Number(v).toFixed(1)}%`;
}
export function date(v: string | null) {
  return v
    ? new Date(v).toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      })
    : "Unavailable";
}
export function human(v: string) {
  return v.replaceAll("_", " ");
}
export { errors, fetchJson } from "@/lib/edge/client";
