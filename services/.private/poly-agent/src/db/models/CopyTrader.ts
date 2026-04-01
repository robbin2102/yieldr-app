import mongoose, { Document } from 'mongoose';

/**
 * CopyTrader — ahf-copyTraders
 *
 * One document per target trader wallet. All per-trader config (allocation,
 * bet sizing params, activity stats) lives here. Adding a new trader = one
 * DB insert. No env changes, no restart needed (watchdog picks it up).
 */
export interface ICopyTrader extends Document {
  // Identity
  wallet: string;
  label: string;            // human label e.g. "T2-BuyHold-869%"
  specialty: string;
  strategyLabel: string;    // BUY_AND_HOLD | SWING_TRADER | ACTIVE_TRADER
  roce: number;
  actsPerDay: number;

  // Bet sizing (from behavior analysis)
  avgBet: number;           // skip trader bets below this
  baseBetUsdc: number;      // $5 default — minimum copy bet
  maxBetUsdc: number;       // $20 default — cap from MAX_POSITION_USDC

  // Allocation (no daily cap — just lifetime per trader)
  allocationUsdc: number;
  spentUsdc: number;        // running total filled; never exceeds allocationUsdc

  // Polling state
  active: boolean;
  lastSeenTs: number;       // last activity timestamp seen (unix seconds)
  lastPolledAt?: Date;

  // Per-trader detector interval override (ms)
  // Undefined = use global DETECTOR_INTERVAL_MS from config
  detectorIntervalMs?: number;

  // Aggregate counters (updated after each trade event)
  tradesDetected: number;
  tradesAboveAvg: number;   // passed avg filter
  tradesExecuted: number;   // filled (full or partial)
  tradesSkipped: number;
  skipReasonCounts: Record<string, number>;  // { BELOW_AVG: 5, ALLOCATION_FULL: 2, ... }

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

  avgBet:     { type: Number, required: true },
  baseBetUsdc:{ type: Number, default: 5 },
  maxBetUsdc: { type: Number, default: 20 },

  allocationUsdc: { type: Number, required: true },
  spentUsdc:      { type: Number, default: 0 },

  active:            { type: Boolean, default: true, index: true },
  lastSeenTs:        { type: Number, default: () => Math.floor(Date.now() / 1000) },
  lastPolledAt:      { type: Date },
  detectorIntervalMs:{ type: Number },

  tradesDetected:   { type: Number, default: 0 },
  tradesAboveAvg:   { type: Number, default: 0 },
  tradesExecuted:   { type: Number, default: 0 },
  tradesSkipped:    { type: Number, default: 0 },
  skipReasonCounts: { type: Map, of: Number, default: {} },

}, { timestamps: true, collection: 'ahf-copyTraders' });

export const CopyTrader = mongoose.model<ICopyTrader>('CopyTrader', copyTraderSchema, 'ahf-copyTraders');
