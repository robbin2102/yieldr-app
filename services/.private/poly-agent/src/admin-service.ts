/**
 * Admin Service — sell/redeem endpoints only
 * No trading bot, no pipeline, no cron jobs.
 * Deployed on Fly.io to proxy admin commands from Vercel.
 */

import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env.local') });
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config({ path: path.resolve(__dirname, '../env.polyagent') });

import * as http from 'http';
import { spawn } from 'child_process';

const PORT = parseInt(process.env.PORT || '3001');
const POLY_AGENT_DIR = path.resolve(__dirname, '..');

function runAdminScript(args: string[], tag: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    console.log(`${tag} spawn: npx tsx ${args.join(' ')}`);
    const startMs = Date.now();
    const proc = spawn('npx', ['tsx', ...args], { cwd: POLY_AGENT_DIR, env: process.env });
    let stdout = '', stderr = '';
    proc.stdout.on('data', (d: Buffer) => { const s = d.toString(); stdout += s; process.stdout.write(`${tag} ${s}`); });
    proc.stderr.on('data', (d: Buffer) => { const s = d.toString(); stderr += s; process.stderr.write(`${tag} ${s}`); });
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

function parseBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}

function cors(res: http.ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function json(res: http.ServerResponse, status: number, data: object): void {
  cors(res);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function checkAuth(req: http.IncomingMessage): boolean {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return false;
  return (req.headers['authorization'] ?? '') === `Bearer ${token}`;
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'poly-agent-admin', timestamp: new Date().toISOString() }));
    return;
  }

  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); res.end(); return; }

  if (req.method === 'POST' && req.url === '/admin/sell-position') {
    if (!checkAuth(req)) return json(res, 401, { success: false, error: 'Unauthorized' });
    let body: any;
    try { body = await parseBody(req); } catch { return json(res, 400, { success: false, error: 'Invalid JSON' }); }
    const { tokenId, size } = body as { tokenId?: string; size?: number };
    if (!tokenId || typeof tokenId !== 'string' || !/^\d+$/.test(tokenId))
      return json(res, 400, { success: false, error: 'tokenId (numeric string) required' });
    const sizeNum = Number(size);
    if (!Number.isFinite(sizeNum) || sizeNum <= 0)
      return json(res, 400, { success: false, error: 'size (positive number) required' });
    const scriptPath = path.join(POLY_AGENT_DIR, 'sell-position.ts');
    const result = await runAdminScript([scriptPath, '--token', tokenId, '--size', String(sizeNum)], '[sell-position]');
    return json(res, 200, { success: result.exitCode === 0, ...result });
  }

  if (req.method === 'POST' && req.url === '/admin/redeem-all') {
    if (!checkAuth(req)) return json(res, 401, { success: false, error: 'Unauthorized' });
    const scriptPath = path.join(POLY_AGENT_DIR, 'redeem-positions.ts');
    const result = await runAdminScript([scriptPath, '--execute'], '[redeem-all]');
    return json(res, 200, { success: result.exitCode === 0, ...result });
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Admin] Service running on port ${PORT}`);
  console.log(`[Admin] Endpoints: /health, /admin/sell-position, /admin/redeem-all`);
});

process.on('SIGTERM', () => { server.close(); process.exit(0); });
process.on('SIGINT',  () => { server.close(); process.exit(0); });
