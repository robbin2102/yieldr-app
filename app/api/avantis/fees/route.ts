import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function normalizeUrl(url: string) {
  return !url.startsWith('http://') && !url.startsWith('https://') ? `https://${url}` : url;
}
const PYTHON_URL = normalizeUrl(process.env.PYTHON_SERVICE_URL || 'http://localhost:8001');
const API_KEY    = process.env.YIELDR_DATA_API_SECRET || process.env.API_KEY || '';

// GET /api/avantis/fees?pair=BTC/USD&collateral=10&leverage=5&is_long=true
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const pair       = searchParams.get('pair');
    const collateral = searchParams.get('collateral');
    const leverage   = searchParams.get('leverage');
    const is_long    = searchParams.get('is_long');

    if (!pair || !collateral || !leverage || is_long === null) {
      return NextResponse.json(
        { error: 'Required: pair, collateral, leverage, is_long' },
        { status: 400 }
      );
    }

    const qs = new URLSearchParams({ pair, collateral, leverage, is_long });
    const res = await fetch(`${PYTHON_URL}/trade/fees?${qs}`, {
      headers: { 'X-API-Key': API_KEY },
      signal: AbortSignal.timeout(30_000),
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.detail || `Python service error ${res.status}`);
    }

    return NextResponse.json({ success: true, ...data });
  } catch (err: any) {
    console.error('[avantis/fees] error:', err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
