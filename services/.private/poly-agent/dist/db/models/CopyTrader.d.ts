import mongoose, { Document } from 'mongoose';
/**
 * CopyTrader — ahf-copyTraders
 *
 * One document per target trader wallet. All per-trader config (allocation,
 * bet sizing, activity stats) lives here. Adding a new trader = one DB insert.
 * No env changes, no restart needed (watchdog picks it up within 60s).
 */
export interface ICopyTrader extends Document {
    wallet: string;
    label: string;
    specialty: string;
    strategyLabel: string;
    roce: number;
    actsPerDay: number;
    avgBet: number;
    baseBetUsdc: number;
    maxBetUsdc: number;
    allocationUsdc: number;
    spentUsdc: number;
    active: boolean;
    lastSeenTs: number;
    lastPolledAt?: Date;
    detectorIntervalMs?: number;
    tradesDetected: number;
    tradesAboveAvg: number;
    tradesExecuted: number;
    tradesSkipped: number;
    skipReasonCounts: Record<string, number>;
    createdAt: Date;
    updatedAt: Date;
}
export declare const CopyTrader: mongoose.Model<ICopyTrader, {}, {}, {}, mongoose.Document<unknown, {}, ICopyTrader, {}, {}> & ICopyTrader & Required<{
    _id: mongoose.Types.ObjectId;
}> & {
    __v: number;
}, any>;
