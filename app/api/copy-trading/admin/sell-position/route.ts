/**
 * POST /api/copy-trading/admin/sell-position
 * Body: { tokenId: string, size: number }
 *
 * Spawns services/.private/poly-agent/sell-position.ts --token X --size Y.
 * Localhost only — see redeem-all/route.ts for rationale.
 *
 * Response: { success, exitCode, stdout, stderr }
 */
import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'child_process';
import * as path from 'path';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const POLY_AGENT_DIR = path.resolve(process.cwd(), 'services/.private/poly-agent');
const SCRIPT_PATH    = path.join(POLY_AGENT_DIR, 'sell-position.ts');

export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json(
      { success: false, error: 'Admin actions are disabled in production. Run on localhost or via the bot service.' },
      { status: 403 },
    );
  }

  const body = await req.json().catch(() => ({}));
  const { tokenId, size } = body as { tokenId?: string; size?: number };

  if (!tokenId || typeof tokenId !== 'string' || !/^\d+$/.test(tokenId)) {
    return NextResponse.json({ success: false, error: 'tokenId (numeric string) required' }, { status: 400 });
  }
  const sizeNum = Number(size);
  if (!Number.isFinite(sizeNum) || sizeNum <= 0) {
    return NextResponse.json({ success: false, error: 'size (positive number) required' }, { status: 400 });
  }

  const args = [SCRIPT_PATH, '--token', tokenId, '--size', String(sizeNum)];
  const { exitCode, stdout, stderr } = await runScript(args);
  return NextResponse.json({ success: exitCode === 0, exitCode, stdout, stderr });
}

function runScript(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn('npx', ['tsx', ...args], {
      cwd:   POLY_AGENT_DIR,
      env:   process.env,
      shell: true,
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => resolve({ exitCode: code ?? -1, stdout, stderr }));
    proc.on('error', (err)  => resolve({ exitCode: -1, stdout, stderr: stderr + '\n' + err.message }));
  });
}
