/**
 * PolyMarket Model
 * Stores Polymarket market data for markets ending within 30 days
 */

import mongoose, { Schema, Document, Model } from 'mongoose';

// Embedded schemas for nested objects
const ImageOptimizedSchema = new Schema({
  id: String,
  imageUrlSource: String,
  imageUrlOptimized: String,
  imageSizeKbSource: Number,
  imageSizeKbOptimized: Number,
  imageOptimizedComplete: Boolean,
  imageOptimizedLastUpdated: String,
  relID: Number,
  field: String,
  relname: String,
}, { _id: false });

const CategorySchema = new Schema({
  id: String,
  label: String,
  parentCategory: String,
  slug: String,
  publishedAt: String,
  createdAt: Date,
  updatedAt: Date,
}, { _id: false });

const TagSchema = new Schema({
  id: String,
  label: String,
  slug: String,
  forceShow: Boolean,
  forceHide: Boolean,
  isCarousel: Boolean,
  publishedAt: String,
  createdAt: Date,
  updatedAt: Date,
}, { _id: false });

const EventSummarySchema = new Schema({
  id: String,
  title: String,
  slug: String,
  ticker: String,
  category: String,
  subcategory: String,
  description: String,
  startDate: Date,
  endDate: Date,
  active: Boolean,
  closed: Boolean,
  volume: Number,
  liquidity: Number,
  negRisk: Boolean,
  negRiskMarketID: String,
}, { _id: false });

// Main PolyMarket schema
export interface IPolyMarket extends Document {
  // Identifiers
  id: string;
  conditionId: string;
  slug: string;
  questionID?: string;

  // Market Info
  question: string;
  description?: string;
  category?: string;
  outcomes?: string;
  outcomePrices?: string;
  shortOutcomes?: string;
  marketType?: string;
  formatType?: string;
  ammType?: string;

  // Dates
  startDate?: Date;
  endDate: Date;
  endDateIso?: string;
  startDateIso?: string;
  createdAt?: Date;
  updatedAt?: Date;
  closedTime?: string;
  umaEndDate?: string;
  umaEndDateIso?: string;

  // Volume & Liquidity
  volume?: string;
  volumeNum?: number;
  volume24hr?: number;
  volume1wk?: number;
  volume1mo?: number;
  volume1yr?: number;
  liquidity?: string;
  liquidityNum?: number;
  liquidityAmm?: number;
  liquidityClob?: number;

  // AMM vs CLOB volume breakdown
  volume24hrAmm?: number;
  volume1wkAmm?: number;
  volume1moAmm?: number;
  volume1yrAmm?: number;
  volume24hrClob?: number;
  volume1wkClob?: number;
  volume1moClob?: number;
  volume1yrClob?: number;
  volumeAmm?: number;
  volumeClob?: number;

  // Status Flags
  active?: boolean;
  closed?: boolean;
  archived?: boolean;
  new?: boolean;
  featured?: boolean;
  restricted?: boolean;
  wideFormat?: boolean;
  enableOrderBook?: boolean;
  acceptingOrders?: boolean;
  fpmmLive?: boolean;
  ready?: boolean;
  funded?: boolean;
  commentsEnabled?: boolean;
  notificationsEnabled?: boolean;

  // CLOB Info
  clobTokenIds?: string;
  orderPriceMinTickSize?: number;
  orderMinSize?: number;
  makerBaseFee?: number;
  takerBaseFee?: number;

  // Media
  image?: string;
  icon?: string;
  twitterCardImage?: string;

  // Resolution
  resolutionSource?: string;
  umaResolutionStatus?: string;
  resolvedBy?: string;
  automaticallyResolved?: boolean;

  // Pricing
  bestBid?: number;
  bestAsk?: number;
  lastTradePrice?: number;
  spread?: number;
  fee?: string;

  // Price Changes
  oneHourPriceChange?: number;
  oneDayPriceChange?: number;
  oneWeekPriceChange?: number;
  oneMonthPriceChange?: number;
  oneYearPriceChange?: number;

