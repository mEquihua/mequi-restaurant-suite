import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { apiFetch } from '../api.js';

export function TableDetails({ locationId, tableId, onBack }: { locationId: string; tableId: string; onBack: () => void }) {
  const queryClient = useQueryClient();
  
  // Actually, we need to know the visitId. 
  // Let's fetch the visits for the location and find the open one for this table.
  const { data: visits, isLoading } = useQuery({
    queryKey: ['visits', locationId],
    queryFn: () => apiFetch<{ data: any[] }>(`/api/v1/locations/${locationId}/visits`),
  });

  const visit = visits?.data.find((v: any) => v.table_id === tableId && v.status === 'OPEN');

  const createOrder = useMutation({
    mutationFn: () => apiFetch<{ id: string }>(`/api/v1/locations/${locationId}/visits/${visit!.id}/orders`, {
      method: 'POST',
      headers: { 'If-Match': `"${visit!.version}"` },
      body: JSON.stringify({ order_type: 'DINE_IN' })
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['visits', locationId] })
  });

  if (isLoading) return <div>Loading table details...</div>;

  return (
    <div style={{ padding: '2rem' }}>
      <button onClick={onBack}>&lt; Back</button>
      <h2>Table {tableId}</h2>
      {!visit ? (
        <div>No active visit.</div>
      ) : (
        <div>
          <h3>Visit {visit.id} (Guests: {visit.guest_count})</h3>
          <button onClick={() => createOrder.mutate()} disabled={createOrder.isPending}>
            Create Order
          </button>
          {/* We need to fetch orders for this visit */}
        </div>
      )}
    </div>
  );
}
