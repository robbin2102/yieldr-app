/**
 * Simple logger with prefixes
 */

export function createLogger(prefix: string) {
  return {
    info:    (msg: string) => console.log(`[${prefix}] ${msg}`),
    warn:    (msg: string) => console.warn(`[${prefix}] ${msg}`),
    error:   (msg: string) => console.error(`[${prefix}] ${msg}`),
    success: (msg: string) => console.log(`[${prefix}] ✓ ${msg}`),
  };
}
