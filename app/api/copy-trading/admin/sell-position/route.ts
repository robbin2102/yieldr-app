import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'child_process';
import * as path from 'path';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const POLY_AGENT_DIR = path.resolve(process.cwd(), 'services/.private/poly-agent');
const SCRIPT_PATH    = path.join(POLY_AGENT_DIR, 'sell-position.ts');

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  'Connection': 'keep-alive',
  'X-Accel-Buffering': 'no',
};

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { tokenId, size } = body as { tokenId?: string; size?: number };

  if (!tokenId || typeof tokenId !== 'string' || !/^\d+$/.test(tokenId))
    return NextResponse.json({ success: false, error: 'tokenId (numeric string) required' }, { status: 400 });
  const sizeNum = Number(size);
  if (!Number.isFinite(sizeNum) || sizeNum <= 0)
    return NextResponse.json({ success: false, error: 'size (positive number) required' }, { status: 400 });

  // Production: proxy SSE stream from Fly.io admin-service
  if (process.env.NODE_ENV === 'production') {
    const serviceUrl = process.env.PIPELINE_SERVICE_URL;
    const token      = process.env.ADMIN_TOKEN;
    if (!serviceUrl || !token)
      return NextResponse.json({ success: false, error: 'PIPELINE_SERVICE_URL / ADMIN_TOKEN not configured' }, { status: 503 });
    try {
      const upstream = await fetch(`${serviceUrl}/admin/sell-position`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body:    JSON.stringify({ tokenId, size: sizeNum }),
      });
      return new NextResponse(upstream.body, { headers: SSE_HEADERS });
    } catch (e: any) {
      return NextResponse.json({ success: false, error: `Proxy error: ${e.message}` }, { status: 502 });
    }
  }

  // Local dev: spawn script and emit SSE lines
  const stream = new ReadableStream({
    start(controller) {
      const enc  = new TextEncoder();
      const emit = (obj: object) => controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
      const args = [SCRIPT_PATH, '--token', tokenId, '--size', String(sizeNum)];
      const proc = spawn('npx', ['tsx', ...args], { cwd: POLY_AGENT_DIR, env: cleanEnv() });
      proc.stdout.on('data', (d: Buffer) => {
        d.toString().split('\n').forEach(line => { if (line.trim()) emit({ line }); });
      });
      proc.stderr.on('data', (d: Buffer) => {
        d.toString().split('\n').forEach(line => { if (line.trim()) emit({ line }); });
      });
      proc.on('close', (code: number | null) => { emit({ done: true, exitCode: code ?? -1 }); controller.close(); });
      proc.on('error', (err: Error) => { emit({ done: true, exitCode: -1, error: err.message }); controller.close(); });
    },
  });
  return new NextResponse(stream, { headers: SSE_HEADERS });
}

const POLY_AGENT_OWNED_KEYS = [
  'BOT_WALLET_ADDRESS', 'BOT_PRIVATE_KEY',
  'POLYMARKET_API_KEY', 'POLYMARKET_API_SECRET', 'POLYMARKET_PASSPHRASE',
  'POLYGON_RPC_URL', 'CHAIN_ID',
  'DATA_API_BASE', 'CLOB_API_BASE', 'WSS_MARKET', 'WSS_USER',
];
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of POLY_AGENT_OWNED_KEYS) delete env[k];
  return env;
}
