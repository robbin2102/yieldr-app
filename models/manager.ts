import mongoose from 'mongoose';

const PositionSchema = new mongoose.Schema({
  asset: String,
  platform: String,
  type: String,
  size: Number,
  margin: Number,
  entry: Number,
  current: Number,
  pnl: Number,
  roi: Number,
  leverage: Number,
  takeProfit: Number,
  stopLoss: Number,
  liquidationPrice: Number
}, { _id: false });

const ManagerSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  username: {
    type: String,
    unique: true,
    required: true,
    lowercase: true
  },
  profilePicture: {
    type: String,
    default: ''
  },
  walletAddress: {
    type: String,
    required: true
  },
  
  // Profile text
  marketOutlook: {
    type: String,
    default: ''
  },
  investmentThesis: {
    type: String,
    default: ''
  },
  positionStrategy: {
    type: String,
    default: ''
  },
  
  // Platforms
  platforms: {
    type: [String],
    default: []
  },
  
  // Performance metrics
  metrics: {
    totalPnL30d: { type: Number, default: 0 },
    roi30d: { type: Number, default: 0 },
    winRate: { type: Number, default: 0 },
    totalAUM: { type: Number, default: 0 },
    totalTrades: { type: Number, default: 0 },
    avgPositionSize: { type: Number, default: 0 }
  },
  
  // Live positions
  positions: [PositionSchema],
  
  // Metadata
  verified: {
    type: Boolean,
    default: false
  },
  lastPositionSync: {
    type: Date,
    default: null
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

ManagerSchema.index({ username: 1 });
ManagerSchema.index({ walletAddress: 1 });

export default mongoose.models.Manager || mongoose.model('Manager', ManagerSchema);
