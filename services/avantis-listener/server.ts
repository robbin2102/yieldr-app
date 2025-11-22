/**
 * Avantis Listener Server
 * Standalone server for Railway deployment
 *
 * This service runs continuously, listening to Avantis events
 * and storing them in MongoDB for later retrieval via API
 */

import dotenv from 'dotenv';
import { join } from 'path';

// Load environment variables from .env.local
dotenv.config({ path: join(process.cwd(), '.env.local') });

import express from 'express';
import { startAvantisListener, getListenerStatus, stopAvantisListener } from './index';
import connectDB from '../../lib/mongodb';
import Manager from '../../models/manager';
import TradeEvent from '../../models/TradeEvent';

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(express.json());

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  const status = getListenerStatus();

  res.json({
    status: 'ok',
    service: 'avantis-listener',
    timestamp: new Date().toISOString(),
    listener: status,
  });
});

/**
 * Listener status endpoint
 */
app.get('/status', (req, res) => {
  const status = getListenerStatus();
  res.json(status);
});

/**
 * Database stats endpoint
 */
app.get('/stats', async (req, res) => {
  try {
    const totalEvents = await TradeEvent.countDocuments();
    const openPositions = await TradeEvent.countDocuments({ status: 'EXECUTED' });
    const closedPositions = await TradeEvent.countDocuments({ status: 'CLOSED' });
    const uniqueTraders = await TradeEvent.distinct('trader');

    res.json({
      totalEvents,
      openPositions,
      closedPositions,
      uniqueTraders: uniqueTraders.length,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

/**
 * Startup function
 */
async function startup() {
  console.log('='.repeat(70));
  console.log('🚀 Avantis Listener Service - Starting up...');
  console.log('='.repeat(70));

  try {
    // Connect to MongoDB
    console.log('\n📊 Connecting to MongoDB...');
    await connectDB();
    console.log('✓ Connected to MongoDB');

    // Create indexes on TradeEvent model
    console.log('\n🔧 Creating database indexes...');
    await TradeEvent.createIndexes();
    console.log('✓ Indexes created');

    // Get verified managers to monitor
    console.log('\n👥 Fetching verified managers...');
    const managers = await Manager.find({ verified: true }).select('walletAddress username');
    const wallets = managers.map((m) => m.walletAddress);

    console.log(`✓ Found ${managers.length} verified managers to monitor`);

    if (managers.length > 0) {
      console.log('\nManagers:');
      managers.forEach((m, i) => {
        console.log(`  ${i + 1}. ${m.username} (${m.walletAddress})`);
      });
    }

    // Start event listener
    console.log('\n🎯 Starting Avantis event listener...');
    await startAvantisListener(wallets);
    console.log('✓ Event listener started successfully');

    // Start HTTP server
    console.log(`\n🌐 Starting HTTP server on port ${PORT}...`);
    app.listen(PORT, () => {
      console.log(`✓ HTTP server listening on port ${PORT}`);
      console.log('\nEndpoints:');
      console.log(`  - GET  http://localhost:${PORT}/health`);
      console.log(`  - GET  http://localhost:${PORT}/status`);
      console.log(`  - GET  http://localhost:${PORT}/stats`);

      console.log('\n' + '='.repeat(70));
      console.log('✅ Avantis Listener Service is running!');
      console.log('='.repeat(70));
      console.log('\nPress Ctrl+C to stop\n');
    });
  } catch (error) {
    console.error('\n❌ Startup failed:', error);
    process.exit(1);
  }
}

/**
 * Graceful shutdown
 */
async function shutdown() {
  console.log('\n\n' + '='.repeat(70));
  console.log('🛑 Shutting down Avantis Listener Service...');
  console.log('='.repeat(70));

  try {
    console.log('\n⏸️  Stopping event listener...');
    stopAvantisListener();
    console.log('✓ Event listener stopped');

    console.log('\n✅ Graceful shutdown complete');
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Error during shutdown:', error);
    process.exit(1);
  }
}

// Signal handlers
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Uncaught errors
process.on('uncaughtException', (error) => {
  console.error('💥 Uncaught Exception:', error);
  shutdown();
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
  shutdown();
});

// Start the server
startup();
