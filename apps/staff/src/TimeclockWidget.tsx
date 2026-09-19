import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './api.js';
import type { components } from '@restaurant-suite/contracts';

type TimeclockShift = components['schemas']['TimeclockShift'];

export function TimeclockWidget({ locationId, permissions }: { locationId: string, permissions: string[] }) {
  const qc = useQueryClient();
  const canClock = permissions.includes('timeclock.shifts.clock');

  const { data: shiftsData, isLoading } = useQuery({
    queryKey: ['my-shifts'],
    queryFn: () => apiFetch<{ data: TimeclockShift[] }>('/api/v1/staff/me/shifts'),
    enabled: canClock,
  });

  if (!canClock) return null;
  if (isLoading) return <div style={{ padding: '0.5rem', border: '1px solid #ccc', borderRadius: '4px' }}>Loading shift...</div>;

  const openShift = shiftsData?.data.find(s => s.status === 'OPEN' && s.location_id === locationId);

  const toggleClock = async () => {
    try {
      if (openShift) {
        await apiFetch(`/api/v1/locations/${locationId}/shifts/${openShift.id}/clock-out`, {
          method: 'POST',
          headers: { 'If-Match': String(openShift.version) },
        });
      } else {
        await apiFetch(`/api/v1/locations/${locationId}/shifts/clock-in`, {
          method: 'POST',
        });
      }
      void qc.invalidateQueries({ queryKey: ['my-shifts'] });
    } catch (e) {
      console.error(e);
      alert('Failed to update shift status.');
    }
  };

  return (
    <div style={{ padding: '0.5rem', border: '1px solid #ccc', borderRadius: '4px', display: 'flex', alignItems: 'center', gap: '1rem', background: openShift ? '#eef' : '#fee' }}>
      <div>
        <strong>Shift Status:</strong> {openShift ? 'Clocked In' : 'Clocked Out'}
      </div>
      <button onClick={toggleClock}>
        {openShift ? 'Clock Out' : 'Clock In'}
      </button>
    </div>
  );
}
