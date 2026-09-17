import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { apiFetch } from '../api.js';

type LoyaltyAccount = { id: string; points_balance: number; total_visits: number };
type LoyaltyTransaction = { id: string; points_delta: number; reason: string; created_at: string };
type CustomerLoyaltyLookup = { account: LoyaltyAccount; transactions: LoyaltyTransaction[] };

export function LoyaltyLookup({ locationId }: { locationId: string }) {
  void locationId;
  const qc = useQueryClient();
  const [customerId, setCustomerId] = useState('');
  const [searchCustomerId, setSearchCustomerId] = useState('');
  const [adjustAmount, setAdjustAmount] = useState('');
  const [adjustReason, setAdjustReason] = useState('');

  const lookup = useQuery({
    queryKey: ['staff-loyalty-lookup', searchCustomerId],
    queryFn: () => apiFetch<CustomerLoyaltyLookup>(`/api/v1/customers/${searchCustomerId}/loyalty`),
    enabled: !!searchCustomerId,
  });

  const adjust = useMutation({
    mutationFn: () =>
      apiFetch(`/api/v1/customers/${searchCustomerId}/loyalty/adjust`, {
        method: 'POST',
        body: JSON.stringify({ points_delta: parseInt(adjustAmount, 10), reason: adjustReason }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['staff-loyalty-lookup', searchCustomerId] });
      setAdjustAmount('');
      setAdjustReason('');
    },
  });

  return (
    <div style={{ padding: '2rem', borderTop: '1px solid #ccc', marginTop: '2rem' }}>
      <h2>Loyalty Lookup & Adjustment</h2>
      <form onSubmit={e => { e.preventDefault(); setSearchCustomerId(customerId); }} style={{ display: 'flex', gap: '1rem', marginBottom: '1rem' }}>
        <input placeholder="Customer ID" value={customerId} onChange={e => setCustomerId(e.target.value)} required />
        <button type="submit">Lookup</button>
      </form>

      {lookup.data && (
        <div>
          <h3>Balance: {lookup.data.account.points_balance} pts</h3>

          <form onSubmit={e => { e.preventDefault(); adjust.mutate(); }} style={{ display: 'flex', gap: '1rem', marginTop: '1rem', marginBottom: '2rem' }}>
            <input type="number" placeholder="Points delta (e.g. 50 or -20)" value={adjustAmount} onChange={e => setAdjustAmount(e.target.value)} required />
            <input placeholder="Reason" value={adjustReason} onChange={e => setAdjustReason(e.target.value)} required />
            <button type="submit" disabled={adjust.isPending}>Adjust</button>
          </form>

          <h4>History</h4>
          <ul>
            {lookup.data.transactions.map((tx) => (
              <li key={tx.id}>
                {new Date(tx.created_at).toLocaleString()}: {tx.points_delta > 0 ? '+' : ''}{tx.points_delta} pts ({tx.reason})
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
