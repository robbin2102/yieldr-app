import { EventEmitter } from 'events';

// Shared event bus for inter-module communication
export const eventBus = new EventEmitter();
eventBus.setMaxListeners(20);

// Event types emitted by the agent
export type EventType =
  | 'trade:detected'      // Detector → Executor: New trade from target wallet
  | 'trade:executing'     // Executor: Starting order submission
  | 'trade:submitted'     // Executor → Confirmer: Order submitted to CLOB
  | 'trade:filled'        // Confirmer: Order filled successfully
  | 'trade:failed'        // Executor/Confirmer: Order failed
  | 'trade:skipped'       // Executor: Trade skipped (risk check failed)
  | 'reconcile:complete'; // Reconciler: Position check complete
