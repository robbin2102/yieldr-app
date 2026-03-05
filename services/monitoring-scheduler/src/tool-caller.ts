import { config } from './config';
import { logger } from './utils/logger';
import { extractFields, extractWallets } from './utils/field-extractor';
import { ToolConfig } from './db/monitoring';

const TOOL_TIMEOUT_MS = 30_000;

/**
 * Call a single MCP tool via HTTP POST to the MCP server's HTTP endpoint.
 * POST /tools/:toolName  { params: { ... } }
 */
export async function callMCPTool(toolName: string, params: Record<string, any>): Promise<any> {
  const url = `${config.mcpServerUrl}/tools/${toolName}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TOOL_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`MCP tool ${toolName} returned ${res.status}: ${text}`);
    }

    return await res.json();
  } catch (err: any) {
    if (err.name === 'AbortError') {
      throw new Error(`MCP tool ${toolName} timed out after ${TOOL_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Execute all tools in a task in sequence, extract the requested fields,
 * and return a single stripped data object for the evaluator.
 *
 * Tool chaining: if a tool param has walletAddresses = [] (empty array),
 * the scheduler fills it automatically from the previous tool's response.
 */
export async function callToolsAndExtract(
  tools: ToolConfig[]
): Promise<Record<string, any>> {
  const strippedData: Record<string, any> = {};
  let previousResponse: any = null;

  for (let i = 0; i < tools.length; i++) {
    const toolConfig = tools[i];
    let params = { ...toolConfig.toolParams };

    // Tool chaining: fill empty walletAddresses from the previous tool's wallets
    if (
      previousResponse !== null &&
      Array.isArray(params.walletAddresses) &&
      params.walletAddresses.length === 0
    ) {
      const wallets = extractWallets(previousResponse).slice(0, 10);
      if (wallets.length === 0) {
        logger.warn('ToolCaller', `Tool chaining: no wallets found in previous response for tool ${toolConfig.toolName}`);
      }
      params = { ...params, walletAddresses: wallets };
      logger.debug('ToolCaller', `Tool chaining: injected ${wallets.length} wallets into ${toolConfig.toolName}`);
    }

    logger.info('ToolCaller', `Calling ${toolConfig.toolName}`, { params });
    const response = await callMCPTool(toolConfig.toolName, params);
    previousResponse = response;

    // Extract only the requested fields, namespaced by tool index to avoid collisions
    const toolKey = `tool${i}_${toolConfig.toolName}`;
    const extracted = extractFields(response, toolConfig.extractFields);

    // Merge into strippedData — if multiple tools extract the same field path,
    // prefix with tool name to keep them separate
    const hasConflict = toolConfig.extractFields.some((f) => f in strippedData);
    if (hasConflict || tools.length === 1) {
      Object.assign(strippedData, extracted);
    } else {
      strippedData[toolKey] = extracted;
    }

    logger.debug('ToolCaller', `Extracted ${Object.keys(extracted).length} fields from ${toolConfig.toolName}`);
  }

  return strippedData;
}
