// Money is BigInt minor units. RWF has no minor unit, so 450000 = RWF 450,000.
// For currencies with cents, divide by 100 when formatting.

export function formatMoney(amount: bigint, currency: string): string {
  const isZeroDecimal = ['RWF', 'UGX', 'XOF', 'XAF'].includes(currency);
  const value = isZeroDecimal ? Number(amount) : Number(amount) / 100;
  const formatted = value.toLocaleString('en-RW', {
    minimumFractionDigits: isZeroDecimal ? 0 : 2,
    maximumFractionDigits: isZeroDecimal ? 0 : 2,
  });
  return `${currency} ${formatted}`;
}

// Serialise BigInt safely in JSON responses (Express can't stringify BigInt).
export function jsonSafe<T>(obj: T): T {
  return JSON.parse(
    JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
  );
}
