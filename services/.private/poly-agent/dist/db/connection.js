"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.connectDB = connectDB;
const mongoose_1 = __importDefault(require("mongoose"));
const config_1 = require("../config");
async function connectDB() {
    await mongoose_1.default.connect(config_1.config.mongoUri, { dbName: 'yieldr' });
    console.log('[DB] Connected to MongoDB (yieldr database)');
}
//# sourceMappingURL=connection.js.map