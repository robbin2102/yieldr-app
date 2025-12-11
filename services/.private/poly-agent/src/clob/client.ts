import { ethers } from 'ethers';
import { ClobClient } from '@polymarket/clob-client';
import { config } from '../config';

/**
 * Create and initialize Polymarket CLOB client
 *
 * The CLOB (Central Limit Order Book) client handles:
 * - Order creation and signing
 * - Order submission to Polymarket
 * - Authentication with API credentials
 *
 * @returns Initialized ClobClient instance and wallet
 */
export async function createClobClient(): Promise<{ client: ClobClient; wallet: ethers.Wallet }> {
  console.log('[CLOB] Initializing client...');

  // Create provider connected to Polygon RPC
  // Use StaticJsonRpcProvider to avoid ALL network auto-detection
  // This is critical for QuickNode multichain endpoints
  const network = {
    name: 'polygon',
    chainId: config.chainId,
  };

  const provider = new ethers.providers.StaticJsonRpcProvider(config.polygonRpcUrl, network);
  console.log(`[CLOB] Using RPC: ${config.polygonRpcUrl.substring(0, 50)}...`);
  console.log(`[CLOB] Network: Polygon (chainId: ${config.chainId})`);

  // Create wallet from private key and connect to provider
  const wallet = new ethers.Wallet(config.botPrivateKey, provider);
  console.log(`[CLOB] Wallet address: ${wallet.address}`);

  // Initialize CLOB client with credentials
  const client = new ClobClient(
    config.clobApiBase,
    config.chainId,
    wallet,
    {
      key: config.apiKey,
      secret: config.apiSecret,
      passphrase: config.passphrase,
    }
  );

  console.log('[CLOB] ✅ Client ready');
  return { client, wallet };
}
