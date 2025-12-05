export class Logger {
  private prefix: string;

  constructor(prefix: string) {
    this.prefix = prefix;
  }

  info(...args: any[]) {
    console.log(`[${this.prefix}]`, ...args);
  }

  error(...args: any[]) {
    console.error(`[${this.prefix}] ERROR:`, ...args);
  }

  warn(...args: any[]) {
    console.warn(`[${this.prefix}] WARNING:`, ...args);
  }

  debug(...args: any[]) {
    console.debug(`[${this.prefix}] DEBUG:`, ...args);
  }

  success(...args: any[]) {
    console.log(`[${this.prefix}] ✓`, ...args);
  }
}

export function createLogger(prefix: string): Logger {
  return new Logger(prefix);
}
