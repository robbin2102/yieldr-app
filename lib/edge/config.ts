export class EdgeError extends Error {
  constructor(
    public code: string,
    public status = 503,
  ) {
    super(code);
  }
}
export function edgeConfig() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new EdgeError("configuration_unavailable");
  const database = process.env.MONGODB_DATABASE || "yieldr";
  if (database !== "yieldr" && !database.startsWith("yieldr_edge_test"))
    throw new EdgeError("configuration_unavailable");
  return { uri, database };
}
