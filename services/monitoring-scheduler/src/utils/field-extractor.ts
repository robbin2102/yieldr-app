/**
 * Utilities for extracting specific dot-path fields from MCP tool responses.
 * Keeps the data passed to the evaluator LLM minimal and cost-controlled.
 */

/**
 * Get a value at a dot-path from a nested object.
 * Supports array index notation: "traders[0].wallet"
 *
 * Examples:
 *   getValueAtPath(obj, "stats.current")          → obj.stats.current
 *   getValueAtPath(obj, "traders[0].winRate")     → obj.traders[0].winRate
 */
export function getValueAtPath(obj: any, path: string): any {
  return path.split('.').reduce((current, key) => {
    if (current == null) return undefined;
    const arrayMatch = key.match(/^(\w+)\[(\d+)\]$/);
    if (arrayMatch) {
      return current[arrayMatch[1]]?.[parseInt(arrayMatch[2], 10)];
    }
    return current[key];
  }, obj);
}

/**
 * Extract a field from every element of an array using wildcard notation.
 * Supports: "traders[*].wallet", "wallets[*].positions[*].coin"
 *
 * For nested wildcards, returns a flat structure:
 *   "wallets[*].positions[*].coin" → { "wallets[0].positions[0]": "BTC", ... }
 */
export function extractArrayField(obj: any, fieldPath: string): any {
  // Find the first [*] wildcard
  const wildcardIdx = fieldPath.indexOf('[*]');
  if (wildcardIdx === -1) {
    return getValueAtPath(obj, fieldPath);
  }

  const arrayPath = fieldPath.slice(0, wildcardIdx);
  const remainder = fieldPath.slice(wildcardIdx + 3).replace(/^\./, '');

  const arr = arrayPath ? getValueAtPath(obj, arrayPath) : obj;
  if (!Array.isArray(arr)) return undefined;

  // If there are more wildcards after this one, recurse
  if (remainder.includes('[*]')) {
    const results: Record<string, any> = {};
    arr.forEach((item: any, i: number) => {
      const nested = extractArrayField(item, remainder);
      if (nested !== undefined && typeof nested === 'object' && !Array.isArray(nested)) {
        Object.entries(nested).forEach(([k, v]) => {
          results[`[${i}].${k}`] = v;
        });
      } else {
        results[`[${i}]`] = nested;
      }
    });
    return results;
  }

  // No more wildcards — extract the leaf from each element
  return arr.map((item: any) =>
    remainder ? getValueAtPath(item, remainder) : item
  );
}

/**
 * Strip a tool response down to only the requested dot-path fields.
 * Used to build the stripped data payload for each cycle.
 *
 * fieldPath → value mapping returned, keyed by the original fieldPath string.
 */
export function extractFields(
  response: any,
  fieldPaths: string[]
): Record<string, any> {
  const result: Record<string, any> = {};
  for (const fieldPath of fieldPaths) {
    if (fieldPath.includes('[*]')) {
      result[fieldPath] = extractArrayField(response, fieldPath);
    } else {
      result[fieldPath] = getValueAtPath(response, fieldPath);
    }
  }
  return result;
}

/**
 * Extract wallet addresses from a tool response.
 * Handles both top-level arrays and traders[] / wallets[] shapes.
 * Used for tool chaining: fill walletAddresses from the previous step's output.
 */
export function extractWallets(data: any): string[] {
  if (!data) return [];

  // Direct array of wallet objects
  if (Array.isArray(data)) {
    return data
      .map((t: any) => t.wallet || t.walletAddress)
      .filter((w: any): w is string => typeof w === 'string' && w.startsWith('0x'));
  }

  // traders[] shape (get_top_perp_traders, get_top_pm_traders)
  if (Array.isArray(data.traders)) {
    return data.traders
      .map((t: any) => t.wallet || t.walletAddress)
      .filter((w: any): w is string => typeof w === 'string' && w.startsWith('0x'));
  }

  // wallets[] shape (get_hl_live_positions_batch response)
  if (Array.isArray(data.wallets)) {
    return data.wallets
      .map((t: any) => t.wallet || t.walletAddress)
      .filter((w: any): w is string => typeof w === 'string' && w.startsWith('0x'));
  }

  return [];
}
