import { EventEmitter } from 'events';

// Shared event bus for inter-module communication
export const eventBus = new EventEmitter();
eventBus.setMaxListeners(20);

// Event types emitted by the agent
export type EventType =
  | 'trade:detected'   // MultiDetector → GTTExecutor: new TRADE(BUY/SELL) activity
  | 'trade:executing'  // GTTExecutor: bet sized, first GTT order being placed
  | 'trade:filled'     // GTTExecutor: order filled (full or partial)
  | 'trade:failed'     // GTTExecutor: GTT failed after all retries
  | 'trade:skipped';   // GTTExecutor: trade skipped with reason code
