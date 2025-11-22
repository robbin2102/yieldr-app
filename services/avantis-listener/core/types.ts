/**
 * Shared core types
 */

import type { PublicClient, Log } from 'viem';

/**
 * Viem client type
 */
export type ViemPublicClient = PublicClient;

/**
 * Event log type
 */
export type EventLog = Log;

/**
 * Retry options
 */
export interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  exponentialBase?: number;
}

/**
 * Backfill options
 */
export interface BackfillOptions {
  wallet: string;
  daysBack?: number;
  startBlock?: number;
  endBlock?: number;
  chunkSize?: number;
  parallelChunks?: number; // Number of chunks to process in parallel
}

/**
 * Listener status
 */
export interface ListenerStatus {
  isRunning: boolean;
  lastEventTime?: Date;
  eventsProcessed: number;
  errorsCount: number;
  reconnectAttempts: number;
  monitoredWallets: string[];
}
