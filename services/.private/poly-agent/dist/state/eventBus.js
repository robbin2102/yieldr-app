"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.eventBus = void 0;
const events_1 = require("events");
// Shared event bus for inter-module communication
exports.eventBus = new events_1.EventEmitter();
exports.eventBus.setMaxListeners(20);
//# sourceMappingURL=eventBus.js.map