/**
 * Feature Flags for Avantis Listener
 * Control which features are enabled/disabled
 */

export const FEATURES = {
  /**
   * Enable event emission for plugins
   * Must be true for plugin system to work
   */
  ENABLE_EVENT_EMISSION: true,

  /**
   * Future: Enable automatic trade mirroring
   * When enabled, will copy manager trades to follower wallets
   */
  ENABLE_TRADE_MIRRORING: false,

  /**
   * Future: Enable analytics tracking
   * Real-time performance metrics, dashboards
   */
  ENABLE_ANALYTICS: false,

  /**
   * Future: Enable notifications
   * Send alerts when managers open/close trades
   */
  ENABLE_NOTIFICATIONS: false,

  /**
   * Enable real-time event listening
   * If false, only backfilling will work
   */
  ENABLE_REALTIME_LISTENER: true,

  /**
   * Enable verbose logging
   * Logs every event received and processed
   */
  ENABLE_VERBOSE_LOGGING: false,
} as const;

export type FeatureName = keyof typeof FEATURES;
