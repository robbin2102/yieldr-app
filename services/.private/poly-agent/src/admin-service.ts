/**
 * Admin Service — sell/redeem + bot start/stop
 * No pipeline, no cron jobs. Deployed on Fly.io.
 */

import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env.local') });
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config({ path: path.resolve(__dirname, '../env.polyagent') });

import * as http from 'http';
import { spawn, ChildProcess } from 'child_process';

const PORT = parseInt(process.env.PORT || '3001');
const POLY_AGENT_DIR = path.resolve(__dirname, '..');

// ── Bot process management ─────────────────────────────────────────────────────
let botProcess: ChildProcess | null = null;

function isBotRunning(): boolean {
  return botProcess !== null && !botProcess.killed && botProcess.exitCode === null;
}

function startBot(): { success: boolean; message: string } {
  if (isBotRunning()) return { success: false, message: 'Bot is already running' };
  console.log('[Admin] Starting v2 trading bot...');
  botProcess = spawn('node', ['src/v2/index.js'], {
    cwd: POLY_AGENT_DIR,
    env: process.env,
    stdio: 'inherit',
  });
  botProcess.on('exit', (code) => {
    console.log(`[Admin] Bot process exited with code ${code}`);
    botProcess = null;
  });
  botProcess.on('error', (err) => {
    console.error('[Admin] Bot process error:', err.message);
    botProcess = null;
  });
  return { success: true, message: 'Bot started' };
}

function stopBot(): { success: boolean; message: string } {
  if (!isBotRunning()) return { success: false, message: 'Bot is not running' };
  console.log('[Admin] Stopping trading bot...');
  botProcess!.kill('SIGTERM');
  return { success: true, message: 'Bot stop signal sent' };
}

// ── Admin script runner (sell/redeem) ─────────────────────────────────────────
function runAdminScript(args: string[], tag: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    console.log(`${tag} spawn: node ${args.join(' ')}`);
    const startMs = Date.now();
    const proc = spawn('node', args, { cwd: POLY_AGENT_DIR, env: process.env });
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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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

  // GET /admin/bot-status
  if (req.method === 'GET' && req.url === '/admin/bot-status') {
    if (!checkAuth(req)) return json(res, 401, { success: false, error: 'Unauthorized' });
    return json(res, 200, { success: true, running: isBotRunning() });
  }

  // POST /admin/start-bot
  if (req.method === 'POST' && req.url === '/admin/start-bot') {
    if (!checkAuth(req)) return json(res, 401, { success: false, error: 'Unauthorized' });
    const result = startBot();
    return json(res, 200, { success: result.success, message: result.message });
  }

  // POST /admin/stop-bot
  if (req.method === 'POST' && req.url === '/admin/stop-bot') {
    if (!checkAuth(req)) return json(res, 401, { success: false, error: 'Unauthorized' });
    const result = stopBot();
    return json(res, 200, { success: result.success, message: result.message });
  }

  // POST /admin/sell-position  — SSE streaming
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

    cors(res);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    const scriptPath = path.join(POLY_AGENT_DIR, 'sell-position.js');
    console.log(`[sell-position] stream: node ${scriptPath} --token ${tokenId} --size ${sizeNum}`);
    const proc = spawn('node', [scriptPath, '--token', tokenId, '--size', String(sizeNum)], {
      cwd: POLY_AGENT_DIR, env: process.env,
    });
    const emit = (obj: object) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    proc.stdout.on('data', (d: Buffer) => {
      d.toString().split('\n').forEach(line => { if (line.trim()) emit({ line }); });
    });
    proc.stderr.on('data', (d: Buffer) => {
      d.toString().split('\n').forEach(line => { if (line.trim()) emit({ line }); });
    });
    proc.on('close', (code: number | null) => { emit({ done: true, exitCode: code ?? -1 }); res.end(); });
    proc.on('error', (err: Error) => { emit({ done: true, exitCode: -1, error: err.message }); res.end(); });
    return;
  }

  // POST /admin/redeem-all
  if (req.method === 'POST' && req.url === '/admin/redeem-all') {
    if (!checkAuth(req)) return json(res, 401, { success: false, error: 'Unauthorized' });
    const scriptPath = path.join(POLY_AGENT_DIR, 'redeem-positions.js');
    const result = await runAdminScript([scriptPath, '--execute'], '[redeem-all]');
    return json(res, 200, { success: result.exitCode === 0, ...result });
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Admin] Service running on port ${PORT}`);
  console.log(`[Admin] Endpoints: /health, /admin/bot-status, /admin/start-bot, /admin/stop-bot, /admin/sell-position, /admin/redeem-all`);

  // Auto-start the v2 bot on container startup unless explicitly disabled.
  // Set BOT_AUTOSTART=false in env to skip (e.g. for debugging admin endpoints).
  if (process.env.BOT_AUTOSTART !== 'false') {
    const result = startBot();
    console.log(`[Admin] BOT_AUTOSTART: ${result.message}`);
  } else {
    console.log('[Admin] BOT_AUTOSTART=false — bot not started automatically');
  }
});

process.on('SIGTERM', () => { if (isBotRunning()) botProcess!.kill('SIGTERM'); server.close(); process.exit(0); });
process.on('SIGINT',  () => { if (isBotRunning()) botProcess!.kill('SIGTERM'); server.close(); process.exit(0); });
