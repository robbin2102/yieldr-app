import mongoose, { Schema, Document } from 'mongoose';

export interface IChatMessage {
  role: 'user' | 'agent';
  content: string;
  timestamp: Date;
}

export interface IPerMessageUsage {
  inputTokens: number;
  outputTokens: number;
  cost: number;
  model: string;
  toolCalls: { name: string; inputTokens?: number; outputTokens?: number }[];
  latencyMs: number;
  timestamp: Date;
}

export interface ITokenUsage {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  messageCount: number;
  lastModel: string;
  perMessage: IPerMessageUsage[];
}

export interface ICachedTokenBalance {
  symbol: string;
  chain: string;
  balance: string;
  usdValue: number;
}

export interface IChatSession extends Document {
  walletAddress: string;
  title: string;
  messages: IChatMessage[];
  tokenUsage: ITokenUsage;
  cachedTokenBalances?: ICachedTokenBalance[];
  cachedTokensTotalUsd?: number;
  tokenBalancesFetchedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ChatMessageSchema = new Schema({
  role: { type: String, enum: ['user', 'agent'], required: true },
  content: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
}, { _id: false });

const PerMessageUsageSchema = new Schema({
  inputTokens: { type: Number, default: 0 },
  outputTokens: { type: Number, default: 0 },
  cost: { type: Number, default: 0 },
  model: { type: String, default: '' },
  toolCalls: [{ name: String, inputTokens: Number, outputTokens: Number }],
  latencyMs: { type: Number, default: 0 },
  timestamp: { type: Date, default: Date.now },
}, { _id: false });

const ChatSessionSchema = new Schema<IChatSession>({
  walletAddress: {
    type: String,
    required: true,
    lowercase: true,
    index: true,
  },
  title: {
    type: String,
    default: 'New Chat',
    maxlength: 200,
  },
  messages: [ChatMessageSchema],
  tokenUsage: {
    totalInputTokens: { type: Number, default: 0 },
    totalOutputTokens: { type: Number, default: 0 },
    totalCost: { type: Number, default: 0 },
    messageCount: { type: Number, default: 0 },
    lastModel: { type: String, default: '' },
    perMessage: [PerMessageUsageSchema],
  },
  cachedTokenBalances: [{
    symbol: String,
    chain: String,
    balance: String,
    usdValue: Number,
  }],
  cachedTokensTotalUsd: { type: Number, default: 0 },
  tokenBalancesFetchedAt: Date,
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

ChatSessionSchema.index({ walletAddress: 1, updatedAt: -1 });

ChatSessionSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

export default mongoose.models.ChatSession ||
  mongoose.model<IChatSession>('ChatSession', ChatSessionSchema);
