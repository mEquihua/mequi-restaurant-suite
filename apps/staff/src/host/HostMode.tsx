import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { apiFetch } from '../api.js';

type Reservation = {
  id: string;
  party_size: number;
  reservation_time: string;
  status: string;
  customer_name: string;
  version: number;
};

type Table = {
  id: string;
  name: string;
  status: string;
};

export function HostMode({ locationId }: { locationId: string }) {
  const qc = useQueryClient();
  const [error, setError] = useState('');

  const reservations = useQuery({
    queryKey: ['reservations', locationId],
    queryFn: () => apiFetch<{ data: Reservation[] }>(`/api/v1/locations/${locationId}/reservations`),
  });

  const tables = useQuery({
    queryKey: ['tables', locationId],
    queryFn: () => apiFetch<{ data: Table[] }>(`/api/v1/locations/${locationId}/tables`),
  });

  const updateStatus = async (id: string, version: number, action: string, payload?: { table_id: string }) => {
    try {
      await apiFetch(`/api/v1/locations/${locationId}/reservations/${id}/${action}`, {
        method: 'POST',
        headers: { 'if-match': `"${version}"` },
        body: payload ? JSON.stringify(payload) : undefined,
      });
      void qc.invalidateQueries({ queryKey: ['reservations', locationId] });
      if (action === 'seat') {
        void qc.invalidateQueries({ queryKey: ['tables', locationId] });
      }
      setError('');
    } catch (err: unknown) {
      setError((err as Error).message);
    }
  };

  const activeReservations = reservations.data?.data.filter(r => ['REQUESTED', 'CONFIRMED', 'ARRIVED'].includes(r.status)) || [];

  return (
    <div style={{ padding: '2rem' }}>
      <h1>Host UI</h1>
      {error && <div style={{ color: 'red', marginBottom: '1rem' }}>{error}</div>}
      
      <h2>Reservations</h2>
      <table style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th>Time</th>
            <th>Name</th>
            <th>Party Size</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {activeReservations.map(r => (
            <tr key={r.id} style={{ borderBottom: '1px solid #ccc' }}>
              <td>{new Date(r.reservation_time).toLocaleTimeString()}</td>
              <td>{r.customer_name}</td>
              <td>{r.party_size}</td>
              <td>{r.status}</td>
              <td>
                {r.status === 'REQUESTED' && <button onClick={() => updateStatus(r.id, r.version, 'confirm')}>Confirm</button>}
                {r.status === 'CONFIRMED' && <button onClick={() => updateStatus(r.id, r.version, 'arrive')}>Arrive</button>}
                {r.status === 'ARRIVED' && (
                  <select onChange={(e) => {
                    if (e.target.value) {
                      updateStatus(r.id, r.version, 'seat', { table_id: e.target.value });
                    }
                  }} defaultValue="">
                    <option value="" disabled>Seat at table...</option>
                    {tables.data?.data.filter(t => t.status === 'AVAILABLE').map(t => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                  </select>
                )}
                {['REQUESTED', 'CONFIRMED'].includes(r.status) && (
                  <button onClick={() => updateStatus(r.id, r.version, 'cancel')}>Cancel</button>
                )}
                {['CONFIRMED', 'ARRIVED'].includes(r.status) && (
                  <button onClick={() => updateStatus(r.id, r.version, 'no-show')}>No-Show</button>
                )}
              </td>
            </tr>
          ))}
          {activeReservations.length === 0 && (
            <tr><td colSpan={5}>No active reservations.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
