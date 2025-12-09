import mongoose from 'mongoose';
export declare const PolyAgentReconcile: mongoose.Model<{
    conditionId: string;
    checkedAt: NativeDate;
    title?: string | null | undefined;
    outcome?: string | null | undefined;
    gapSize?: number | null | undefined;
    gapPercent?: number | null | undefined;
    traderPosition?: {
        size?: number | null | undefined;
        avgPrice?: number | null | undefined;
    } | null | undefined;
    expectedPosition?: {
        size?: number | null | undefined;
    } | null | undefined;
    actualPosition?: {
        size?: number | null | undefined;
        avgPrice?: number | null | undefined;
    } | null | undefined;
    gapDirection?: "UNDER" | "OVER" | "OK" | null | undefined;
} & mongoose.DefaultTimestampProps, {}, {}, {}, mongoose.Document<unknown, {}, {
    conditionId: string;
    checkedAt: NativeDate;
    title?: string | null | undefined;
    outcome?: string | null | undefined;
    gapSize?: number | null | undefined;
    gapPercent?: number | null | undefined;
    traderPosition?: {
        size?: number | null | undefined;
        avgPrice?: number | null | undefined;
    } | null | undefined;
    expectedPosition?: {
        size?: number | null | undefined;
    } | null | undefined;
    actualPosition?: {
        size?: number | null | undefined;
        avgPrice?: number | null | undefined;
    } | null | undefined;
    gapDirection?: "UNDER" | "OVER" | "OK" | null | undefined;
} & mongoose.DefaultTimestampProps, {}, {
    timestamps: true;
}> & {
    conditionId: string;
    checkedAt: NativeDate;
    title?: string | null | undefined;
    outcome?: string | null | undefined;
    gapSize?: number | null | undefined;
    gapPercent?: number | null | undefined;
    traderPosition?: {
        size?: number | null | undefined;
        avgPrice?: number | null | undefined;
    } | null | undefined;
    expectedPosition?: {
        size?: number | null | undefined;
    } | null | undefined;
    actualPosition?: {
        size?: number | null | undefined;
        avgPrice?: number | null | undefined;
    } | null | undefined;
    gapDirection?: "UNDER" | "OVER" | "OK" | null | undefined;
} & mongoose.DefaultTimestampProps & {
    _id: mongoose.Types.ObjectId;
} & {
    __v: number;
}, mongoose.Schema<any, mongoose.Model<any, any, any, any, any, any>, {}, {}, {}, {}, {
    timestamps: true;
}, {
    conditionId: string;
    checkedAt: NativeDate;
    title?: string | null | undefined;
    outcome?: string | null | undefined;
    gapSize?: number | null | undefined;
    gapPercent?: number | null | undefined;
    traderPosition?: {
        size?: number | null | undefined;
        avgPrice?: number | null | undefined;
    } | null | undefined;
    expectedPosition?: {
        size?: number | null | undefined;
    } | null | undefined;
    actualPosition?: {
        size?: number | null | undefined;
        avgPrice?: number | null | undefined;
    } | null | undefined;
    gapDirection?: "UNDER" | "OVER" | "OK" | null | undefined;
} & mongoose.DefaultTimestampProps, mongoose.Document<unknown, {}, mongoose.FlatRecord<{
    conditionId: string;
    checkedAt: NativeDate;
    title?: string | null | undefined;
    outcome?: string | null | undefined;
    gapSize?: number | null | undefined;
    gapPercent?: number | null | undefined;
    traderPosition?: {
        size?: number | null | undefined;
        avgPrice?: number | null | undefined;
    } | null | undefined;
    expectedPosition?: {
        size?: number | null | undefined;
    } | null | undefined;
    actualPosition?: {
        size?: number | null | undefined;
        avgPrice?: number | null | undefined;
    } | null | undefined;
    gapDirection?: "UNDER" | "OVER" | "OK" | null | undefined;
} & mongoose.DefaultTimestampProps>, {}, mongoose.ResolveSchemaOptions<{
    timestamps: true;
}>> & mongoose.FlatRecord<{
    conditionId: string;
    checkedAt: NativeDate;
    title?: string | null | undefined;
    outcome?: string | null | undefined;
    gapSize?: number | null | undefined;
    gapPercent?: number | null | undefined;
    traderPosition?: {
        size?: number | null | undefined;
        avgPrice?: number | null | undefined;
    } | null | undefined;
    expectedPosition?: {
        size?: number | null | undefined;
    } | null | undefined;
    actualPosition?: {
        size?: number | null | undefined;
        avgPrice?: number | null | undefined;
    } | null | undefined;
    gapDirection?: "UNDER" | "OVER" | "OK" | null | undefined;
} & mongoose.DefaultTimestampProps> & {
    _id: mongoose.Types.ObjectId;
} & {
    __v: number;
}>>;
