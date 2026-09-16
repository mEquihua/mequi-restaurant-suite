import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { apiFetch } from '../api.js';

export function WaiterMode({ locationId }: { locationId: string }) {
  const queryClient = useQueryClient();
  const [activeTables, setActiveTables] = useState<Record<string, { visitId: string, visitVersion: number }>>({});
  const [selectedTable, setSelectedTable] = useState<string | null>(null);

  const { data: tables, isLoading } = useQuery({
    queryKey: ['tables', locationId],
    queryFn: () => apiFetch<{ data: any[] }>(`/api/v1/locations/${locationId}/tables`),
  });

  const { data: products } = useQuery({
    queryKey: ['products', locationId],
    queryFn: () => apiFetch<{ data: any[] }>(`/api/v1/products`),
  });

  const openVisit = useMutation({
    mutationFn: (tableId: string) => apiFetch<any>(`/api/v1/locations/${locationId}/visits`, {
      method: 'POST',
      body: JSON.stringify({ table_id: tableId, guest_count: 2 })
    }),
    onSuccess: (data, tableId) => {
      setActiveTables(prev => ({ ...prev, [tableId]: { visitId: data.id, visitVersion: data.version } }));
      setSelectedTable(tableId);
    }
  });

  if (isLoading) return <div>Loading tables...</div>;

  if (selectedTable) {
    const session = activeTables[selectedTable];
    if (!session) return <div>Error: Table lost. <button onClick={() => setSelectedTable(null)}>Back</button></div>;
    return <TableDetails 
      locationId={locationId} 
      tableId={selectedTable} 
      visitId={session.visitId} 
      initialVisitVersion={session.visitVersion} 
      products={products?.data || []}
      onBack={() => setSelectedTable(null)} 
      onClose={() => {
        setActiveTables(prev => {
          const next = { ...prev };
          delete next[selectedTable];
          return next;
        });
        setSelectedTable(null);
      }}
    />;
  }

  return (
    <div style={{ padding: '2rem' }}>
      <h1>Floor Plan</h1>
      <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
        {tables?.data.map((t: any) => {
          const isActive = !!activeTables[t.id];
          return (
            <div key={t.id} onClick={() => isActive && setSelectedTable(t.id)} style={{ border: '1px solid #ccc', padding: '1rem', borderRadius: '8px', minWidth: '150px', cursor: isActive ? 'pointer' : 'default', backgroundColor: isActive ? '#eef' : 'white' }}>
              <h3>{t.name}</h3>
              <div>Status: {isActive ? 'OCCUPIED (In-App)' : t.status}</div>
              {!isActive && (
                <button onClick={() => openVisit.mutate(t.id)}>Open Table</button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TableDetails({ locationId, tableId, visitId, initialVisitVersion, products, onBack, onClose }: { locationId: string, tableId: string, visitId: string, initialVisitVersion: number, products: any[], onBack: () => void, onClose: () => void }) {
  const [visitVersion, setVisitVersion] = useState(initialVisitVersion);
  const [orderState, setOrderState] = useState<{ orderId: string, orderVersion: number, accountId: string, accountVersion: number } | null>(null);
  const [cart, setCart] = useState<{ product: any; quantity: number }[]>([]);

  const addToCart = (product: any) => {
    setCart(prev => [...prev, { product, quantity: 1 }]);
  };

  const handleSend = async () => {
    try {
      let currentVisitVersion = visitVersion;
      let orderId = orderState?.orderId;
      let orderVersion = orderState?.orderVersion;
      let accountId = orderState?.accountId;
      let accountVersion = orderState?.accountVersion;

      if (!orderId) {
        const order = await apiFetch<any>(`/api/v1/locations/${locationId}/visits/${visitId}/orders`, {
          method: 'POST', headers: { 'If-Match': `"${currentVisitVersion}"` }, body: JSON.stringify({ order_type: 'DINE_IN' })
        });
        currentVisitVersion++;
        orderId = order.id;
        orderVersion = order.version;
        
        const accountRes = await apiFetch<any>(`/api/v1/locations/${locationId}/visits/${visitId}/accounts`, {
          method: 'POST', headers: { 'If-Match': `"${currentVisitVersion}"` }, body: JSON.stringify({})
        });
        currentVisitVersion++;
        accountId = accountRes.account.id;
        accountVersion = accountRes.account.version;
      }

      const addLinesRes = await apiFetch<any>(`/api/v1/locations/${locationId}/orders/${orderId}/lines`, {
        method: 'POST', headers: { 'If-Match': `"${orderVersion}"` },
        body: JSON.stringify({
          lines: cart.map(item => ({ product_id: item.product.id, quantity: item.quantity, account_id: accountId }))
        })
      });
      orderVersion = addLinesRes.order.version;

      await apiFetch<any>(`/api/v1/locations/${locationId}/orders/${orderId}/send`, {
        method: 'POST', headers: { 'If-Match': `"${orderVersion}"`, 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ line_ids: addLinesRes.lines.map((l:any) => l.id) })
      });

      setOrderState({ orderId: orderId!, orderVersion: orderVersion! + 1, accountId: accountId!, accountVersion: accountVersion! });
      setVisitVersion(currentVisitVersion);
      setCart([]);
      alert('Lines sent to kitchen!');
    } catch (e: any) {
      alert(`Error sending: ${e.message}`);
    }
  };

  const handlePayAndClose = async () => {
    try {
      if (orderState) {
        await apiFetch<any>(`/api/v1/locations/${locationId}/accounts/${orderState.accountId}/payments`, {
          method: 'POST', headers: { 'If-Match': `"${orderState.accountVersion}"`, 'Idempotency-Key': crypto.randomUUID() },
          body: JSON.stringify({ amount: 0, tender_type: 'CASH' })
        });
      }
      await apiFetch<any>(`/api/v1/locations/${locationId}/visits/${visitId}/close`, {
        method: 'POST', headers: { 'If-Match': `"${visitVersion}"` }, body: JSON.stringify({})
      });
      onClose();
    } catch (e: any) {
      alert(`Error closing table: ${e.message}`);
    }
  };

  return (
    <div style={{ padding: '2rem', display: 'flex' }}>
      <div style={{ flex: 1 }}>
        <button onClick={onBack}>&lt; Back</button>
        <h2>Table Menu</h2>
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
        {cart.map((item, idx) => (
          <div key={idx}>{item.product.name}</div>
        ))}
        {cart.length > 0 && (
          <button onClick={handleSend} style={{ marginTop: '1rem' }}>Send to Kitchen</button>
        )}
        <hr style={{ margin: '2rem 0' }} />
        <button onClick={handlePayAndClose}>Pay & Close Table</button>
      </div>
    </div>
  );
}