  // Bounds (for range markets)
  lowerBound?: string;
  upperBound?: string;
  lowerBoundDate?: string;
  upperBoundDate?: string;

  // Sponsor
  sponsorName?: string;
  sponsorImage?: string;

  // Market Group
  marketGroup?: number;
  groupItemTitle?: string;
  groupItemThreshold?: string;
  groupItemRange?: string;

  // UMA
  umaBond?: string;
  umaReward?: string;
  customLiveness?: number;

  // Sports
  gameStartTime?: string;
  secondsDelay?: number;
  teamAID?: string;
  teamBID?: string;
  sportsMarketType?: string;
  line?: number;
  gameId?: string;

  // Misc
  denominationToken?: string;
  xAxisValue?: string;
  yAxisValue?: string;
  curationOrder?: number;
  score?: number;
  competitive?: number;
  rewardsMinSize?: number;
  rewardsMaxSpread?: number;
  creator?: string;
  createdBy?: number;
  updatedBy?: number;
  marketMakerAddress?: string;
  disqusThread?: string;
  mailchimpTag?: string;
  pastSlugs?: string;

  // Timestamps
  readyTimestamp?: Date;
  fundedTimestamp?: Date;
  acceptingOrdersTimestamp?: Date;
  deployingTimestamp?: Date;
  scheduledDeploymentTimestamp?: Date;
  eventStartTime?: Date;

  // Flags
  pendingDeployment?: boolean;
  deploying?: boolean;
  rfqEnabled?: boolean;
  hasReviewedDates?: boolean;
  readyForCron?: boolean;
  automaticallyActive?: boolean;
  clearBookOnStart?: boolean;
  manualActivation?: boolean;
  negRiskOther?: boolean;
  showGmpSeries?: boolean;
  showGmpOutcome?: boolean;

  // Optimized images
  imageOptimized?: typeof ImageOptimizedSchema;
  iconOptimized?: typeof ImageOptimizedSchema;

  // Related data (embedded)
  events?: typeof EventSummarySchema[];
  categories?: typeof CategorySchema[];
  tags?: typeof TagSchema[];

  // Our tracking fields
  fetchedAt: Date;
  daysUntilEnd: number;
  holdersIndexed: boolean;
  holdersIndexedAt?: Date;
}

