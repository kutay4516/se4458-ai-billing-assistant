import { describe, expect, it } from "vitest";
import { calculateBill } from "../src/billing/calculator.js";

describe("billing calculator", () => {
  it("charges no phone or internet fee within allowances", () => {
    expect(calculateBill([
      { usageType: "Phone", amount: 1000 },
      { usageType: "Internet", amount: 20000 },
    ])).toEqual({ phoneCharge: 0, internetCharge: 0, total: 0 });
  });

  it("charges each started 1000 phone-minute block", () => {
    expect(calculateBill([
      { usageType: "Phone", amount: 2001 },
    ])).toEqual({ phoneCharge: 20, internetCharge: 0, total: 20 });
  });

  it("charges each started 10 GB block after 20 GB", () => {
    expect(calculateBill([
      { usageType: "Internet", amount: 21001 },
    ])).toEqual({ phoneCharge: 0, internetCharge: 10, total: 10 });
  });
});
