/**
 * Tool Registry - Exports all MCP tools
 */

import { getTopPMTradersTool } from './top-traders/get-top-pm-traders.js';
import { getTopPerpTradersTool } from './top-traders/get-top-perp-traders.js';
import { compareTradersTool } from './top-traders/compare-traders.js';

// Live API tools
import { getHLPositionsTool } from './live-api/get-hl-positions.js';
import { getAvantisPositionsTool } from './live-api/get-avantis-positions.js';
import { getPMPositionsTool } from './live-api/get-pm-positions.js';

// Export individual tools
export { getTopPMTradersTool } from './top-traders/index.js';
export { getTopPerpTradersTool } from './top-traders/index.js';
export { compareTradersTool } from './top-traders/index.js';
export { getHLPositionsTool, getAvantisPositionsTool, getPMPositionsTool } from './live-api/index.js';

// Tool registry for MCP server
export const tools = [
  // Indexed data queries
  getTopPMTradersTool,
  getTopPerpTradersTool,
  compareTradersTool,
  // Live API queries
  getHLPositionsTool,
  getAvantisPositionsTool,
  getPMPositionsTool,
];

// Tool map for quick lookup
export const toolMap = new Map(tools.map(t => [t.name, t]));