const PolyMarketSchema = new Schema<IPolyMarket>({
  // === IDENTIFIERS ===
  id: { type: String, required: true, unique: true },
  conditionId: { type: String, required: true, index: true },
  slug: { type: String, required: true },
  questionID: String,

  // === MARKET INFO ===
  question: { type: String, required: true },
  description: String,
  category: { type: String, index: true },
  outcomes: String,
  outcomePrices: String,
  shortOutcomes: String,
  marketType: String,
  formatType: String,
  ammType: String,

  // === DATES ===
  startDate: Date,
  endDate: { type: Date, required: true, index: true },
  endDateIso: String,
  startDateIso: String,
  createdAt: Date,
  updatedAt: Date,
  closedTime: String,
  umaEndDate: String,
  umaEndDateIso: String,

  // === VOLUME & LIQUIDITY ===
  volume: String,
  volumeNum: { type: Number, index: true },
  volume24hr: Number,
  volume1wk: Number,
  volume1mo: Number,
  volume1yr: Number,
  liquidity: String,
  liquidityNum: Number,
  liquidityAmm: Number,
  liquidityClob: Number,

  // AMM vs CLOB breakdown
  volume24hrAmm: Number,
  volume1wkAmm: Number,
  volume1moAmm: Number,
  volume1yrAmm: Number,
  volume24hrClob: Number,
  volume1wkClob: Number,
  volume1moClob: Number,
  volume1yrClob: Number,
  volumeAmm: Number,
  volumeClob: Number,

  // === STATUS FLAGS ===
  active: { type: Boolean, default: true },
  closed: { type: Boolean, default: false },
  archived: { type: Boolean, default: false },
  new: Boolean,
  featured: Boolean,
  restricted: Boolean,
  wideFormat: Boolean,
  enableOrderBook: Boolean,
  acceptingOrders: Boolean,
  fpmmLive: Boolean,
  ready: Boolean,
  funded: Boolean,
  commentsEnabled: Boolean,
  notificationsEnabled: Boolean,

  // === CLOB INFO ===
  clobTokenIds: String,
  orderPriceMinTickSize: Number,
  orderMinSize: Number,
  makerBaseFee: Number,
  takerBaseFee: Number,

  // === MEDIA ===
  image: String,
  icon: String,
  twitterCardImage: String,

  // === RESOLUTION ===
  resolutionSource: String,
  umaResolutionStatus: String,
  resolvedBy: String,
  automaticallyResolved: Boolean,

  // === PRICING ===
  bestBid: Number,
  bestAsk: Number,
  lastTradePrice: Number,
  spread: Number,
  fee: String,

  // === PRICE CHANGES ===
  oneHourPriceChange: Number,
  oneDayPriceChange: Number,
  oneWeekPriceChange: Number,
  oneMonthPriceChange: Number,
  oneYearPriceChange: Number,

  // === BOUNDS ===
  lowerBound: String,
  upperBound: String,
  lowerBoundDate: String,
  upperBoundDate: String,

  // === SPONSOR ===
  sponsorName: String,
  sponsorImage: String,

  // === MARKET GROUP ===
  marketGroup: Number,
  groupItemTitle: String,
  groupItemThreshold: String,
  groupItemRange: String,

  // === UMA ===
  umaBond: String,
  umaReward: String,
  customLiveness: Number,

  // === SPORTS ===
  gameStartTime: String,
  secondsDelay: Number,
  teamAID: String,
  teamBID: String,
  sportsMarketType: String,
  line: Number,
  gameId: String,

  // === MISC ===
  denominationToken: String,
  xAxisValue: String,
  yAxisValue: String,
  curationOrder: Number,
  score: Number,
  competitive: Number,
  rewardsMinSize: Number,
  rewardsMaxSpread: Number,
  creator: String,
  createdBy: Number,
  updatedBy: Number,
  marketMakerAddress: String,
  disqusThread: String,
  mailchimpTag: String,
  pastSlugs: String,

  // === TIMESTAMPS ===
  readyTimestamp: Date,
  fundedTimestamp: Date,
  acceptingOrdersTimestamp: Date,
  deployingTimestamp: Date,
  scheduledDeploymentTimestamp: Date,
  eventStartTime: Date,

  // === FLAGS ===
  pendingDeployment: Boolean,
  deploying: Boolean,
  rfqEnabled: Boolean,
  hasReviewedDates: Boolean,
  readyForCron: Boolean,
  automaticallyActive: Boolean,
  clearBookOnStart: Boolean,
  manualActivation: Boolean,
  negRiskOther: Boolean,
  showGmpSeries: Boolean,
  showGmpOutcome: Boolean,

  // === OPTIMIZED IMAGES ===
  imageOptimized: ImageOptimizedSchema,
  iconOptimized: ImageOptimizedSchema,

  // === RELATED DATA ===
  events: [EventSummarySchema],
  categories: [CategorySchema],
  tags: [TagSchema],

  // === OUR TRACKING ===
  fetchedAt: { type: Date, default: Date.now },
  daysUntilEnd: { type: Number },
  holdersIndexed: { type: Boolean, default: false },
  holdersIndexedAt: Date,
}, {
  timestamps: { createdAt: 'dbCreatedAt', updatedAt: 'dbUpdatedAt' },
  collection: 'polyMarkets',
});

// Indexes for efficient queries
PolyMarketSchema.index({ endDate: 1, volumeNum: -1 });
PolyMarketSchema.index({ category: 1, endDate: 1 });
PolyMarketSchema.index({ active: 1, closed: 1, endDate: 1 });
PolyMarketSchema.index({ holdersIndexed: 1 });
PolyMarketSchema.index({ daysUntilEnd: 1 });

// Prevent model recompilation in development
const PolyMarket: Model<IPolyMarket> =
  mongoose.models.PolyMarket || mongoose.model<IPolyMarket>('PolyMarket', PolyMarketSchema);

export default PolyMarket;
