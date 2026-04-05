"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.dbConnected = void 0;
exports.waitForConnection = waitForConnection;
exports.connectDB = connectDB;
const mongoose_1 = __importDefault(require("mongoose"));
const config_1 = require("../config");
// Exported so other modules can check/wait on DB state.
exports.dbConnected = false;
/**
 * Resolves as soon as Mongoose reaches a connected state.
 * Use before any DB operation that must not run during a reconnect window.
 * Polls every 500ms; gives up after 60s.
 */
async function waitForConnection(timeoutMs = 60000) {
    if (mongoose_1.default.connection.readyState === 1)
        return;
    const deadline = Date.now() + timeoutMs;
    await new Promise((resolve, reject) => {
        const check = setInterval(() => {
            if (mongoose_1.default.connection.readyState === 1) {
                clearInterval(check);
                resolve();
            }
            else if (Date.now() > deadline) {
                clearInterval(check);
                reject(new Error('[DB] waitForConnection timed out'));
            }
        }, 500);
    });
}
const MONGO_OPTIONS = {
    dbName: 'yieldr',
    // How long to wait for a server selection before failing a single operation.
    // Generous for Railway proxy latency.
    serverSelectionTimeoutMS: 30000,
    // Idle socket timeout — closes sockets that haven't been used.
    socketTimeoutMS: 45000,
    // How often Mongoose heartbeats the server; controls how quickly a drop is detected.
    heartbeatFrequencyMS: 10000,
    // Force IPv4 to avoid Railway/Atlas IPv6 lookup issues.
    family: 4,
};
/**
 * Connect to MongoDB with exponential backoff retry.
 * Attempts: 1s → 2s → 4s → 8s → 16s (5 total)
 */
async function connectDB(maxAttempts = 5) {
    let attempt = 0;
    let delay = 1000;
    while (attempt < maxAttempts) {
        attempt++;
        try {
            await mongoose_1.default.connect(config_1.config.mongoUri, MONGO_OPTIONS);
            break;
        }
        catch (err) {
            if (attempt >= maxAttempts) {
                throw new Error(`[DB] Failed to connect after ${maxAttempts} attempts: ${err.message}`);
            }
            console.warn(`[DB] Connection attempt ${attempt}/${maxAttempts} failed — retrying in ${delay / 1000}s (${err.message})`);
            await new Promise(r => setTimeout(r, delay));
            delay = Math.min(delay * 2, 16000);
        }
    }
    exports.dbConnected = true;
    console.log('[DB] Connected to MongoDB (yieldr database)');
    // Log reconnection events — don't crash on transient Railway proxy timeouts.
    mongoose_1.default.connection.on('disconnected', () => {
        exports.dbConnected = false;
        console.warn('[DB] MongoDB disconnected — Mongoose will reconnect automatically');
    });
    mongoose_1.default.connection.on('reconnected', () => {
        exports.dbConnected = true;
        console.log('[DB] MongoDB reconnected');
    });
    mongoose_1.default.connection.on('error', (err) => console.error('[DB] MongoDB connection error (non-fatal):', err.message));
}
//# sourceMappingURL=connection.js.map