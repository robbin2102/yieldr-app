/** Truncate displayed balances; never round a token amount up. */
export function holdingQuantity(value: string | null): string {
  if (!value || !/^\d+(\.\d+)?$/.test(value)) return '—';
  const [whole, fraction = ''] = value.split('.');
  const integer = BigInt(whole);
  const digits = integer > BigInt(0) ? 2 : 4;
  const decimals = fraction.slice(0, digits).replace(/0+$/, '');
  if (integer === BigInt(0) && !decimals && /[1-9]/.test(fraction)) return '<0.0001';
  return integer.toLocaleString('en-US') + (decimals ? `.${decimals}` : '');
}
export function holdingReturn(value: string | null, basis: string | null) {
  if (value === null || basis === null || !value.trim() || !basis.trim()) return null;
  const current = Number(value), cost = Number(basis);
  if (!Number.isFinite(current) || !Number.isFinite(cost) || current < 0 || cost <= 0) return null;
  return { dollars: current - cost, percent: (current - cost) / cost * 100 };
}
