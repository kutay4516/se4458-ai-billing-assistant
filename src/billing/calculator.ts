export type UsageType = "Phone" | "Internet";

export interface UsageRecord {
  usageType: UsageType;
  amount: number;
}

export interface BillCalculation {
  phoneCharge: number;
  internetCharge: number;
  total: number;
}

export function calculateBill(usage: UsageRecord[]): BillCalculation {
  const phoneMinutes = usage
    .filter((record) => record.usageType === "Phone")
    .reduce((sum, record) => sum + record.amount, 0);
  const internetMb = usage
    .filter((record) => record.usageType === "Internet")
    .reduce((sum, record) => sum + record.amount, 0);

  const phoneCharge = phoneMinutes <= 1000
    ? 0
    : Math.ceil((phoneMinutes - 1000) / 1000) * 10;

  const internetCharge = internetMb <= 20000
    ? 0
    : Math.ceil((internetMb - 20000) / 10000) * 10;

  return {
    phoneCharge,
    internetCharge,
    total: phoneCharge + internetCharge,
  };
}

export function toCents(value: number): number {
  return Math.round(value * 100);
}
