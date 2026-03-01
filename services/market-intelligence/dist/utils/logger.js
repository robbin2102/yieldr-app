"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.logger = void 0;
function log(level, context, message, data) {
    const ts = new Date().toISOString();
    const prefix = `[${ts}] [${level.toUpperCase()}] [${context}]`;
    if (data !== undefined) {
        console.log(`${prefix} ${message}`, data);
    }
    else {
        console.log(`${prefix} ${message}`);
    }
}
exports.logger = {
    info: (context, message, data) => log('info', context, message, data),
    warn: (context, message, data) => log('warn', context, message, data),
    error: (context, message, data) => log('error', context, message, data),
    debug: (context, message, data) => {
        if (process.env.DEBUG)
            log('debug', context, message, data);
    },
};
//# sourceMappingURL=logger.js.map