/**
 * Test Real-Time Event Listener
 * Monitors a single wallet for testing
 * Usage: npx tsx scripts/test-listener.ts <walletAddress>
 */

import { config } from 'dotenv';
import { resolve } from 'path';

config({ path: resolve(process.cwd(), '.env.local') });

async function main() {
  try {
    const { EventListener } = await import('../services/avantis-listener/EventListener');
    const { verifyConnection } = await import('../services/avantis-listener/core/ViemClient');
    const { default: connectDB } = await import('../lib/mongoose');

    // Get wallet from command line
    const wallet = process.argv[2];

    if (!wallet) {
      console.error('❌ Error: Wallet address required');
      console.log('\nUsage: npx tsx scripts/test-listener.ts <walletAddress>');
      console.log('Example: npx tsx scripts/test-listener.ts 0x780BB763e1463D2236FEC780b7BD6ADb40AAa120');
      process.exit(1);
    }

    console.log('='.repeat(70));
    console.log('Real-Time Event Listener - Test Mode');
    console.log('='.repeat(70));
    console.log(`\n📍 Monitoring wallet: ${wallet}`);
    console.log('⚡ Watching for both Market and Limit orders');
    console.log('🔄 Polling every 2 seconds');
    console.log('\n💡 Make a test trade on Avantis to see events!\n');

    // Connect to MongoDB
    console.log('🔌 Connecting to MongoDB...');
    await connectDB();
    console.log('✅ Connected to MongoDB\n');

    // Verify RPC connection
    console.log('🔌 Connecting to Base RPC...');
    const connected = await verifyConnection();
    if (!connected) {
      throw new Error('Failed to connect to Base RPC');
    }
    console.log('✅ Connected to Base RPC\n');

    console.log('='.repeat(70));
    console.log('Starting listener...');
    console.log('='.repeat(70) + '\n');

    // Create listener with test wallet
    const listener = new EventListener([wallet]);

    // Start listening
    await listener.start();

    console.log('\n✅ Listener is now active!');
    console.log('\n📊 Status will be logged every 30 seconds');
    console.log('🛑 Press Ctrl+C to stop\n');

    // Log status every 30 seconds
    const statusInterval = setInterval(() => {
      const status = listener.getStatus();
      console.log('\n' + '─'.repeat(70));
      console.log('📊 Status Update:');
      console.log(`  ├─ Events Processed: ${status.eventsProcessed}`);
      console.log(`  ├─ Errors: ${status.errorsCount}`);
      console.log(`  ├─ Last Event: ${status.lastEventTime ? status.lastEventTime.toLocaleString() : 'None yet'}`);
      console.log(`  └─ Active: ${status.isActive ? '✅' : '❌'}`);
      console.log('─'.repeat(70));
    }, 30000);

    // Graceful shutdown
    const shutdown = async () => {
      console.log('\n\n🛑 Shutting down listener...');
      clearInterval(statusInterval);
      listener.stop();

      const finalStatus = listener.getStatus();
      console.log('\n📊 Final Statistics:');
      console.log(`  ├─ Total Events Processed: ${finalStatus.eventsProcessed}`);
      console.log(`  ├─ Total Errors: ${finalStatus.errorsCount}`);
      console.log(`  └─ Last Event: ${finalStatus.lastEventTime ? finalStatus.lastEventTime.toLocaleString() : 'None'}`);

      console.log('\n✅ Listener stopped successfully');
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // Keep process alive
    await new Promise(() => {});
  } catch (error) {
    console.error('\n❌ Failed to start listener:');
    console.error(error);
    process.exit(1);
  }
}

main();
