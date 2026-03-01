"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.mongoose = void 0;
exports.connectDB = connectDB;
exports.disconnectDB = disconnectDB;
const mongoose_1 = __importDefault(require("mongoose"));
exports.mongoose = mongoose_1.default;
const config_1 = require("./config");
const logger_1 = require("./utils/logger");
let connected = false;
async function connectDB() {
    if (connected)
        return;
    const uri = config_1.config.mongodbUri;
    // Determine if we need to replace SRV with standard format for Railway proxy
    // Railway MongoDB proxy does not support SRV records
    let connectionUri = uri;
    if (uri.startsWith('mongodb+srv://') && process.env.RAILWAY_ENVIRONMENT) {
        // For Railway, the MONGODB_URI should already be the correct format
        // but we keep this note for debugging
    }
    await mongoose_1.default.connect(connectionUri, {
        serverSelectionTimeoutMS: 30000,
        socketTimeoutMS: 45000,
    });
    connected = true;
    logger_1.logger.info('DB', 'Connected to MongoDB');
}
async function disconnectDB() {
    if (!connected)
        return;
    await mongoose_1.default.disconnect();
    connected = false;
    logger_1.logger.info('DB', 'Disconnected from MongoDB');
}
//# sourceMappingURL=db.js.map