/**
 * Tool Registry - Exports all MCP tools
 */

import { getTopPMTradersTool } from './top-traders/get-top-pm-traders.js';
import { getTopPerpTradersTool } from './top-traders/get-top-perp-traders.js';
import { compareTradersTool } from './top-traders/compare-traders.js';

// Live API tools - Open positions
import { getHLPositionsTool } from './live-api/get-hl-positions.js';
import { getAvantisPositionsTool } from './live-api/get-avantis-positions.js';
import { getPMPositionsTool } from './live-api/get-pm-positions.js';

// Live API tools - Trade history / Closed positions
import { getHLTradeHistoryTool } from './live-api/get-hl-trade-history.js';
import { getPMClosedPositionsTool } from './live-api/get-pm-closed-positions.js';

// Live API tools - Portfolio / PnL history
import { getHLPortfolioTool } from './live-api/get-hl-portfolio.js';

// Market intelligence tools
import { getMarketSnapshotTool } from './market/get-market-snapshot.js';
import { fetchLiveIndicatorTool } from './market/fetch-live-indicator.js';
import { getMacroSnapshotTool } from './market/get-macro-snapshot.js';
import { getFundingRateHistoryTool } from './market/get-funding-rate-history.js';
import { getDerivativesHistoryTool } from './market/get-derivatives-history.js';

// Export individual tools
export { getTopPMTradersTool } from './top-traders/index.js';
export { getTopPerpTradersTool } from './top-traders/index.js';
export { compareTradersTool } from './top-traders/index.js';
export {
  getHLPositionsTool,
  getAvantisPositionsTool,
  getPMPositionsTool,
  getHLTradeHistoryTool,
  getPMClosedPositionsTool,
  getHLPortfolioTool,
} from './live-api/index.js';
export { getMarketSnapshotTool, fetchLiveIndicatorTool, getMacroSnapshotTool, getFundingRateHistoryTool, getDerivativesHistoryTool } from './market/index.js';

// Tool registry for MCP server
export const tools = [
  // Indexed data queries (from MongoDB)
  getTopPMTradersTool,
  getTopPerpTradersTool,
  compareTradersTool,
  // Live API queries - Open positions
  getHLPositionsTool,
  getAvantisPositionsTool,
  getPMPositionsTool,
  // Live API queries - Trade history / Closed positions
  getHLTradeHistoryTool,
  getPMClosedPositionsTool,
  // Live API queries - Portfolio / PnL history
  getHLPortfolioTool,
  // Market intelligence - indexed snapshots
  getMarketSnapshotTool,
  // Market intelligence - live TAAPI fetch
  fetchLiveIndicatorTool,
  // Market intelligence - daily macro (ETF flows, Fear/Greed, Coinbase premium)
  getMacroSnapshotTool,
  // Binance derivatives history (1h funding rates, 15m OI + L/S ratios)
  getFundingRateHistoryTool,
  getDerivativesHistoryTool,
];

// Tool map for quick lookup
export const toolMap = new Map(tools.map(t => [t.name, t]));
