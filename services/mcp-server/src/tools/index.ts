/**
 * Tool Registry - Exports all MCP tools
 */

import { getTopPMTradersTool } from './top-traders/get-top-pm-traders.js';
import { getTopPerpTradersTool } from './top-traders/get-top-perp-traders.js';
import { compareTradersTool } from './top-traders/compare-traders.js';

// Trading tools
import { getStrategyTemplateTool } from './trading/strategy-templates.js';
import { openTradeTool } from './trading/open-trade.js';
import { closeTradeTool } from './trading/close-trade.js';
import { cancelLimitOrderTool } from './trading/cancel-limit-order.js';

// Live API tools - Open positions
import { getHLPositionsTool } from './live-api/get-hl-positions.js';
import { getAvantisPositionsTool } from './live-api/get-avantis-positions.js';
import { getPMPositionsTool } from './live-api/get-pm-positions.js';

// Live API tools - Trade history / Closed positions
import { getHLTradeHistoryTool } from './live-api/get-hl-trade-history.js';
import { getPMClosedPositionsTool } from './live-api/get-pm-closed-positions.js';

// Live API tools - Portfolio / PnL history
import { getHLPortfolioTool } from './live-api/get-hl-portfolio.js';

// Polymarket market data + user activity
import { getPMMarketTool } from './live-api/get-pm-market.js';
import { getPMUserActivityTool } from './live-api/get-pm-user-activity.js';

// Market intelligence tools
import { getMarketSnapshotTool } from './market/get-market-snapshot.js';
import { fetchLiveIndicatorTool } from './market/fetch-live-indicator.js';
import { getMacroSnapshotTool } from './market/get-macro-snapshot.js';
import { getFundingRateHistoryTool } from './market/get-funding-rate-history.js';
import { getFundingRateCurrentTool } from './market/get-funding-rate-current.js';
import { getDerivativesHistoryTool } from './market/get-derivatives-history.js';
import { getNewsHeadlinesTool } from './market/get-news-headlines.js';
import { getCoinPriceTool } from './market/get-coin-price.js';

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
  getPMMarketTool,
  getPMUserActivityTool,
} from './live-api/index.js';
export { getMarketSnapshotTool, fetchLiveIndicatorTool, getCoinPriceTool, getMacroSnapshotTool, getFundingRateHistoryTool, getFundingRateCurrentTool, getDerivativesHistoryTool, getNewsHeadlinesTool } from './market/index.js';
export { getStrategyTemplateTool, openTradeTool, closeTradeTool, cancelLimitOrderTool } from './trading/index.js';

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
  getCoinPriceTool,
  // Market intelligence - daily macro (ETF flows, Fear/Greed, Coinbase premium)
  getMacroSnapshotTool,
  // Binance funding rates — historical (8h settled) and current/predicted (1h premium index)
  getFundingRateHistoryTool,
  getFundingRateCurrentTool,
  // Binance derivatives history (15m OI + L/S ratios)
  getDerivativesHistoryTool,
  // Live RSS news headlines (BBC, AJZ, Sky, NPR, CoinTelegraph)
  getNewsHeadlinesTool,
  // Polymarket market data (odds, volume, outcomes) + user activity
  getPMMarketTool,
  getPMUserActivityTool,
<<<<<<< HEAD
=======
  // Strategy templates + signal catalog
  getStrategyTemplateTool,
  // Trade execution: open, close, cancel
  openTradeTool,
  closeTradeTool,
  cancelLimitOrderTool,
>>>>>>> origin/claude/trader-agent-execution-l7pev
];

// Tool map for quick lookup
export const toolMap = new Map(tools.map(t => [t.name, t]));
