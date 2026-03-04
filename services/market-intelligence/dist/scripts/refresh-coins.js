"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * npm run refresh-coins
 * Forces a refresh of the dynamic tracked coins list.
 */
const dotenv = __importStar(require("dotenv"));
dotenv.config();
const db_1 = require("../db");
const tracker_1 = require("../coins/tracker");
const logger_1 = require("../utils/logger");
async function main() {
    await (0, db_1.connectDB)();
    logger_1.logger.info('Script', 'Refreshing tracked coins list...');
    const { all, full, lite } = await (0, tracker_1.refreshTrackedCoins)();
    logger_1.logger.info('Script', `✓ Tracked coins refreshed`);
    logger_1.logger.info('Script', `  Total: ${all.length}`);
    logger_1.logger.info('Script', `  Full (top ${full.length}): ${full.join(', ')}`);
    logger_1.logger.info('Script', `  Lite (${lite.length} coins): ${lite.slice(0, 10).join(', ')}...`);
    await (0, db_1.disconnectDB)();
    process.exit(0);
}
main().catch(err => {
    console.error(err);
    process.exit(1);
});
//# sourceMappingURL=refresh-coins.js.map