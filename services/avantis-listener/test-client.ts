/**
 * Test ViemClient connection to Base chain
 */

import dotenv from 'dotenv';
import { resolve } from 'path';

// Load environment variables from .env.local
dotenv.config({ path: resolve(__dirname, '../../.env.local') });

import { verifyConnection, getLatestBlockNumber, getChainId } from './core/ViemClient';

async function testConnection() {
  console.log('Testing ViemClient connection to Base chain...\n');

  try {
    // Verify connection
    const isConnected = await verifyConnection();

    if (!isConnected) {
      console.error('Failed to connect to Base chain');
      process.exit(1);
    }

    // Get chain ID
    const chainId = await getChainId();
    console.log(`Chain ID: ${chainId}`);

    // Get latest block
    const blockNumber = await getLatestBlockNumber();
    console.log(`Latest block: ${blockNumber}`);

    console.log('\n✓ All tests passed!');
  } catch (error) {
    console.error('\n✗ Test failed:', error);
    process.exit(1);
  }
}

testConnection();
