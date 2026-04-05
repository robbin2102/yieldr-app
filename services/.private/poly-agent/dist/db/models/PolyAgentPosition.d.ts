import mongoose, { Document } from 'mongoose';
/**
 * Tracked position - both trader's and our mirrored position
 */
export interface IPolyAgentPosition extends Document {
    targetWallet: string;
    botWallet: string;
    tokenId: string;
    conditionId: string;
    marketQuestion: string;
    marketSlug: string;
    outcome: string;
    outcomeIndex: number;
    traderSize: number;
    traderAvgPrice: number;
    traderCurrentPrice: number;
    traderValueUsdc: number;
    traderPnL: number;
    traderPnLPercent: number;
    ourSize: number;
    ourAvgPrice: number;
    ourTargetSize: number;
    ourValueUsdc: number;
    ourPnL: number;
    ourPnLPercent: number;
    entryDrift: number;
    currentDrift: number;
    priceVsTrader: number;
    status: 'SYNCED' | 'PENDING' | 'PARTIAL' | 'SKIPPED' | 'UNDERWATER' | 'CLOSED';
    skipReason?: string;
    traderEnteredAt?: Date;
    ourEnteredAt?: Date;
    lastSyncedAt: Date;
    closedAt?: Date;
    fillAttempts: number;
    totalSlippageUsdc: number;
    createdAt: Date;
    updatedAt: Date;
}
export declare const PolyAgentPosition: mongoose.Model<IPolyAgentPosition, {}, {}, {}, mongoose.Document<unknown, {}, IPolyAgentPosition, {}, {}> & IPolyAgentPosition & Required<{
    _id: mongoose.Types.ObjectId;
}> & {
    __v: number;
}, any>;
