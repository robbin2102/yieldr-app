type Level = 'info' | 'warn' | 'error' | 'debug';

function log(level: Level, context: string, message: string, data?: unknown): void {
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level.toUpperCase()}] [${context}]`;
  if (data !== undefined) {
    console.log(`${prefix} ${message}`, data);
  } else {
    console.log(`${prefix} ${message}`);
  }
}

export const logger = {
  info:  (context: string, message: string, data?: unknown) => log('info',  context, message, data),
  warn:  (context: string, message: string, data?: unknown) => log('warn',  context, message, data),
  error: (context: string, message: string, data?: unknown) => log('error', context, message, data),
  debug: (context: string, message: string, data?: unknown) => {
    if (process.env.DEBUG) log('debug', context, message, data);
  },
};
