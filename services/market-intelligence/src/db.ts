import mongoose from 'mongoose';
import { config } from './config';
import { logger } from './utils/logger';

export { mongoose };

let connected = false;

export async function connectDB(): Promise<void> {
  if (connected) return;
  await mongoose.connect(config.mongodbUri, {
    serverSelectionTimeoutMS: 30000,
    socketTimeoutMS: 120000,   // 4 concurrent cycles each ~54s; 45s was too short cross-region
    maxPoolSize: 10,           // default 5 is too low for 4 simultaneous cron cycles
    minPoolSize: 2,
    heartbeatFrequencyMS: 10000,
  });
  connected = true;
  logger.info('DB', 'Connected to MongoDB');
}

export async function disconnectDB(): Promise<void> {
  if (!connected) return;
  await mongoose.disconnect();
  connected = false;
  logger.info('DB', 'Disconnected from MongoDB');
}
