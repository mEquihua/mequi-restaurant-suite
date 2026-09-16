export type PaymentMode = 'ORDER_ONLY' | 'REQUEST_BILL' | 'ORDER_AND_PAY';
export type BoardStatus = 'PREPARING' | 'READY';

export function canOfferOnlinePayment(mode: PaymentMode) { return mode === 'ORDER_AND_PAY'; }
export function requestBillIsPrimary(mode: PaymentMode) { return mode === 'REQUEST_BILL'; }

export function bucketBoardOrders<T extends { status: string }>(orders: T[]) {
  return orders.reduce<{ preparing: T[]; ready: T[] }>((buckets, order) => {
    if (order.status === 'PREPARING') buckets.preparing.push(order);
    if (order.status === 'READY') buckets.ready.push(order);
    return buckets;
  }, { preparing: [], ready: [] });
}
