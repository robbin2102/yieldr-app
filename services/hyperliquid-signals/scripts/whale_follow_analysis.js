// whale_follow_analysis.js
//
// Question: when a Q1 whale enters/flips/scales into LONG or SHORT on a coin,
// how long does it take before the broader cohort flips to follow the same
// direction — and on which coins is this "follow the whale" lag tightest?
//
// Run with: mongosh "<connection_string>" whale_follow_analysis.js
//
// Tune these knobs:
const LOOKBACK_DAYS = 14;        // how far back to scan whale events
const MAX_LAG_HOURS = 6;         // only consider cohort flips within this window
const TOP_N_COINS = 30;          // restrict to top N coins by volume

const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
const maxLagMs = MAX_LAG_HOURS * 60 * 60 * 1000;

// 1. Top N coins by total_usd from the latest coin_metrics snapshot
const latestDoc = db.hl_signals_coin_metrics.find().sort({ snapshot_ts: -1 }).limit(1).next();
const latestTs = latestDoc.snapshot_ts;

const topCoins = db.hl_signals_coin_metrics.aggregate([
  { $match: { snapshot_ts: latestTs } },
  { $sort: { total_usd: -1 } },
  { $limit: TOP_N_COINS },
  { $project: { _id: 0, coin: 1 } }
]).toArray().map(d => d.coin);

print("Top coins by volume:", JSON.stringify(topCoins));

// 2. For each whale event (WAKEUP/FLIP/SCALEUP = directional entry/add),
//    find broader-cohort FLIP position_changes on the same coin, into the
//    same side, that happened AFTER the whale event within MAX_LAG_HOURS.
const results = db.hl_signals_whale_events.aggregate([
  {
    $match: {
      coin: { $in: topCoins },
      event_type: { $in: ["WAKEUP", "FLIP", "SCALEUP"] },
      ts: { $gte: since }
    }
  },
  {
    $lookup: {
      from: "hl_signals_position_changes",
      let: { whaleCoin: "$coin", whaleSide: "$side", whaleTs: "$ts" },
      pipeline: [
        {
          $match: {
            $expr: {
              $and: [
                { $eq: ["$coin", "$$whaleCoin"] },
                { $eq: ["$change_type", "FLIP"] },
                { $eq: ["$new_state.side", "$$whaleSide"] },
                { $gt: ["$ts", "$$whaleTs"] },
                { $lte: [{ $subtract: ["$ts", "$$whaleTs"] }, maxLagMs] }
              ]
            }
          }
        },
        {
          $project: {
            _id: 0,
            address: 1,
            ts: 1,
            lag_minutes: { $divide: [{ $subtract: ["$ts", "$$whaleTs"] }, 60000] }
          }
        }
      ],
      as: "follows"
    }
  },
  { $match: { "follows.0": { $exists: true } } },
  { $unwind: "$follows" },
  {
    $addFields: {
      lag_bucket: {
        $switch: {
          branches: [
            { case: { $lte: ["$follows.lag_minutes", 60] }, then: "0-1h" },
            { case: { $lte: ["$follows.lag_minutes", 180] }, then: "1-3h" },
            { case: { $lte: ["$follows.lag_minutes", 360] }, then: "3-6h" }
          ],
          default: "6h+"
        }
      }
    }
  },
  {
    $group: {
      _id: { coin: "$coin", whale_side: "$side", lag_bucket: "$lag_bucket" },
      whale_events: { $addToSet: { coin: "$coin", side: "$side", ts: "$ts" } },
      cohort_flip_count: { $sum: 1 },
      avg_lag_minutes: { $avg: "$follows.lag_minutes" }
    }
  },
  {
    $project: {
      _id: 0,
      coin: "$_id.coin",
      whale_side: "$_id.whale_side",
      lag_bucket: "$_id.lag_bucket",
      whale_event_count: { $size: "$whale_events" },
      cohort_flip_count: 1,
      avg_lag_minutes: { $round: ["$avg_lag_minutes", 1] }
    }
  },
  { $sort: { coin: 1, whale_side: 1, cohort_flip_count: -1 } }
]).toArray();

printjson(results);
