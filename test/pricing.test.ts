import { describe, expect, it } from "vitest";
import { calculateCharges, hasAtMostTwoDecimals } from "../src/billing/pricing.js";

describe("pricing rules (assignment Calculate Bill)", () => {
  it("charges only the $50 internet package inside both allowances", () => {
    expect(calculateCharges(1000, 20_000)).toMatchObject({ phoneCharge: 0, internetBaseCharge: 50, internetOverageCharge: 0, internetCharge: 50, total: 50 });
  });

  it("charges the $50 package even with zero usage", () => {
    expect(calculateCharges(0, 0).total).toBe(50);
  });

  it("charges $10 per STARTED 1,000-minute block after 1,000 free minutes", () => {
    expect(calculateCharges(1001, 0).phoneCharge).toBe(10);
    expect(calculateCharges(2000, 0).phoneCharge).toBe(10);
    expect(calculateCharges(2001, 0).phoneCharge).toBe(20);
    expect(calculateCharges(3000, 0).phoneBlocks).toBe(2);
  });

  it("charges $10 per STARTED 10 GB block after 20 GB (1 GB = 1,000 MB)", () => {
    expect(calculateCharges(0, 20_001).internetOverageCharge).toBe(10);
    expect(calculateCharges(0, 30_000).internetOverageCharge).toBe(10);
    expect(calculateCharges(0, 30_001).internetOverageCharge).toBe(20);
    expect(calculateCharges(0, 35_000)).toMatchObject({ internetOverageBlocks: 2, internetCharge: 70 });
  });

  it("combines phone and internet into the total", () => {
    expect(calculateCharges(2300, 47_000)).toMatchObject({ phoneCharge: 20, internetCharge: 80, total: 100 });
  });

  it("rejects negative or non-finite usage", () => {
    expect(() => calculateCharges(-1, 0)).toThrow(RangeError);
    expect(() => calculateCharges(0, Number.NaN)).toThrow(RangeError);
  });

  it("validates money precision", () => {
    expect(hasAtMostTwoDecimals(10.25)).toBe(true);
    expect(hasAtMostTwoDecimals(0.1 + 0.2)).toBe(true);
    expect(hasAtMostTwoDecimals(10.255)).toBe(false);
  });
});
