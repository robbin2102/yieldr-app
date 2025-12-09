import mongoose from 'mongoose';
export declare const PolyAgentSlippage: mongoose.Model<{
    _id: string;
    totalExpectedCost: number;
    totalActualCost: number;
    bufferUsdc: number;
    totalTrades: number;
    totalPositiveSlippage: number;
    totalNegativeSlippage: number;
    lastUpdated: NativeDate;
} & mongoose.DefaultTimestampProps, {}, {}, {}, mongoose.Document<unknown, {}, {
    _id: string;
    totalExpectedCost: number;
    totalActualCost: number;
    bufferUsdc: number;
    totalTrades: number;
    totalPositiveSlippage: number;
    totalNegativeSlippage: number;
    lastUpdated: NativeDate;
} & mongoose.DefaultTimestampProps, {}, {
    timestamps: true;
}> & {
    _id: string;
    totalExpectedCost: number;
    totalActualCost: number;
    bufferUsdc: number;
    totalTrades: number;
    totalPositiveSlippage: number;
    totalNegativeSlippage: number;
    lastUpdated: NativeDate;
} & mongoose.DefaultTimestampProps & Required<{
    _id: string;
}> & {
    __v: number;
}, mongoose.Schema<any, mongoose.Model<any, any, any, any, any, any>, {}, {}, {}, {}, {
    timestamps: true;
}, {
    _id: string;
    totalExpectedCost: number;
    totalActualCost: number;
    bufferUsdc: number;
    totalTrades: number;
    totalPositiveSlippage: number;
    totalNegativeSlippage: number;
    lastUpdated: NativeDate;
} & mongoose.DefaultTimestampProps, mongoose.Document<unknown, {}, mongoose.FlatRecord<{
    _id: string;
    totalExpectedCost: number;
    totalActualCost: number;
    bufferUsdc: number;
    totalTrades: number;
    totalPositiveSlippage: number;
    totalNegativeSlippage: number;
    lastUpdated: NativeDate;
} & mongoose.DefaultTimestampProps>, {}, mongoose.ResolveSchemaOptions<{
    timestamps: true;
}>> & mongoose.FlatRecord<{
    _id: string;
    totalExpectedCost: number;
    totalActualCost: number;
    bufferUsdc: number;
    totalTrades: number;
    totalPositiveSlippage: number;
    totalNegativeSlippage: number;
    lastUpdated: NativeDate;
} & mongoose.DefaultTimestampProps> & Required<{
    _id: string;
}> & {
    __v: number;
}>>;
