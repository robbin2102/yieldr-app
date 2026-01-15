import mongoose from 'mongoose';
import { config } from '../config';

export async function connectDB() {
  await mongoose.connect(config.mongoUri, { dbName: 'yieldr' });
  console.log('[DB] Connected to MongoDB (yieldr database)');
}
