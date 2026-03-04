import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../../.env.local') });

function required(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

export const config = {
  port: parseInt(process.env.PORT || '3002'),
  get mongodbUri() { return required('MONGODB_URI'); },
  get mcpServerUrl() { return required('MCP_SERVER_URL'); },
  get anthropicApiKey() { return required('ANTHROPIC_API_KEY'); },
  schedulerLoopMs: parseInt(process.env.SCHEDULER_LOOP_MS || '60000'),
  maxConsecutiveErrors: parseInt(process.env.MAX_CONSECUTIVE_ERRORS || '5'),
  // Position refresh intervals
  positionRefreshMs: parseInt(process.env.POSITION_REFRESH_MS || '120000'),       // 2 min
  avantisRefreshMs: parseInt(process.env.AVANTIS_REFRESH_MS || '600000'),          // 10 min
};
