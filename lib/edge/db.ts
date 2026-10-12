import "server-only";
import { MongoClient } from "mongodb";
import { edgeConfig } from "./config";
const globalDb = globalThis as typeof globalThis & {
  edgeMongo?: Promise<MongoClient>;
};
export async function edgeDb() {
  const { uri, database } = edgeConfig();
  if (!globalDb.edgeMongo) {
    const c = new MongoClient(uri, {
      maxPoolSize: 5,
      serverSelectionTimeoutMS: 8000,
      connectTimeoutMS: 8000,
    });
    globalDb.edgeMongo = c.connect().catch(async (e) => {
      globalDb.edgeMongo = undefined;
      await c.close();
      throw e;
    });
  }
  return (await globalDb.edgeMongo).db(database);
}
