import { NextResponse } from "next/server";

export async function GET() {
  const url = process.env.HL_SIGNALS_API_URL;
  const configured = !!url && url !== "http://localhost:8000";

  let railwayReachable = false;
  let railwayStatus: number | null = null;

  if (configured && url) {
    try {
      const res = await fetch(`${url.replace(/\/$/, "")}/health`, {
        cache: "no-store",
        signal: AbortSignal.timeout(5000),
      });
      railwayStatus = res.status;
      railwayReachable = res.ok;
    } catch {
      railwayReachable = false;
    }
  }

  return NextResponse.json({
    env_var_set: configured,
    // show only the host, not the full URL, for security
    upstream_host: url ? (() => { try { return new URL(url).host; } catch { return "invalid-url"; } })() : null,
    railway_reachable: railwayReachable,
    railway_status: railwayStatus,
  });
}
