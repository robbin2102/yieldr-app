# Avantis Listener Plugin System

## Overview

The plugin system allows you to extend the Avantis event listener with custom functionality **without modifying the core service**. Plugins react to trade events (opened, closed, TP/SL updated) and can implement features like:

- **Trade Mirroring**: Automatically copy manager trades to follower wallets
- **Analytics**: Real-time performance tracking and dashboards
- **Notifications**: Send alerts when managers trade
- **Risk Management**: Implement position size limits, loss limits
- **Social Features**: Leaderboards, following, community notifications

## Architecture

```
EventListener → EventCorrelator → EventEmitter → PluginManager → Individual Plugins
                                                                   ├─ TradeMirrorPlugin
                                                                   ├─ AnalyticsPlugin
                                                                   └─ NotificationPlugin
```

**Key Benefits:**
- ✅ Isolated execution (plugin errors don't crash main service)
- ✅ Easy enable/disable via feature flags
- ✅ No core code modifications needed
- ✅ Clean event-driven architecture

## Creating a Plugin

### 1. Extend BasePlugin

Create a new file in `/services/avantis-listener/plugins/`:

```typescript
import { BasePlugin } from './BasePlugin';
import type { TradeOpenedEvent, TradeClosedEvent } from '../types/trades';

export class MyCustomPlugin extends BasePlugin {
  readonly name = 'MyCustomPlugin';
  readonly enabled = true; // Or read from FEATURES config

  async onTradeOpened(trade: TradeOpenedEvent): Promise<void> {
    await this.execute(async () => {
      this.log('Trade opened', {
        orderId: trade.orderId,
        trader: trade.trader,
        direction: trade.direction,
      });

      // Your custom logic here
      // e.g., send notification, mirror trade, update analytics
    });
  }

  async onTradeClosed(trade: TradeClosedEvent): Promise<void> {
    await this.execute(async () => {
      this.log('Trade closed', {
        orderId: trade.orderId,
        pnl: trade.pnl,
        roi: trade.roi,
      });

      // Your custom logic here
    });
  }

  cleanup(): void {
    this.log('Cleaning up resources');
    // Close connections, save state, etc.
  }
}
```

### 2. Register Plugin

In `/services/avantis-listener/index.ts`:

```typescript
import { MyCustomPlugin } from './plugins/MyCustomPlugin';

// In startAvantisListener function:
const myPlugin = new MyCustomPlugin();
pluginManager.register(myPlugin);
```

### 3. Add Feature Flag (Optional)

In `/services/avantis-listener/config/features.ts`:

```typescript
export const FEATURES = {
  // ... existing flags
  ENABLE_MY_CUSTOM_PLUGIN: true,
} as const;
```

Then in your plugin:

```typescript
import { FEATURES } from '../config';

export class MyCustomPlugin extends BasePlugin {
  readonly name = 'MyCustomPlugin';
  readonly enabled = FEATURES.ENABLE_MY_CUSTOM_PLUGIN;
  // ...
}
```

## Event Data Structures

### TradeOpenedEvent

```typescript
{
  orderId: string;
  trader: string;
  pairIndex: number;
  direction: 'LONG' | 'SHORT';
  collateral: number;          // USDC
  positionSize: number;         // USDC
  leverage: number;
  openPrice: number;
  executionPrice: number;
  tp: number;                   // Take profit price
  sl: number;                   // Stop loss price
  executedAt: Date;
  txHash: string;
  blockNumber: number;
}
```

### TradeClosedEvent

```typescript
{
  orderId: string;
  trader: string;
  pairIndex: number;
  direction: 'LONG' | 'SHORT';
  closePrice: number;
  pnl: number;                  // Profit/Loss in USDC (can be negative)
  profitPercent: number;        // Percentage (can be negative)
  roi: number;                  // Return on investment %
  durationSeconds: number;
  closedAt: Date;
  txHash: string;
  blockNumber: number;
}
```

## Example: Trade Mirror Plugin

```typescript
import { BasePlugin } from './BasePlugin';
import type { TradeOpenedEvent, TradeClosedEvent } from '../types/trades';
import { FEATURES } from '../config';

export class TradeMirrorPlugin extends BasePlugin {
  readonly name = 'TradeMirror';
  readonly enabled = FEATURES.ENABLE_TRADE_MIRRORING;

  private followers: Map<string, string[]> = new Map(); // manager -> follower wallets

  async onTradeOpened(trade: TradeOpenedEvent): Promise<void> {
    await this.execute(async () => {
      const followers = this.followers.get(trade.trader);

      if (!followers || followers.length === 0) {
        return; // No followers for this manager
      }

      this.log(`Mirroring trade ${trade.orderId} to ${followers.length} followers`);

      for (const follower of followers) {
        try {
          await this.mirrorTrade(follower, trade);
        } catch (error) {
          this.logError(`Failed to mirror trade for ${follower}`, error);
        }
      }
    });
  }

  async onTradeClosed(trade: TradeClosedEvent): Promise<void> {
    await this.execute(async () => {
      const followers = this.followers.get(trade.trader);

      if (!followers || followers.length === 0) {
        return;
      }

      this.log(`Closing mirrored positions for ${followers.length} followers`);

      for (const follower of followers) {
        try {
          await this.closeMirroredTrade(follower, trade);
        } catch (error) {
          this.logError(`Failed to close mirrored trade for ${follower}`, error);
        }
      }
    });
  }

  private async mirrorTrade(followerWallet: string, trade: TradeOpenedEvent): Promise<void> {
    // Implementation:
    // 1. Calculate follower's position size based on their capital allocation
    // 2. Sign transaction using follower's wallet (via custody solution)
    // 3. Submit trade to Avantis
    // 4. Save mirror record to DB
    this.log(`Mirrored trade to ${followerWallet}`);
  }

  private async closeMirroredTrade(followerWallet: string, trade: TradeClosedEvent): Promise<void> {
    // Implementation:
    // 1. Find mirrored position for this follower
    // 2. Close the position
    // 3. Update mirror record
    this.log(`Closed mirrored trade for ${followerWallet}`);
  }

  addFollower(manager: string, follower: string): void {
    const existing = this.followers.get(manager) || [];
    this.followers.set(manager, [...existing, follower]);
  }

  removeFollower(manager: string, follower: string): void {
    const existing = this.followers.get(manager) || [];
    this.followers.set(
      manager,
      existing.filter((f) => f !== follower)
    );
  }

  cleanup(): void {
    this.followers.clear();
    this.log('Cleaned up');
  }
}
```

## Best Practices

1. **Always use `this.execute()`** - Wraps your code in try-catch to prevent crashes
2. **Use logging helpers** - `this.log()` and `this.logError()` for consistent logging
3. **Keep plugins stateless when possible** - Use MongoDB for state persistence
4. **Implement cleanup()** - Close connections, clear timers, save state
5. **Handle errors gracefully** - Don't throw errors outside of `execute()`
6. **Test plugins independently** - Write unit tests for plugin logic
7. **Use feature flags** - Allow plugins to be enabled/disabled easily

## Testing Plugins

```typescript
import { MyCustomPlugin } from './MyCustomPlugin';

describe('MyCustomPlugin', () => {
  let plugin: MyCustomPlugin;

  beforeEach(() => {
    plugin = new MyCustomPlugin();
  });

  afterEach(() => {
    plugin.cleanup();
  });

  it('should handle trade opened event', async () => {
    const trade = {
      orderId: '123',
      trader: '0x...',
      // ... other fields
    };

    await plugin.onTradeOpened(trade);

    // Assert your expectations
  });
});
```

## Future Plugin Ideas

- **Analytics Dashboard** - Real-time charts, performance metrics
- **Discord Bot** - Post trade notifications to Discord channels
- **Telegram Alerts** - Send trade alerts to Telegram
- **Risk Manager** - Automatically close positions if loss limits exceeded
- **Performance Tracker** - Calculate advanced metrics (Sharpe ratio, max drawdown)
- **Leaderboard** - Maintain real-time rankings of top managers
- **Social Feed** - Create activity feed of manager trades
- **Portfolio Optimizer** - Suggest optimal position sizes based on risk

## Questions?

Check the main README or inspect existing plugins for reference.
