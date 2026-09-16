import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { apiFetch } from '../api.js';
import { useRealtime } from '../realtime.js';
import type { components } from '@restaurant-suite/contracts';

type Table = components['schemas']['Table'];
type Visit = components['schemas']['Visit'];
type Product = components['schemas']['Product'];
type Order = components['schemas']['Order'];
type Account = components['schemas']['Account'];

type VisitDetail = Visit & { orders?: Order[]; accounts?: Account[] };

export function WaiterMode({ locationId }: { locationId: string }) {
  const queryClient = useQueryClient();
  useRealtime(locationId);

  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [uiError, setUiError] = useState<string | null>(null);

  const { data: tablesData, isLoading: isLoadingTables } = useQuery({
    queryKey: ['tables', locationId],
    queryFn: () => apiFetch<{ data: Table[] }>(`/api/v1/locations/${locationId}/tables`),
  });

  const { data: visitsData, isLoading: isLoadingVisits } = useQuery({
    queryKey: ['visits', locationId],
    queryFn: () => apiFetch<{ data: Visit[] }>(`/api/v1/locations/${locationId}/visits?status=OPEN`),
  });

  const { data: productsData } = useQuery({
    queryKey: ['products', locationId],
    queryFn: () => apiFetch<{ data: Product[] }>(`/api/v1/products`),
  });

  const openVisit = useMutation({
    mutationFn: (tableId: string) => apiFetch<Visit>(`/api/v1/locations/${locationId}/visits`, {
      method: 'POST',
      body: JSON.stringify({ table_id: tableId, guest_count: 2 })
    }),
    onSuccess: (data, tableId) => {
      setUiError(null);
      queryClient.invalidateQueries({ queryKey: ['visits', locationId] });
      queryClient.invalidateQueries({ queryKey: ['tables', locationId] });
      setSelectedTable(tableId);
    },
    onError: (error: unknown) => {
      const err = error as { status?: number, message?: string };
      if (err.status === 409) {
        setUiError(`Table is not available.`);
        queryClient.invalidateQueries({ queryKey: ['tables', locationId] });
        queryClient.invalidateQueries({ queryKey: ['visits', locationId] });
      } else {
        setUiError(`Error opening table: ${err.message}`);
      }
    }
  });

  if (isLoadingTables || isLoadingVisits) return <div>Loading tables...</div>;

  const tables = tablesData?.data || [];
  const openVisits = visitsData?.data || [];

  if (selectedTable) {
    const openVisitForTable = openVisits.find(v => v.table_id === selectedTable);
    if (!openVisitForTable) {
      return <div>Error: Table lost or visit closed. <button onClick={() => setSelectedTable(null)}>Back</button></div>;
    }
    return <TableDetails 
      locationId={locationId} 
      visitId={openVisitForTable.id}
      products={productsData?.data || []}
      onBack={() => setSelectedTable(null)} 
      onClose={() => {
        setSelectedTable(null);
      }}
    />;
  }

  return (
    <div style={{ padding: '2rem' }}>
      <h1>Floor Plan</h1>
      {uiError && (
        <div style={{ background: '#fdd', padding: '1rem', marginBottom: '1rem', borderRadius: '4px' }}>
          {uiError}
        </div>
      )}
      <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
        {tables.map(t => {
          const hasOpenVisit = openVisits.some(v => v.table_id === t.id);
          const isActive = t.status === 'OCCUPIED' && hasOpenVisit;

          return (
            <div key={t.id} onClick={() => isActive && setSelectedTable(t.id)} style={{ border: '1px solid #ccc', padding: '1rem', borderRadius: '8px', minWidth: '150px', cursor: isActive ? 'pointer' : 'default', backgroundColor: isActive ? '#eef' : 'white' }}>
              <h3>{t.name}</h3>
              <div>Status: {t.status}</div>
              {!isActive && (
                <button onClick={() => {
                  setUiError(null);
                  openVisit.mutate(t.id);
                }}>Open Table</button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TableDetails({ locationId, visitId, products, onBack, onClose }: { locationId: string, visitId: string, products: Product[], onBack: () => void, onClose: () => void }) {
  const queryClient = useQueryClient();
  const [uiError, setUiError] = useState<string | null>(null);

  const { data: visitData, isLoading: visitLoading } = useQuery({
    queryKey: ['visit', locationId, visitId],
    queryFn: () => apiFetch<VisitDetail>(`/api/v1/locations/${locationId}/visits/${visitId}`),
  });

  const activeOrder = visitData?.orders?.[0];
  const activeAccount = visitData?.accounts?.[0];

  const { data: orderData } = useQuery({
    queryKey: ['order', locationId, activeOrder?.id],
    queryFn: () => apiFetch<Order & { order_lines?: components['schemas']['OrderLine'][] }>(`/api/v1/locations/${locationId}/orders/${activeOrder?.id}`),
    enabled: !!activeOrder?.id,
  });

  const [cart, setCart] = useState<{ product: Product; quantity: number }[]>([]);

  const addToCart = (product: Product) => {
    setCart(prev => [...prev, { product, quantity: 1 }]);
  };

  const handleSend = async () => {
    if (!visitData) return;
    try {
      setUiError(null);
      let currentVisitVersion = visitData.version;
      let orderId = activeOrder?.id;
      let orderVersion = activeOrder?.version;
      let accountId = activeAccount?.id;

      if (!orderId) {
        const order = await apiFetch<Order>(`/api/v1/locations/${locationId}/visits/${visitId}/orders`, {
          method: 'POST', headers: { 'If-Match': `"${currentVisitVersion}"` }, body: JSON.stringify({ order_type: 'DINE_IN' })
        });
        currentVisitVersion++;
        orderId = order.id;
        orderVersion = order.version;
        
        const accountRes = await apiFetch<{ account: Account }>(`/api/v1/locations/${locationId}/visits/${visitId}/accounts`, {
          method: 'POST', headers: { 'If-Match': `"${currentVisitVersion}"` }, body: JSON.stringify({})
        });
        currentVisitVersion++;
        accountId = accountRes.account.id;
      }

      const addLinesRes = await apiFetch<{ order: Order, lines: components['schemas']['OrderLine'][] }>(`/api/v1/locations/${locationId}/orders/${orderId}/lines`, {
        method: 'POST', headers: { 'If-Match': `"${orderVersion}"` },
        body: JSON.stringify({
          lines: cart.map(item => ({ product_id: item.product.id, quantity: item.quantity, account_id: accountId }))
        })
      });
      orderVersion = addLinesRes.order.version;

      await apiFetch<unknown>(`/api/v1/locations/${locationId}/orders/${orderId}/send`, {
        method: 'POST', headers: { 'If-Match': `"${orderVersion}"`, 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ line_ids: addLinesRes.lines.map((l) => l.id) })
      });

      setCart([]);
      queryClient.invalidateQueries({ queryKey: ['visit', locationId, visitId] });
      if (orderId) {
        queryClient.invalidateQueries({ queryKey: ['order', locationId, orderId] });
      }
    } catch (e: unknown) {
      const err = e as { status?: number, message?: string };
      if (err.status === 409) {
        setUiError(`Conflict: ${err.message}. The view will be refreshed.`);
        queryClient.invalidateQueries({ queryKey: ['visit', locationId, visitId] });
        if (activeOrder?.id) {
          queryClient.invalidateQueries({ queryKey: ['order', locationId, activeOrder.id] });
        }
      } else {
        setUiError(`Error sending: ${err.message}`);
      }
    }
  };

  const handlePayAndClose = async () => {
    if (!visitData) return;
    try {
      setUiError(null);
      if (activeAccount) {
        await apiFetch<unknown>(`/api/v1/locations/${locationId}/accounts/${activeAccount.id}/payments`, {
          method: 'POST', headers: { 'If-Match': `"${activeAccount.version}"`, 'Idempotency-Key': crypto.randomUUID() },
          body: JSON.stringify({ amount: 0, tender_type: 'CASH' })
        });
      }
      await apiFetch<unknown>(`/api/v1/locations/${locationId}/visits/${visitId}/close`, {
        method: 'POST', headers: { 'If-Match': `"${visitData.version}"` }, body: JSON.stringify({})
      });
      queryClient.invalidateQueries({ queryKey: ['tables', locationId] });
      queryClient.invalidateQueries({ queryKey: ['visits', locationId] });
      onClose();
    } catch (e: unknown) {
      const err = e as { status?: number, message?: string };
      if (err.status === 409) {
         setUiError(`Conflict: ${err.message}. The view will be refreshed.`);
         queryClient.invalidateQueries({ queryKey: ['visit', locationId, visitId] });
      } else {
         setUiError(`Error closing table: ${err.message}`);
      }
    }
  };

  if (visitLoading) return <div>Loading visit...</div>;

  return (
    <div style={{ padding: '2rem', display: 'flex' }}>
      <div style={{ flex: 1 }}>
        <button onClick={onBack}>&lt; Back</button>
        <h2>Table Menu</h2>
        {uiError && (
          <div style={{ background: '#fdd', padding: '1rem', marginBottom: '1rem', borderRadius: '4px' }}>
            {uiError}
          </div>
        )}
        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
          {products.map(p => (
            <div key={p.id} onClick={() => addToCart(p)} style={{ border: '1px solid #ccc', padding: '1rem', cursor: 'pointer' }}>
              {p.name}
            </div>
          ))}
        </div>
      </div>
      <div style={{ width: '300px', borderLeft: '1px solid #ccc', paddingLeft: '1rem' }}>
        <h2>Comanda</h2>
        {orderData?.order_lines && orderData.order_lines.length > 0 && (
           <div style={{ marginBottom: '1rem' }}>
             <strong>Sent Items:</strong>
             {orderData.order_lines.map((l, idx) => (
                <div key={idx}>- {products.find(p => p.id === l.product_id)?.name || 'Item'} x{l.quantity}</div>
             ))}
           </div>
        )}
        {cart.length > 0 && (
          <div>
            <strong>Unsent Items:</strong>
            {cart.map((item, idx) => (
              <div key={idx}>{item.product.name}</div>
            ))}
            <button onClick={handleSend} style={{ marginTop: '1rem' }}>Send to Kitchen</button>
          </div>
        )}
        <hr style={{ margin: '2rem 0' }} />
        <button onClick={handlePayAndClose}>Pay & Close Table</button>
      </div>
    </div>
  );
}
