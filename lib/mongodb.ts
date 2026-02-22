import { MongoClient } from 'mongodb';

if (!process.env.MONGODB_URI) {
  throw new Error('Please add your Mongo URI to .env.local');
}

const uri = process.env.MONGODB_URI;
const options = {};

// Extract database name from URI (mongodb+srv://.../<dbname>?...)
// Falls back to 'yieldr' if not specified
function extractDbName(mongoUri: string): string {
  try {
    const url = new URL(mongoUri);
    const dbName = url.pathname.replace('/', '');
    return dbName || 'yieldr';
  } catch {
    // Fallback for non-standard URIs
    const match = mongoUri.match(/\/([^/?]+)(\?|$)/);
    return match?.[1] || 'yieldr';
  }
}

export const dbName = extractDbName(uri);

let client: MongoClient;
let clientPromise: Promise<MongoClient>;

if (process.env.NODE_ENV === 'development') {
  // In development mode, use a global variable so the MongoClient is not constantly created
  let globalWithMongo = global as typeof globalThis & {
    _mongoClientPromise?: Promise<MongoClient>;
  };

  if (!globalWithMongo._mongoClientPromise) {
    client = new MongoClient(uri, options);
    globalWithMongo._mongoClientPromise = client.connect();
  }
  clientPromise = globalWithMongo._mongoClientPromise;
} else {
  // In production mode, create a new client
  client = new MongoClient(uri, options);
  clientPromise = client.connect();
}

export default clientPromise;
