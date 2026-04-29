import mongoose, { Document } from 'mongoose';

/**
 * CopyTrader — ahf-copyTraders
 *
 * One document per target trader wallet. All per-trader config (allocation,
 * bet sizing, activity stats) lives here. Adding a new trader = one DB insert.
 * No env changes, no restart needed (watchdog picks it up within 60s).
 */
export interface ICopyTrader extends Document {
  wallet:        string;
  label:         string;
  specialty:     string;
  strategyLabel: string;
  roce:          number;
  actsPerDay:    number;

  // Bet sizing
  avgBet:      number;   // skip trader bets below this; conviction anchor
  baseBetUsdc: number;   // $5 — minimum copy bet (floor) in USDC terms
  maxBetUsdc:  number;   // $20 — maximum copy bet (cap)

  // Allocation
  allocationUsdc: number;  // lifetime cap for this trader
  spentUsdc:      number;  // running total filled; never exceeds allocationUsdc

  // Polling state
  active:       boolean;
  lastSeenTs:   number;    // unix seconds — last activity timestamp seen
  lastPolledAt?: Date;
  detectorIntervalMs?: number;

  // Aggregate counters
  tradesDetected:  number;
  tradesAboveAvg:  number;
  tradesExecuted:  number;
  tradesSkipped:   number;
  skipReasonCounts: Record<string, number>;

  // Allocation management — written by analyze-allocations each run.
  // Provides current recommendation state for UI without joining to ahf-allocationEvents.
  allocAction:      string;    // latest action code, e.g. "SCALE_UP_L2"
  allocReason:      string;    // human-readable reason
  allocFailureType: string;    // "EXEC_FAIL" | "TRADER_FAIL" | "NONE"
  allocCheckedAt:   Date | null;

  createdAt: Date;
  updatedAt: Date;
}

const copyTraderSchema = new mongoose.Schema<ICopyTrader>({
  wallet:        { type: String, required: true, unique: true, index: true, lowercase: true },
  label:         { type: String, required: true },
  specialty:     { type: String, default: 'Unknown' },
  strategyLabel: { type: String, default: 'UNKNOWN' },
  roce:          { type: Number, default: 0 },
  actsPerDay:    { type: Number, default: 0 },

  avgBet:      { type: Number, required: true },
  baseBetUsdc: { type: Number, default: 5 },
  maxBetUsdc:  { type: Number, default: 20 },

  allocationUsdc: { type: Number, required: true },
  spentUsdc:      { type: Number, default: 0 },

  active:             { type: Boolean, default: true, index: true },
  lastSeenTs:         { type: Number, default: () => Math.floor(Date.now() / 1000) },
  lastPolledAt:       { type: Date },
  detectorIntervalMs: { type: Number },

  tradesDetected:   { type: Number, default: 0 },
  tradesAboveAvg:   { type: Number, default: 0 },
  tradesExecuted:   { type: Number, default: 0 },
  tradesSkipped:    { type: Number, default: 0 },
  skipReasonCounts: { type: Map, of: Number, default: {} },

  allocAction:      { type: String, default: '' },
  allocReason:      { type: String, default: '' },
  allocFailureType: { type: String, default: '' },
  allocCheckedAt:   { type: Date,   default: null },

}, { timestamps: true, collection: 'ahf-copyTraders' });

export const CopyTrader = mongoose.model<ICopyTrader>('CopyTrader', copyTraderSchema, 'ahf-copyTraders');
