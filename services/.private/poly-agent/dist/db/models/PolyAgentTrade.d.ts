import mongoose from 'mongoose';
export declare const PolyAgentTrade: mongoose.Model<{
    status: "DETECTED" | "SKIPPED" | "EXECUTING" | "FILLED" | "FAILED";
    originalTxHash: string;
    skipReason?: string | null | undefined;
    detectedAt?: NativeDate | null | undefined;
    failReason?: string | null | undefined;
    executedAt?: NativeDate | null | undefined;
    confirmedAt?: NativeDate | null | undefined;
    latencyMs?: number | null | undefined;
    original?: {
        conditionId?: string | null | undefined;
        tokenId?: string | null | undefined;
        title?: string | null | undefined;
        outcome?: string | null | undefined;
        side?: "BUY" | "SELL" | null | undefined;
        size?: number | null | undefined;
        walletAddress?: string | null | undefined;
        price?: number | null | undefined;
        usdcSize?: number | null | undefined;
        timestamp?: NativeDate | null | undefined;
    } | null | undefined;
    copy?: {
        side?: "BUY" | "SELL" | null | undefined;
        orderId?: string | null | undefined;
        targetSize?: number | null | undefined;
        targetPrice?: number | null | undefined;
        executedSize?: number | null | undefined;
        executedPrice?: number | null | undefined;
        executedUsdcSize?: number | null | undefined;
    } | null | undefined;
    slippage?: {
        expectedCost?: number | null | undefined;
        actualCost?: number | null | undefined;
        slippageUsdc?: number | null | undefined;
        slippageBps?: number | null | undefined;
    } | null | undefined;
} & mongoose.DefaultTimestampProps, {}, {}, {}, mongoose.Document<unknown, {}, {
    status: "DETECTED" | "SKIPPED" | "EXECUTING" | "FILLED" | "FAILED";
    originalTxHash: string;
    skipReason?: string | null | undefined;
    detectedAt?: NativeDate | null | undefined;
    failReason?: string | null | undefined;
    executedAt?: NativeDate | null | undefined;
    confirmedAt?: NativeDate | null | undefined;
    latencyMs?: number | null | undefined;
    original?: {
        conditionId?: string | null | undefined;
        tokenId?: string | null | undefined;
        title?: string | null | undefined;
        outcome?: string | null | undefined;
        side?: "BUY" | "SELL" | null | undefined;
        size?: number | null | undefined;
        walletAddress?: string | null | undefined;
        price?: number | null | undefined;
        usdcSize?: number | null | undefined;
        timestamp?: NativeDate | null | undefined;
    } | null | undefined;
    copy?: {
        side?: "BUY" | "SELL" | null | undefined;
        orderId?: string | null | undefined;
        targetSize?: number | null | undefined;
        targetPrice?: number | null | undefined;
        executedSize?: number | null | undefined;
        executedPrice?: number | null | undefined;
        executedUsdcSize?: number | null | undefined;
    } | null | undefined;
    slippage?: {
        expectedCost?: number | null | undefined;
        actualCost?: number | null | undefined;
        slippageUsdc?: number | null | undefined;
        slippageBps?: number | null | undefined;
    } | null | undefined;
} & mongoose.DefaultTimestampProps, {}, {
    timestamps: true;
}> & {
    status: "DETECTED" | "SKIPPED" | "EXECUTING" | "FILLED" | "FAILED";
    originalTxHash: string;
    skipReason?: string | null | undefined;
    detectedAt?: NativeDate | null | undefined;
    failReason?: string | null | undefined;
    executedAt?: NativeDate | null | undefined;
    confirmedAt?: NativeDate | null | undefined;
    latencyMs?: number | null | undefined;
    original?: {
        conditionId?: string | null | undefined;
        tokenId?: string | null | undefined;
        title?: string | null | undefined;
        outcome?: string | null | undefined;
        side?: "BUY" | "SELL" | null | undefined;
        size?: number | null | undefined;
        walletAddress?: string | null | undefined;
        price?: number | null | undefined;
        usdcSize?: number | null | undefined;
        timestamp?: NativeDate | null | undefined;
    } | null | undefined;
    copy?: {
        side?: "BUY" | "SELL" | null | undefined;
        orderId?: string | null | undefined;
        targetSize?: number | null | undefined;
        targetPrice?: number | null | undefined;
        executedSize?: number | null | undefined;
        executedPrice?: number | null | undefined;
        executedUsdcSize?: number | null | undefined;
    } | null | undefined;
    slippage?: {
        expectedCost?: number | null | undefined;
        actualCost?: number | null | undefined;
        slippageUsdc?: number | null | undefined;
        slippageBps?: number | null | undefined;
    } | null | undefined;
} & mongoose.DefaultTimestampProps & {
    _id: mongoose.Types.ObjectId;
} & {
    __v: number;
}, mongoose.Schema<any, mongoose.Model<any, any, any, any, any, any>, {}, {}, {}, {}, {
    timestamps: true;
}, {
    status: "DETECTED" | "SKIPPED" | "EXECUTING" | "FILLED" | "FAILED";
    originalTxHash: string;
    skipReason?: string | null | undefined;
    detectedAt?: NativeDate | null | undefined;
    failReason?: string | null | undefined;
    executedAt?: NativeDate | null | undefined;
    confirmedAt?: NativeDate | null | undefined;
    latencyMs?: number | null | undefined;
    original?: {
        conditionId?: string | null | undefined;
        tokenId?: string | null | undefined;
        title?: string | null | undefined;
        outcome?: string | null | undefined;
        side?: "BUY" | "SELL" | null | undefined;
        size?: number | null | undefined;
        walletAddress?: string | null | undefined;
        price?: number | null | undefined;
        usdcSize?: number | null | undefined;
        timestamp?: NativeDate | null | undefined;
    } | null | undefined;
    copy?: {
        side?: "BUY" | "SELL" | null | undefined;
        orderId?: string | null | undefined;
        targetSize?: number | null | undefined;
        targetPrice?: number | null | undefined;
        executedSize?: number | null | undefined;
        executedPrice?: number | null | undefined;
        executedUsdcSize?: number | null | undefined;
    } | null | undefined;
    slippage?: {
        expectedCost?: number | null | undefined;
        actualCost?: number | null | undefined;
        slippageUsdc?: number | null | undefined;
        slippageBps?: number | null | undefined;
    } | null | undefined;
} & mongoose.DefaultTimestampProps, mongoose.Document<unknown, {}, mongoose.FlatRecord<{
    status: "DETECTED" | "SKIPPED" | "EXECUTING" | "FILLED" | "FAILED";
    originalTxHash: string;
    skipReason?: string | null | undefined;
    detectedAt?: NativeDate | null | undefined;
    failReason?: string | null | undefined;
    executedAt?: NativeDate | null | undefined;
    confirmedAt?: NativeDate | null | undefined;
    latencyMs?: number | null | undefined;
    original?: {
        conditionId?: string | null | undefined;
        tokenId?: string | null | undefined;
        title?: string | null | undefined;
        outcome?: string | null | undefined;
        side?: "BUY" | "SELL" | null | undefined;
        size?: number | null | undefined;
        walletAddress?: string | null | undefined;
        price?: number | null | undefined;
        usdcSize?: number | null | undefined;
        timestamp?: NativeDate | null | undefined;
    } | null | undefined;
    copy?: {
        side?: "BUY" | "SELL" | null | undefined;
        orderId?: string | null | undefined;
        targetSize?: number | null | undefined;
        targetPrice?: number | null | undefined;
        executedSize?: number | null | undefined;
        executedPrice?: number | null | undefined;
        executedUsdcSize?: number | null | undefined;
    } | null | undefined;
    slippage?: {
        expectedCost?: number | null | undefined;
        actualCost?: number | null | undefined;
        slippageUsdc?: number | null | undefined;
        slippageBps?: number | null | undefined;
    } | null | undefined;
} & mongoose.DefaultTimestampProps>, {}, mongoose.ResolveSchemaOptions<{
    timestamps: true;
}>> & mongoose.FlatRecord<{
    status: "DETECTED" | "SKIPPED" | "EXECUTING" | "FILLED" | "FAILED";
    originalTxHash: string;
    skipReason?: string | null | undefined;
    detectedAt?: NativeDate | null | undefined;
    failReason?: string | null | undefined;
    executedAt?: NativeDate | null | undefined;
    confirmedAt?: NativeDate | null | undefined;
    latencyMs?: number | null | undefined;
    original?: {
        conditionId?: string | null | undefined;
        tokenId?: string | null | undefined;
        title?: string | null | undefined;
        outcome?: string | null | undefined;
        side?: "BUY" | "SELL" | null | undefined;
        size?: number | null | undefined;
        walletAddress?: string | null | undefined;
        price?: number | null | undefined;
        usdcSize?: number | null | undefined;
        timestamp?: NativeDate | null | undefined;
    } | null | undefined;
    copy?: {
        side?: "BUY" | "SELL" | null | undefined;
        orderId?: string | null | undefined;
        targetSize?: number | null | undefined;
        targetPrice?: number | null | undefined;
        executedSize?: number | null | undefined;
        executedPrice?: number | null | undefined;
        executedUsdcSize?: number | null | undefined;
    } | null | undefined;
    slippage?: {
        expectedCost?: number | null | undefined;
        actualCost?: number | null | undefined;
        slippageUsdc?: number | null | undefined;
        slippageBps?: number | null | undefined;
    } | null | undefined;
} & mongoose.DefaultTimestampProps> & {
    _id: mongoose.Types.ObjectId;
} & {
    __v: number;
}>>;
