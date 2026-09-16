import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { apiFetch, ApiError } from '../api.js';
import type { components } from '@restaurant-suite/contracts';

type Product = components['schemas']['Product'];
type Visit = components['schemas']['Visit'];
type Order = components['schemas']['Order'];
type Account = components['schemas']['Account'];
type OrderLine = components['schemas']['OrderLine'];

export function POSMode({ locationId }: { locationId: string }) {
  const [cart, setCart] = useState<{ product: Product; quantity: number }[]>([]);
  const [checkoutState, setCheckoutState] = useState<'shopping' | 'checking_out' | 'success'>('shopping');
  const [error, setError] = useState<string | null>(null);

  const { data: products } = useQuery({
    queryKey: ['products', locationId],
    queryFn: () => apiFetch<{ data: Product[] }>(`/api/v1/products`),
  });

  const addToCart = (product: Product) => {
    setCart(prev => {
      const existing = prev.find(item => item.product.id === product.id);
      if (existing) {
        return prev.map(item => item.product.id === product.id ? { ...item, quantity: item.quantity + 1 } : item);
      }
      return [...prev, { product, quantity: 1 }];
    });
  };

  const handleCheckout = async () => {
    setCheckoutState('checking_out');
    setError(null);
    try {
      // 1. Open Visit
      const visit = await apiFetch<Visit>(`/api/v1/locations/${locationId}/visits`, {
        method: 'POST', body: JSON.stringify({ guest_count: 1 })
      });
      let visitVersion = visit.version;

      // 2. Create Order
      const order = await apiFetch<Order>(`/api/v1/locations/${locationId}/visits/${visit.id}/orders`, {
        method: 'POST', headers: { 'If-Match': `"${visitVersion}"` }, body: JSON.stringify({ order_type: 'TAKEOUT' })
      });
      visitVersion++;
      let orderVersion = order.version;

      // 3. Create Account
      const accountRes = await apiFetch<{ account: Account }>(`/api/v1/locations/${locationId}/visits/${visit.id}/accounts`, {
        method: 'POST', headers: { 'If-Match': `"${visitVersion}"` }, body: JSON.stringify({})
      });
      const account = accountRes.account; // The API returns { account, discount }
      visitVersion++;
      const accountVersion = account.version;

      // 4. Add lines
      const addLinesRes = await apiFetch<{ order: Order; lines: OrderLine[] }>(`/api/v1/locations/${locationId}/orders/${order.id}/lines`, {
        method: 'POST', headers: { 'If-Match': `"${orderVersion}"` },
        body: JSON.stringify({
          lines: cart.map(item => ({ product_id: item.product.id, quantity: item.quantity, account_id: account.id }))
        })
      });
      orderVersion = addLinesRes.order.version;

      // 5. Fire lines
      await apiFetch<Order>(`/api/v1/locations/${locationId}/orders/${order.id}/send`, {
        method: 'POST', headers: { 'If-Match': `"${orderVersion}"`, 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ line_ids: addLinesRes.lines.map((l) => l.id) })
      });

      // 6. Pay - re-fetch the account to get the server-computed total (adding lines
      // does not return it directly), never trust a client-computed cart total.
      const currentAccount = await apiFetch<Account>(`/api/v1/locations/${locationId}/accounts/${account.id}`);
      await apiFetch<unknown>(`/api/v1/locations/${locationId}/accounts/${account.id}/payments`, {
        method: 'POST', headers: { 'If-Match': `"${accountVersion}"`, 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ amount: currentAccount.total, tender_type: 'CASH' })
      });

      // 7. Close Visit
      await apiFetch<unknown>(`/api/v1/locations/${locationId}/visits/${visit.id}/close`, {
        method: 'POST', headers: { 'If-Match': `"${visitVersion}"` }, body: JSON.stringify({})
      });

      setCheckoutState('success');
      setCart([]);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Checkout failed.');
      setCheckoutState('shopping');
    }
  };

  if (checkoutState === 'success') {
    return (
      <div style={{ padding: '2rem' }}>
        <h2>Order Complete!</h2>
        <button onClick={() => setCheckoutState('shopping')}>New Order</button>
      </div>
    );
  }

  return (
    <div style={{ padding: '2rem', display: 'flex' }}>
      <div style={{ flex: 1 }}>
        <h1>POS Mode</h1>
        {error && <div style={{ color: 'red', marginBottom: '1rem' }}>{error}</div>}
        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
          {products?.data.map((p) => (
            <div key={p.id} onClick={() => addToCart(p)} style={{ border: '1px solid #ccc', padding: '1rem', cursor: 'pointer' }}>
              {p.name}
            </div>
          ))}
        </div>
      </div>
      <div style={{ width: '300px', borderLeft: '1px solid #ccc', paddingLeft: '1rem' }}>
        <h2>Cart</h2>
        {cart.map(item => (
          <div key={item.product.id}>{item.quantity}x {item.product.name}</div>
        ))}
        {cart.length > 0 && (
          <button onClick={handleCheckout} disabled={checkoutState === 'checking_out'} style={{ marginTop: '1rem' }}>
            {checkoutState === 'checking_out' ? 'Processing...' : 'Checkout'}
          </button>
        )}
      </div>
    </div>
  );
}
