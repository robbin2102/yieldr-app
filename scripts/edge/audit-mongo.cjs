// Read-only, shape-only audit. Never prints credentials or provider payloads.
require("dotenv").config({ path: ".env.local", quiet: true });
const { MongoClient } = require("mongodb");
async function main() {
  const client = new MongoClient(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
  });
  try {
    await client.connect();
    const db = client.db("yieldr");
    const cols = await db
      .listCollections({ name: /^fomo_analysis_/ }, { nameOnly: true })
      .toArray();
    function shape(v, depth = 0) {
      if (v === null) return "null";
      if (v instanceof Date) return "date";
      if (v?._bsontype) return v._bsontype;
      if (Array.isArray(v)) return v.length ? [shape(v[0], depth + 1)] : [];
      if (typeof v === "object")
        return depth > 5
          ? "object"
          : Object.fromEntries(
              Object.entries(v).map(([k, x]) => [k, shape(x, depth + 1)]),
            );
      return typeof v;
    }
    for (const { name } of cols) {
      const c = db.collection(name);
      const sample = await c.findOne({}, { maxTimeMS: 10000 });
      console.log(
        JSON.stringify({
          collection: name,
          count: await c.estimatedDocumentCount(),
          indexes: (await c.listIndexes().toArray()).map((x) => ({
            key: x.key,
            unique: !!x.unique,
          })),
          shape: shape(sample),
        }),
      );
    }
    for (const name of [
      "trader_pattern_summaries",
      "position_action_stories",
      "features",
      "position_episodes",
    ]) {
      const c = db.collection("fomo_analysis_" + name);
      const versions = await c
        .aggregate(
          [
            {
              $group: {
                _id: {
                  model: "$model_version",
                  rule: "$rule_version",
                  analysis: "$analysis_version",
                },
                count: { $sum: 1 },
              },
            },
          ],
          { maxTimeMS: 15000 },
        )
        .toArray();
      console.log(JSON.stringify({ versions: name, values: versions }));
    }
  } catch (e) {
    console.error("Audit failed:", e.name);
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}
main();
