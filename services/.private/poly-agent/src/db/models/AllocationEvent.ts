import mongoose, { Document } from 'mongoose';

/**
 * AllocationEvent — ahf-allocationEvents
 *
 * Append-only event log. One document per trader per analyze-allocations run.
 * Records the full decision chain: metrics snapshot + action taken + reason.
 *
 * Enables the UI to show the complete history per trader:
 *   $50 → SCALE_UP_L2 → $100 → tROCE drops → SCALE_DOWN → $50 → SOFT_STOP → $0
 *
 * allocAfter = null means "recommended but not yet applied by operator".
 * The operator sets allocationUsdc in ahf-copyTraders; a follow-up run will
 * then log an event with allocBefore = new value, closing the loop.
 */
export interface IAllocationEvent extends Document {
  // Identity
  wallet:       string;
  label:        string;
  runAt:        Date;

  // Decision
  action:       string;   // full string with emoji, e.g. "🟢 SCALE_UP_L2"
  actionCode:   string;   // clean text for querying, e.g. "SCALE_UP_L2"
  failureType:  'EXEC_FAIL' | 'TRADER_FAIL' | 'NONE';
  reason:       string;

  // Allocation state at decision time
  allocBefore:  number;
  allocAfter:   number | null;  // null = recommended, operator applies manually
  positionCap:  number;
  spentUsdc:    number;

  // ROCE
  traderROCE:   number;
  botROCE:      number;

  // Edge snapshot
  edgeScore:      number | null;
  edgeSpecialty:  string | null;
  edgeConfidence: string | null;
  daysInactive:   number | null;

  // Execution quality
  execSkipRate: number;
  belowAvgRate: number;
  skipCounts:   Record<string, number>;

  // PnL snapshot
  tBought:   number;
  tRealized: number;
  tOpenVal:  number;
  tTotal:    number;
  bCost:     number;
  bPnl:      number;   // bTotal (realized + open)

  // Activity
  detected:  number;
  filled:    number;
  missedPnl: number;
}

const allocationEventSchema = new mongoose.Schema<IAllocationEvent>({
  wallet:      { type: String, required: true, index: true, lowercase: true },
  label:       { type: String, required: true },
  runAt:       { type: Date,   required: true, index: true },

  action:      { type: String, required: true },
  actionCode:  { type: String, required: true, index: true },
  failureType: { type: String, enum: ['EXEC_FAIL', 'TRADER_FAIL', 'NONE'], required: true },
  reason:      { type: String, default: '' },

  allocBefore: { type: Number, required: true },
  allocAfter:  { type: Number, default: null },
  positionCap: { type: Number, required: true },
  spentUsdc:   { type: Number, default: 0 },

  traderROCE:  { type: Number, required: true },
  botROCE:     { type: Number, required: true },

  edgeScore:      { type: Number, default: null },
  edgeSpecialty:  { type: String, default: null },
  edgeConfidence: { type: String, default: null },
  daysInactive:   { type: Number, default: null },

  execSkipRate: { type: Number, default: 0 },
  belowAvgRate: { type: Number, default: 0 },
  skipCounts:   { type: Map, of: Number, default: {} },

  tBought:   { type: Number, default: 0 },
  tRealized: { type: Number, default: 0 },
  tOpenVal:  { type: Number, default: 0 },
  tTotal:    { type: Number, default: 0 },
  bCost:     { type: Number, default: 0 },
  bPnl:      { type: Number, default: 0 },

  detected:  { type: Number, default: 0 },
  filled:    { type: Number, default: 0 },
  missedPnl: { type: Number, default: 0 },

}, { timestamps: false, collection: 'ahf-allocationEvents' });

// Per-trader history (most recent first) — primary query pattern
allocationEventSchema.index({ wallet: 1, runAt: -1 });

export const AllocationEvent = mongoose.model<IAllocationEvent>(
  'AllocationEvent', allocationEventSchema, 'ahf-allocationEvents'
);
