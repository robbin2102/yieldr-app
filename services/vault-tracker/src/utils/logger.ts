export function createLogger(namespace: string) {
  const prefix = `[${namespace}]`;
  return {
    info:    (...args: unknown[]) => console.log(new Date().toISOString(), prefix, ...args),
    success: (...args: unknown[]) => console.log(new Date().toISOString(), prefix, '✓', ...args),
    warn:    (...args: unknown[]) => console.warn(new Date().toISOString(), prefix, '⚠', ...args),
    error:   (...args: unknown[]) => console.error(new Date().toISOString(), prefix, '✗', ...args),
  };
}
