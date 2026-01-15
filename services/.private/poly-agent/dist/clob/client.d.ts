import { ethers } from 'ethers';
import { ClobClient } from '@polymarket/clob-client';
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
export declare function createClobClient(): Promise<{
    client: ClobClient;
    wallet: ethers.Wallet;
}>;
