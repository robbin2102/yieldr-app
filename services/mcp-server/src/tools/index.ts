/**
 * Tool Registry - Exports all MCP tools
 */

import { getTopPMTradersTool } from './top-traders/get-top-pm-traders.js';
import { getTopPerpTradersTool } from './top-traders/get-top-perp-traders.js';
import { compareTradersTool } from './top-traders/compare-traders.js';

// Export individual tools
export { getTopPMTradersTool } from './top-traders/index.js';
export { getTopPerpTradersTool } from './top-traders/index.js';
export { compareTradersTool } from './top-traders/index.js';

// Tool registry for MCP server
export const tools = [
  getTopPMTradersTool,
  getTopPerpTradersTool,
  compareTradersTool,
];

// Tool map for quick lookup
export const toolMap = new Map(tools.map(t => [t.name, t]));
