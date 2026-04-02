import mongoose from 'mongoose';
import { config } from '../config';

export async function connectDB() {
  await mongoose.connect(config.mongoUri, {
    dbName: 'yieldr',
    // Mongoose will automatically reconnect on transient network errors.
    // serverSelectionTimeoutMS controls how long to wait before giving up
    // on a single operation — keep it generous for Railway proxy.
    serverSelectionTimeoutMS: 30000,
  });
  console.log('[DB] Connected to MongoDB (yieldr database)');

  // Log reconnection events — don't crash on transient Railway proxy timeouts.
  mongoose.connection.on('disconnected', () =>
    console.warn('[DB] MongoDB disconnected — Mongoose will reconnect automatically')
  );
  mongoose.connection.on('reconnected', () =>
    console.log('[DB] MongoDB reconnected')
  );
  mongoose.connection.on('error', (err) =>
    console.error('[DB] MongoDB connection error (non-fatal):', err.message)
  );
}
