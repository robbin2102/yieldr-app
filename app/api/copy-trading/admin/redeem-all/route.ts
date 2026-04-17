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
    return NextResponse.json(
      { success: false, error: 'Admin actions are disabled in production. Run on localhost or via the bot service.' },
      { status: 403 },
    );
  }

  const { exitCode, stdout, stderr } = await runScript([SCRIPT_PATH, '--execute']);
  return NextResponse.json({ success: exitCode === 0, exitCode, stdout, stderr });
}

function runScript(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn('npx', ['tsx', ...args], {
      cwd: POLY_AGENT_DIR,
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('close', (code: number | null) => resolve({ exitCode: code ?? -1, stdout, stderr }));
    proc.on('error', (err: Error) => resolve({ exitCode: -1, stdout, stderr: stderr + '\n' + err.message }));
  });
}
