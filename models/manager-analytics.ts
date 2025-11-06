import mongoose from 'mongoose';

/**
 * Manager Analytics Schema
 *
 * Stores pre-computed analytics and risk metrics for each manager.
 * Updated every 60 seconds during monitoring cycle.
 *
 * Contains all metrics shown in the Bloomberg-style dashboard:
 * - Performance metrics (PnL, ROI, win rate)
 * - Risk metrics (Sharpe, Sortino, Calmar, drawdown)
 * - Consistency metrics (streaks, daily performance)
 * - Trading statistics (avg hold time, position sizing, etc.)
 */

const ManagerAnalyticsSchema = new mongoose.Schema({
  // Identification
  managerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Manager',
    required: true,
    unique: true,
    index: true
  },
  username: {
    type: String,
    required: true,
    index: true
  },

  // === PERFORMANCE METRICS ===
  performance: {
    // Total metrics
    totalPnL: Number,
    totalROI: Number,
    totalAUM: Number,
    totalPositions: Number,

    // Time-based PnL & ROI
    pnl24h: Number,
    roi24h: Number,
    pnl7d: Number,
    roi7d: Number,
    pnl30d: Number,
    roi30d: Number,
    pnlAllTime: Number,
    roiAllTime: Number,

    // Win rate metrics
    winRate: Number,              // Overall win rate
    winRate30d: Number,
    totalTrades: Number,
    winningTrades: Number,
    losingTrades: Number,

    // Win/Loss breakdown
    avgWinAmount: Number,
    avgLossAmount: Number,
    avgWinPercentage: Number,
    avgLossPercentage: Number,
    winLossRatio: Number,         // avgWin / avgLoss

    // Best/Worst
    largestWin: Number,
    largestWinAsset: String,
    largestLoss: Number,
    largestLossAsset: String,
    bestPeriod30d: {
      roi: Number,
      date: Date
    },
    worstPeriod30d: {
      roi: Number,
      date: Date
    }
  },

  // === RISK METRICS ===
  risk: {
    // Risk-adjusted returns
    sharpeRatio: Number,           // (Return - RiskFreeRate) / StdDev
    sortinoRatio: Number,          // Return / DownsideDeviation
    calmarRatio: Number,           // AnnualReturn / MaxDrawdown

    // Drawdown metrics
    maxDrawdown: Number,           // Largest peak-to-trough decline
    maxDrawdownDate: Date,
    avgDrawdown: Number,
    currentDrawdown: Number,
    drawdownFrequency: Number,     // Avg days between drawdowns
    maxDrawdownsIn30d: Number,

    // Recovery metrics
    avgRecoveryTime: Number,       // Avg days to recover from drawdown
    recoveryRate: Number,          // % of drawdowns recovered
    currentRecoveryDays: Number,

    // Leverage & volatility
    avgLeverage: Number,
    maxLeverage: Number,
    volatility: Number,            // Standard deviation of returns
    downsideDeviation: Number,     // StdDev of negative returns only

    // Value at Risk
    var95: Number,                 // 95% confidence VaR
    var99: Number,                 // 99% confidence VaR
  },

  // === POSITION MANAGEMENT ===
  positionManagement: {
    // Position sizing
    avgPositionSize: Number,
    medianPositionSize: Number,
    positionSize75thPercentile: Number,
    positionSize95thPercentile: Number,
    positionSizeVariance: Number,  // Consistency score
    maxSinglePosition: Number,     // Largest position as % of portfolio

    // Concentration
    top3Concentration: Number,     // % of AUM in top 3 positions
    diversificationScore: Number,  // 0-10 score

    // Leverage discipline
    avgLeverageUsed: Number,
    maxLeverageUsed: Number,
    highLeverageFrequency: Number, // % of trades with >5x leverage

    // Stop loss discipline
    avgStopLossPercentage: Number,
    stopLossAdherence: Number,     // % of trades with SL hit before manual close
    avgLossAtCut: Number,          // Avg loss when position is closed
  },

  // === CONSISTENCY METRICS ===
  consistency: {
    // Streaks
    currentStreak: {
      type: String,  // 'win' or 'loss'
      count: Number,
      startDate: Date
    },
    longestWinStreak: Number,
    longestWinStreakDate: Date,
    longestLossStreak: Number,
    longestLossStreakDate: Date,

    // Time-based consistency
    activeDays: Number,            // Total days with trading activity
    activeDaysPercentage: Number,  // % of days active since inception
    avgTradingFrequency: Number,   // Avg days between trades
    positivePeriods30d: Number,    // Number of positive 30d periods
    positivePeriodsPercentage: Number,

    // Daily performance
    dailyWinRate: Number,          // % of profitable days
    profitableDays: Number,
    unprofitableDays: Number,
    breakEvenDays: Number,
  },

  // === TRADING STATISTICS ===
  trading: {
    // Hold time
    avgHoldTime: Number,           // In seconds
    avgHoldTimeWinners: Number,
    avgHoldTimeLosers: Number,
    tradingStyle: String,          // 'scalper', 'day-trader', 'swing-trader', 'position-trader'

    // Asset distribution
    topAssets: [{
      asset: String,
      aum: Number,
      trades: Number,
      winRate: Number,
      pnl: Number,
      roi: Number,
      sharpe: Number
    }],

    // Platform distribution
    platformDistribution: {
      avantis: Number,    // % of AUM
      hyperliquid: Number,
      aerodrome: Number,
      uniswap: Number
    },

    // Position types
    perpPositions: Number,
    lpPositions: Number,
    longPositions: Number,
    shortPositions: Number,
  },

  // === DAILY PERFORMANCE (for calendar view) ===
  dailyPerformance: [{
    date: Date,
    pnl: Number,
    roi: Number,
    trades: Number,
    result: {  // 'win', 'loss', 'breakeven', 'no_trading'
      type: String,
      enum: ['win', 'loss', 'breakeven', 'no_trading']
    }
  }],  // Last 90 days

  // Metadata
  lastCalculated: {
    type: Date,
    default: Date.now,
    index: true
  },
  calculationDuration: Number,  // Time taken to compute (ms)
  dataQuality: {
    completeness: Number,  // 0-100 score
    lastDataGap: Date,
    missingDataPoints: Number
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

// Indexes for efficient queries
ManagerAnalyticsSchema.index({ 'performance.roi30d': -1 });  // Top performers
ManagerAnalyticsSchema.index({ 'performance.totalAUM': -1 });  // By AUM
ManagerAnalyticsSchema.index({ 'risk.sharpeRatio': -1 });  // By risk-adjusted returns
ManagerAnalyticsSchema.index({ lastCalculated: -1 });  // Recently updated

// Update timestamp on save
ManagerAnalyticsSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

export default mongoose.models.ManagerAnalytics || mongoose.model('ManagerAnalytics', ManagerAnalyticsSchema);
