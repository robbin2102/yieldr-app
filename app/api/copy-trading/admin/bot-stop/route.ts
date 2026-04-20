import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(_req: NextRequest) {
  const serviceUrl = process.env.PIPELINE_SERVICE_URL;
  const token      = process.env.ADMIN_TOKEN;
  if (!serviceUrl || !token) {
    return NextResponse.json({ success: false, error: 'PIPELINE_SERVICE_URL / ADMIN_TOKEN not configured' }, { status: 503 });
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    let upstream: Response;
    try {
      upstream = await fetch(`${serviceUrl}/admin/stop-bot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        signal: controller.signal,
      });
    } finally { clearTimeout(timer); }
    const text = await upstream.text();
    let data: any;
    try { data = JSON.parse(text); } catch { data = { success: false, error: `Non-JSON: ${text.slice(0, 200)}` }; }
    return NextResponse.json(data, { status: upstream.status });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: `Proxy error: ${e.message}` }, { status: 502 });
  }
}
