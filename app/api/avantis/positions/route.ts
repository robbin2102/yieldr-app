import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function normalizeUrl(url: string) {
  return !url.startsWith('http://') && !url.startsWith('https://') ? `https://${url}` : url;
}
const PYTHON_URL = normalizeUrl(process.env.PYTHON_SERVICE_URL || 'http://localhost:8001');
const API_KEY    = process.env.YIELDR_DATA_API_SECRET || process.env.API_KEY || '';

export async function GET(_request: NextRequest) {
  try {
    const res = await fetch(`${PYTHON_URL}/trade/positions`, {
      headers: { 'X-API-Key': API_KEY },
      signal: AbortSignal.timeout(30_000),
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.detail || `Python service error ${res.status}`);
    }

    return NextResponse.json({ success: true, ...data });
  } catch (err: any) {
    console.error('[avantis/positions] error:', err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
