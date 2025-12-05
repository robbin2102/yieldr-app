/**
 * Simple logger utility for Polymarket tracker
 */

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[36m',
  red: '\x1b[31m',
  gray: '\x1b[90m',
};

export class Logger {
  private prefix: string;

  constructor(prefix: string) {
    this.prefix = prefix;
  }

  info(message: string, ...args: any[]) {
    console.log(
      `${colors.blue}[${this.prefix}]${colors.reset} ${message}`,
      ...args
    );
  }

  success(message: string, ...args: any[]) {
    console.log(
      `${colors.green}[${this.prefix}]${colors.reset} ${message}`,
      ...args
    );
  }

  warn(message: string, ...args: any[]) {
    console.warn(
      `${colors.yellow}[${this.prefix}]${colors.reset} ${message}`,
      ...args
    );
  }

  error(message: string, ...args: any[]) {
    console.error(
      `${colors.red}[${this.prefix}]${colors.reset} ${message}`,
      ...args
    );
  }

  debug(message: string, ...args: any[]) {
    console.log(
      `${colors.gray}[${this.prefix}]${colors.reset} ${message}`,
      ...args
    );
  }
}

export function createLogger(prefix: string): Logger {
  return new Logger(prefix);
}
