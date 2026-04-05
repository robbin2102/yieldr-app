export declare let dbConnected: boolean;
/**
 * Resolves as soon as Mongoose reaches a connected state.
 * Use before any DB operation that must not run during a reconnect window.
 * Polls every 500ms; gives up after 60s.
 */
export declare function waitForConnection(timeoutMs?: number): Promise<void>;
/**
 * Connect to MongoDB with exponential backoff retry.
 * Attempts: 1s → 2s → 4s → 8s → 16s (5 total)
 */
export declare function connectDB(maxAttempts?: number): Promise<void>;
