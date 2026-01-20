import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from 'ethers';

/**
 * Script to derive Polymarket CLOB API credentials
 *
 * These credentials are required for WebSocket authentication.
 * Run: npx ts-node derive-keys.ts
 */

async function deriveApiKeys() {
  console.log('\n🔑 Deriving Polymarket CLOB API Credentials...\n');

  // Get private key from environment
  const privateKey = process.env.BOT_PRIVATE_KEY;

  if (!privateKey) {
    console.error('❌ Error: BOT_PRIVATE_KEY not found in environment');
    console.error('Make sure .env.polyagent is loaded or run:');
    console.error('  export BOT_PRIVATE_KEY="0x..."');
    process.exit(1);
  }

  if (!privateKey.startsWith('0x')) {
    console.error('❌ Error: BOT_PRIVATE_KEY must start with 0x');
    process.exit(1);
  }

  try {
    // Create wallet
    const wallet = new Wallet(privateKey);
    console.log(`Wallet address: ${wallet.address}\n`);

    // Initialize CLOB client
    const client = new ClobClient(
      'https://clob.polymarket.com',  // host
      137,                              // Polygon chain ID
      wallet,                           // signer
      undefined,                        // creds (will derive)
      2                                 // signature type (2 = EOA/browser wallet)
    );

    console.log('🔄 Deriving API credentials from wallet...\n');

    // Derive API credentials
    const result = await client.createOrDeriveApiKey();

    // Handle both possible return formats
    const apiCreds = (result as any).apiCreds || result;

    console.log('✅ SUCCESS! API Credentials derived:\n');
    console.log('════════════════════════════════════════════════════════════');
    console.log('Copy these values to your .env.polyagent file:');
    console.log('════════════════════════════════════════════════════════════\n');
    console.log(`POLYMARKET_API_KEY="${apiCreds.key || apiCreds.apiKey}"`);
    console.log(`POLYMARKET_API_SECRET="${apiCreds.secret}"`);
    console.log(`POLYMARKET_PASSPHRASE="${apiCreds.passphrase}"`);
    console.log('\n════════════════════════════════════════════════════════════');
    console.log('\n⚠️  IMPORTANT: Keep these credentials secure!');
    console.log('Replace the existing values in .env.polyagent with the above.\n');

  } catch (error: any) {
    console.error('\n❌ Error deriving API credentials:');
    console.error(error.message);

    if (error.message.includes('insufficient funds')) {
      console.error('\n💡 Your wallet needs a small amount of MATIC for gas.');
      console.error('   Send ~0.01 MATIC to: (check wallet address above)');
    }

    process.exit(1);
  }
}

// Load environment variables
import { config as loadEnv } from 'dotenv';
import { resolve } from 'path';

const envPath = resolve(__dirname, '.env.polyagent');
loadEnv({ path: envPath });

// Run the script
deriveApiKeys().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
