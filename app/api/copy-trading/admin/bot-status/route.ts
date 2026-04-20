import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

function proxyHeaders(token: string) {
  return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };
}

export async function GET(_req: NextRequest) {
  const serviceUrl = process.env.PIPELINE_SERVICE_URL;
  const token      = process.env.ADMIN_TOKEN;
  if (!serviceUrl || !token) {
    return NextResponse.json({ success: true, running: false, error: 'Service not configured' });
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    let upstream: Response;
    try {
      upstream = await fetch(`${serviceUrl}/admin/bot-status`, {
        method: 'GET', headers: proxyHeaders(token), signal: controller.signal,
      });
    } finally { clearTimeout(timer); }
    const data = await upstream.json().catch(() => ({ success: false, running: false }));
    return NextResponse.json(data, { status: upstream.status });
  } catch {
    return NextResponse.json({ success: true, running: false });
  }
}
