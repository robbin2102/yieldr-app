/**
 * Base chain RPC URL resolution.
 *
 * Prefers ALCHEMY_BASE_RPC_URL. QUICKNODE_BASE_RPC_URL is still accepted as a
 * fallback so older environments keep working until their env vars are updated.
 */
export function getBaseRpcUrl(): string {
  const url = process.env.ALCHEMY_BASE_RPC_URL || process.env.QUICKNODE_BASE_RPC_URL;

  if (!url) {
    throw new Error('ALCHEMY_BASE_RPC_URL environment variable is not set');
  }

  return url;
}
