import mongoose from 'mongoose';
export declare const PolyAgentTrade: mongoose.Model<{
    originalTxHash: string;
    status: "DETECTED" | "EXECUTING" | "FILLED" | "FAILED" | "SKIPPED";
    skipReason?: string | null | undefined;
    failReason?: string | null | undefined;
    detectedAt?: NativeDate | null | undefined;
    executedAt?: NativeDate | null | undefined;
    confirmedAt?: NativeDate | null | undefined;
    latencyMs?: number | null | undefined;
    original?: {
        walletAddress?: string | null | undefined;
        tokenId?: string | null | undefined;
        size?: number | null | undefined;
        price?: number | null | undefined;
        usdcSize?: number | null | undefined;
        timestamp?: NativeDate | null | undefined;
        title?: string | null | undefined;
        outcome?: string | null | undefined;
        conditionId?: string | null | undefined;
        side?: "BUY" | "SELL" | null | undefined;
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
    originalTxHash: string;
    status: "DETECTED" | "EXECUTING" | "FILLED" | "FAILED" | "SKIPPED";
    skipReason?: string | null | undefined;
    failReason?: string | null | undefined;
    detectedAt?: NativeDate | null | undefined;
    executedAt?: NativeDate | null | undefined;
    confirmedAt?: NativeDate | null | undefined;
    latencyMs?: number | null | undefined;
    original?: {
        walletAddress?: string | null | undefined;
        tokenId?: string | null | undefined;
        size?: number | null | undefined;
        price?: number | null | undefined;
        usdcSize?: number | null | undefined;
        timestamp?: NativeDate | null | undefined;
        title?: string | null | undefined;
        outcome?: string | null | undefined;
        conditionId?: string | null | undefined;
        side?: "BUY" | "SELL" | null | undefined;
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
    originalTxHash: string;
    status: "DETECTED" | "EXECUTING" | "FILLED" | "FAILED" | "SKIPPED";
    skipReason?: string | null | undefined;
    failReason?: string | null | undefined;
    detectedAt?: NativeDate | null | undefined;
    executedAt?: NativeDate | null | undefined;
    confirmedAt?: NativeDate | null | undefined;
    latencyMs?: number | null | undefined;
    original?: {
        walletAddress?: string | null | undefined;
        tokenId?: string | null | undefined;
        size?: number | null | undefined;
        price?: number | null | undefined;
        usdcSize?: number | null | undefined;
        timestamp?: NativeDate | null | undefined;
        title?: string | null | undefined;
        outcome?: string | null | undefined;
        conditionId?: string | null | undefined;
        side?: "BUY" | "SELL" | null | undefined;
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
    originalTxHash: string;
    status: "DETECTED" | "EXECUTING" | "FILLED" | "FAILED" | "SKIPPED";
    skipReason?: string | null | undefined;
    failReason?: string | null | undefined;
    detectedAt?: NativeDate | null | undefined;
    executedAt?: NativeDate | null | undefined;
    confirmedAt?: NativeDate | null | undefined;
    latencyMs?: number | null | undefined;
    original?: {
        walletAddress?: string | null | undefined;
        tokenId?: string | null | undefined;
        size?: number | null | undefined;
        price?: number | null | undefined;
        usdcSize?: number | null | undefined;
        timestamp?: NativeDate | null | undefined;
        title?: string | null | undefined;
        outcome?: string | null | undefined;
        conditionId?: string | null | undefined;
        side?: "BUY" | "SELL" | null | undefined;
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
    originalTxHash: string;
    status: "DETECTED" | "EXECUTING" | "FILLED" | "FAILED" | "SKIPPED";
    skipReason?: string | null | undefined;
    failReason?: string | null | undefined;
    detectedAt?: NativeDate | null | undefined;
    executedAt?: NativeDate | null | undefined;
    confirmedAt?: NativeDate | null | undefined;
    latencyMs?: number | null | undefined;
    original?: {
        walletAddress?: string | null | undefined;
        tokenId?: string | null | undefined;
        size?: number | null | undefined;
        price?: number | null | undefined;
        usdcSize?: number | null | undefined;
        timestamp?: NativeDate | null | undefined;
        title?: string | null | undefined;
        outcome?: string | null | undefined;
        conditionId?: string | null | undefined;
        side?: "BUY" | "SELL" | null | undefined;
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
    originalTxHash: string;
    status: "DETECTED" | "EXECUTING" | "FILLED" | "FAILED" | "SKIPPED";
    skipReason?: string | null | undefined;
    failReason?: string | null | undefined;
    detectedAt?: NativeDate | null | undefined;
    executedAt?: NativeDate | null | undefined;
    confirmedAt?: NativeDate | null | undefined;
    latencyMs?: number | null | undefined;
    original?: {
        walletAddress?: string | null | undefined;
        tokenId?: string | null | undefined;
        size?: number | null | undefined;
        price?: number | null | undefined;
        usdcSize?: number | null | undefined;
        timestamp?: NativeDate | null | undefined;
        title?: string | null | undefined;
        outcome?: string | null | undefined;
        conditionId?: string | null | undefined;
        side?: "BUY" | "SELL" | null | undefined;
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
