import mongoose from 'mongoose';
import { config } from '../config';
import { createLogger } from '../utils/logger';

const logger = createLogger('MongoDB');

let isConnected = false;

export async function connectDB(): Promise<void> {
  if (isConnected) {
    logger.debug('Using existing MongoDB connection');
    return;
  }

  try {
    logger.info('Connecting to MongoDB...');

    await mongoose.connect(config.mongodbUri);

    isConnected = true;
    logger.success('MongoDB connected successfully');
    logger.info(`Database: ${mongoose.connection.db.databaseName}`);
  } catch (error) {
    logger.error('Failed to connect to MongoDB:', error);
    throw error;
  }
}

export async function disconnectDB(): Promise<void> {
  if (!isConnected) {
    return;
  }

  try {
    await mongoose.disconnect();
    isConnected = false;
    logger.info('MongoDB disconnected');
  } catch (error) {
    logger.error('Failed to disconnect from MongoDB:', error);
    throw error;
  }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  await disconnectDB();
  process.exit(0);
});
