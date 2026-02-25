import mongoose from 'mongoose';
import { config } from './config';
import { logger } from './utils/logger';

let connected = false;

export async function connectDB(): Promise<void> {
  if (connected) return;

  const uri = config.mongodbUri;

  // Determine if we need to replace SRV with standard format for Railway proxy
  // Railway MongoDB proxy does not support SRV records
  let connectionUri = uri;
  if (uri.startsWith('mongodb+srv://') && process.env.RAILWAY_ENVIRONMENT) {
    // For Railway, the MONGODB_URI should already be the correct format
    // but we keep this note for debugging
  }

  await mongoose.connect(connectionUri, {
    serverSelectionTimeoutMS: 30000,
    socketTimeoutMS: 45000,
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

export { mongoose };
