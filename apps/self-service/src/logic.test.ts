import { describe, expect, it } from 'vitest';
import { bucketBoardOrders, canOfferOnlinePayment, requestBillIsPrimary } from './logic.js';

describe('payment mode UI rules', () => {
  it('only exposes online payment for ORDER_AND_PAY', () => {
    expect(canOfferOnlinePayment('ORDER_AND_PAY')).toBe(true);
    expect(canOfferOnlinePayment('ORDER_ONLY')).toBe(false);
    expect(canOfferOnlinePayment('REQUEST_BILL')).toBe(false);
  });
  it('makes bill request primary only when configured', () => {
    expect(requestBillIsPrimary('REQUEST_BILL')).toBe(true);
    expect(requestBillIsPrimary('ORDER_AND_PAY')).toBe(false);
  });
});

describe('status-board bucketing', () => {
  it('keeps only preparing and ready orders in their own columns', () => {
    const buckets = bucketBoardOrders([
      { status: 'PREPARING', id: '104' },
      { status: 'READY', id: '101' },
      { status: 'SENT', id: 'ignore' },
    ]);
    expect(buckets.preparing.map((item) => item.id)).toEqual(['104']);
    expect(buckets.ready.map((item) => item.id)).toEqual(['101']);
  });
});
