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
 * @returns Initialized ClobClient instance
 */
export async function createClobClient(): Promise<ClobClient> {
  console.log('[CLOB] Initializing client...');

  // Create wallet from private key
  const wallet = new ethers.Wallet(config.botPrivateKey);
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
  return client;
}
