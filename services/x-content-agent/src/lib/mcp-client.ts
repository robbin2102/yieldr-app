/**
 * MCP Server Client
 *
 * Calls the yieldr-mcp-server HTTP API to fetch data via MCP tools.
 * This is how the X Content Agent gets trader data, market data, etc.
 */

import axios from 'axios';
import { CONFIG } from '../config';

/**
 * Call an MCP tool via HTTP
 */
export async function callMcpTool(toolName: string, params: Record<string, any> = {}): Promise<any> {
  const baseUrl = process.env.MCP_SERVER_URL || CONFIG.MCP_SERVER_URL;
  try {
    const response = await axios.post(
      `${baseUrl}/tools/${toolName}`,
      { params },
      {
        timeout: 30000,
        headers: { 'Content-Type': 'application/json' },
      }
    );

    return response.data;
  } catch (error: any) {
    console.error(`[MCP] Error calling ${toolName}:`, error.message);
    throw error;
  }
}

// ═══════════════════════════════════════════════════════════════
// Convenience wrappers for X Agent tools
// ═══════════════════════════════════════════════════════════════

export async function getEdgeRankedTraders(opts?: {
  category?: string;
  sortBy?: string;
  limit?: number;
}) {
  return callMcpTool('get_edge_ranked_traders', opts || {});
}

export async function getHighConvictionTrades(opts?: {
  convictionLevel?: string;
  hours?: number;
  unposted?: boolean;
  limit?: number;
}) {
  return callMcpTool('get_high_conviction_trades', opts || {});
}

export async function getCopyTradeActivity(opts?: {
  vaultName?: string;
  hours?: number;
  limit?: number;
  minConvictionRatio?: number;
}) {
  return callMcpTool('get_copy_trade_activity', opts || {});
}

export async function searchMarketsByKeyword(keywords: string[], opts?: {
  activeOnly?: boolean;
  minVolume?: number;
  limit?: number;
}) {
  return callMcpTool('search_markets_by_keyword', { keywords, ...opts });
}

export async function getTraderPositionsInMarket(opts: {
  conditionId?: string;
  marketSlug?: string;
  keyword?: string;
  edgeTradersOnly?: boolean;
}) {
  return callMcpTool('get_trader_positions_in_market', opts);
}

export async function getVaultPerformance(opts?: {
  vaultName?: string;
  period?: string;
}) {
  return callMcpTool('get_vault_performance', opts || {});
}

export async function getVaultTrades(opts?: {
  vaultName?: string;
  hours?: number;
  limit?: number;
}) {
  return callMcpTool('get_vault_trades', opts || {});
}

export async function getPmPositions(wallet: string) {
  return callMcpTool('get_pm_positions', { wallet });
}
