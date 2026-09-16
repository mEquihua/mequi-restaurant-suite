export function computeExpectedAmount(
  openingFloat: number,
  cashPaymentsTotal: number,
  cashInsTotal: number,
  cashOutsTotal: number,
): number {
  return openingFloat + cashPaymentsTotal + cashInsTotal - cashOutsTotal;
}

export function computeVariance(countedAmount: number, expectedAmount: number): number {
  return countedAmount - expectedAmount;
}
