/**
 * POST /api/copy-trading/admin/redeem-all
 *
 * Spawns services/.private/poly-agent/redeem-positions.ts --execute.
 * Requires BOT_PRIVATE_KEY + POLYGON_RPC_URL in the poly-agent .env — so it only
 * works when Next.js runs on the same host as the poly-agent scripts (i.e. localhost
 * or the bot service). Gated on NODE_ENV !== 'production' to keep it off Vercel.
 *
 * Response: { success, exitCode, stdout, stderr }
 */
import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'child_process';
import * as path from 'path';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const POLY_AGENT_DIR = path.resolve(process.cwd(), 'services/.private/poly-agent');
const SCRIPT_PATH    = path.join(POLY_AGENT_DIR, 'redeem-positions.ts');

export async function POST(_req: NextRequest) {
  if (process.env.NODE_ENV === 'production') {
    const serviceUrl = process.env.PIPELINE_SERVICE_URL;
    const token      = process.env.ADMIN_TOKEN;
    if (!serviceUrl || !token) {
      return NextResponse.json(
        { success: false, error: 'PIPELINE_SERVICE_URL / ADMIN_TOKEN not configured on this deployment' },
        { status: 503 },
      );
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 240_000);
      let upstream: Response;
      try {
        upstream = await fetch(`${serviceUrl}/admin/redeem-all`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          signal:  controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      const text = await upstream.text();
      let data: any;
      try { data = JSON.parse(text); } catch { data = { success: false, error: `Non-JSON response from pipeline service: ${text.slice(0, 200)}` }; }
      return NextResponse.json(data, { status: upstream.status });
    } catch (e: any) {
      return NextResponse.json({ success: false, error: `Proxy error: ${e.message}` }, { status: 502 });
    }
  }

  const { exitCode, stdout, stderr } = await runScript([SCRIPT_PATH, '--execute']);
  return NextResponse.json({ success: exitCode === 0, exitCode, stdout, stderr });
}

// Keys owned by poly-agent/.env.polyagent. Stripped from the spawned env so the
// script's dotenv.config() can load the authoritative values from disk instead
// of inheriting (possibly placeholder) versions from the Next.js parent process.
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

function runScript(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const tag = '[redeem-all]';
    console.log(`${tag} spawn: npx tsx ${args.join(' ')}`);
    const startMs = Date.now();

    const proc = spawn('npx', ['tsx', ...args], {
      cwd: POLY_AGENT_DIR,
      env: cleanEnv(),
    });

    let stdout = '';
    let stderr = '';

    // Stream to the Next.js server terminal so progress is visible
    // while the request is in flight.
    proc.stdout.on('data', (d: Buffer) => {
      const s = d.toString();
      stdout += s;
      process.stdout.write(`${tag} ${s}`);
    });
    proc.stderr.on('data', (d: Buffer) => {
      const s = d.toString();
      stderr += s;
      process.stderr.write(`${tag} ${s}`);
    });

    proc.on('close', (code: number | null) => {
      console.log(`${tag} exit=${code} in ${((Date.now() - startMs) / 1000).toFixed(1)}s`);
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });
    proc.on('error', (err: Error) => {
      console.error(`${tag} spawn error:`, err.message);
      resolve({ exitCode: -1, stdout, stderr: stderr + '\n' + err.message });
    });
  });
}
