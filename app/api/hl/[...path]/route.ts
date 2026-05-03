import { NextRequest, NextResponse } from "next/server";

const UPSTREAM =
  process.env.HL_SIGNALS_API_URL?.replace(/\/$/, "") ?? "http://localhost:8000";

async function proxy(req: NextRequest, path: string[]) {
  const upstream = `${UPSTREAM}/${path.join("/")}${req.nextUrl.search}`;

  const init: RequestInit = {
    method: req.method,
    headers: { "Content-Type": "application/json" },
    // don't cache — data changes every 5 min
    cache: "no-store",
  };

  if (req.method === "POST") {
    const body = await req.text();
    if (body) init.body = body;
  }

  try {
    const res = await fetch(upstream, init);
    const json = await res.json();
    return NextResponse.json(json, { status: res.status });
  } catch (err) {
    const configured = !!process.env.HL_SIGNALS_API_URL;
    return NextResponse.json(
      { error: "HL Signals service unreachable", env_var_set: configured },
      { status: 503 }
    );
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params;
  return proxy(req, path);
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params;
  return proxy(req, path);
}
