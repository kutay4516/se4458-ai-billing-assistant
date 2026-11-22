/**
 * Pricing rules from the assignment (Calculate Bill API):
 *  - Phone: first 1,000 minutes free, then $10 per started 1,000-minute block.
 *  - Internet: $50 up to 20 GB, then $10 per started additional 10 GB block.
 *  - 1 GB = 1,000 MB.
 */
export const PRICING = {
  phoneFreeMinutes: 1000,
  phoneBlockMinutes: 1000,
  phoneBlockPrice: 10,
  internetBasePrice: 50,
  internetIncludedMb: 20_000,
  internetBlockMb: 10_000,
  internetBlockPrice: 10,
} as const;

export interface Charges {
  phoneMinutes: number;
  internetMb: number;
  phoneBlocks: number;
  phoneCharge: number;
  internetBaseCharge: number;
  internetOverageBlocks: number;
  internetOverageCharge: number;
  internetCharge: number;
  total: number;
}

export function calculateCharges(phoneMinutes: number, internetMb: number): Charges {
  if (!Number.isFinite(phoneMinutes) || phoneMinutes < 0 || !Number.isFinite(internetMb) || internetMb < 0) {
    throw new RangeError("Usage totals must be finite, non-negative numbers");
  }
  const phoneBlocks = phoneMinutes > PRICING.phoneFreeMinutes
    ? Math.ceil((phoneMinutes - PRICING.phoneFreeMinutes) / PRICING.phoneBlockMinutes)
    : 0;
  const internetOverageBlocks = internetMb > PRICING.internetIncludedMb
    ? Math.ceil((internetMb - PRICING.internetIncludedMb) / PRICING.internetBlockMb)
    : 0;

  const phoneCharge = phoneBlocks * PRICING.phoneBlockPrice;
  const internetBaseCharge = PRICING.internetBasePrice;
  const internetOverageCharge = internetOverageBlocks * PRICING.internetBlockPrice;
  const internetCharge = internetBaseCharge + internetOverageCharge;

  return {
    phoneMinutes, internetMb, phoneBlocks, phoneCharge,
    internetBaseCharge, internetOverageBlocks, internetOverageCharge, internetCharge,
    total: phoneCharge + internetCharge,
  };
}

/** Money is kept as USD with two decimals; compare/sum through integer cents. */
export const toCents = (value: number): number => Math.round(value * 100);
export const fromCents = (cents: number): number => cents / 100;
export const hasAtMostTwoDecimals = (value: number): boolean => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6;
