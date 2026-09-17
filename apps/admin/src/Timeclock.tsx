import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { apiFetch } from './api.js';
import type { components } from '@restaurant-suite/contracts';

type TimeclockShift = components['schemas']['TimeclockShift'];

function ErrorNotice({ error }: { error: unknown }) {
  if (!error) return null;
  const msg = (error as { message?: string }).message || String(error);
  return <p className="error" role="alert">{msg}</p>;
}

export function Timeclock({ permissions, locationId }: { permissions: string[]; locationId: string }) {
  const qc = useQueryClient();
  const write = permissions.includes('timeclock.shifts.write');

  const { data: shifts, isLoading, error } = useQuery({
    queryKey: ['shifts', locationId],
    queryFn: () => apiFetch<{ data: TimeclockShift[] }>(`/api/v1/locations/${locationId}/shifts`),
  });

  const { data: staffList } = useQuery({
    queryKey: ['staff', locationId],
    queryFn: () => apiFetch<{ data: Array<{ id: string; first_name: string; last_name: string }> }>(`/api/v1/locations/${locationId}/staff`),
  });

  const staffMap = new Map(staffList?.data.map(s => [s.id, `${s.first_name} ${s.last_name}`]));

  const [creating, setCreating] = useState(false);
  const [newStaffId, setNewStaffId] = useState('');
  const [newStatus, setNewStatus] = useState<'OPEN' | 'CLOSED'>('OPEN');
  const [newClockIn, setNewClockIn] = useState('');
  const [newClockOut, setNewClockOut] = useState('');
  const [createError, setCreateError] = useState<unknown>();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editStatus, setEditStatus] = useState<'OPEN' | 'CLOSED'>('OPEN');
  const [editClockIn, setEditClockIn] = useState('');
  const [editClockOut, setEditClockOut] = useState('');
  const [editError, setEditError] = useState<unknown>();

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    try {
      await apiFetch(`/api/v1/locations/${locationId}/shifts`, {
        method: 'POST',
        body: JSON.stringify({
          staff_id: newStaffId,
          status: newStatus,
          clocked_in_at: new Date(newClockIn).toISOString(),
          clocked_out_at: newStatus === 'CLOSED' && newClockOut ? new Date(newClockOut).toISOString() : null,
        }),
      });
      void qc.invalidateQueries({ queryKey: ['shifts', locationId] });
      setCreating(false);
      setNewStaffId('');
      setNewClockIn('');
      setNewClockOut('');
      setCreateError(undefined);
    } catch (err) {
      setCreateError(err);
    }
  }

  async function handleEdit(e: FormEvent, shift: TimeclockShift) {
    e.preventDefault();
    try {
      await apiFetch(`/api/v1/locations/${locationId}/shifts/${shift.id}`, {
        method: 'PUT',
        headers: { 'If-Match': String(shift.version) },
        body: JSON.stringify({
          status: editStatus,
          clocked_in_at: new Date(editClockIn).toISOString(),
          clocked_out_at: editStatus === 'CLOSED' && editClockOut ? new Date(editClockOut).toISOString() : null,
        }),
      });
      void qc.invalidateQueries({ queryKey: ['shifts', locationId] });
      setEditingId(null);
      setEditError(undefined);
    } catch (err) {
      setEditError(err);
    }
  }

  if (isLoading) return <section>Loading...</section>;
  if (error) return <section><ErrorNotice error={error} /></section>;

  return (
    <section>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2>Employee Shifts</h2>
        {write && (
          <button onClick={() => setCreating(true)}>Add Shift</button>
        )}
      </header>

      {creating && (
        <form className="form-grid" onSubmit={handleCreate} style={{ marginBottom: '2rem', padding: '1rem', border: '1px solid #ccc' }}>
          <h3>Add Manual Shift</h3>
          <ErrorNotice error={createError} />
          
          <label>
            Staff Member
            <select required value={newStaffId} onChange={e => setNewStaffId(e.target.value)}>
              <option value="">Select...</option>
              {staffList?.data.map(s => (
                <option key={s.id} value={s.id}>{s.first_name} {s.last_name}</option>
              ))}
            </select>
          </label>
          <label>
            Status
            <select required value={newStatus} onChange={e => setNewStatus(e.target.value as 'OPEN' | 'CLOSED')}>
              <option value="OPEN">OPEN</option>
              <option value="CLOSED">CLOSED</option>
            </select>
          </label>
          <label>
            Clock In Time
            <input type="datetime-local" required value={newClockIn} onChange={e => setNewClockIn(e.target.value)} />
          </label>
          {newStatus === 'CLOSED' && (
            <label>
              Clock Out Time
              <input type="datetime-local" required value={newClockOut} onChange={e => setNewClockOut(e.target.value)} />
            </label>
          )}
          <div style={{ display: 'flex', gap: '1rem', gridColumn: '1 / -1' }}>
            <button type="submit">Save Shift</button>
            <button type="button" onClick={() => setCreating(false)}>Cancel</button>
          </div>
        </form>
      )}

      <table>
        <thead>
          <tr>
            <th>Staff Member</th>
            <th>Status</th>
            <th>Clocked In</th>
            <th>Clocked Out</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {shifts?.data.map(shift => {
            if (editingId === shift.id) {
              return (
                <tr key={shift.id}>
                  <td colSpan={5}>
                    <form className="compact" onSubmit={(e) => handleEdit(e, shift)} style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
                      <select required value={editStatus} onChange={e => setEditStatus(e.target.value as 'OPEN' | 'CLOSED')}>
                        <option value="OPEN">OPEN</option>
                        <option value="CLOSED">CLOSED</option>
                      </select>
                      <input type="datetime-local" required value={editClockIn} onChange={e => setEditClockIn(e.target.value)} />
                      {editStatus === 'CLOSED' && (
                        <input type="datetime-local" required value={editClockOut} onChange={e => setEditClockOut(e.target.value)} />
                      )}
                      <button type="submit">Save</button>
                      <button type="button" onClick={() => setEditingId(null)}>Cancel</button>
                      {!!editError && <span style={{ color: 'red' }}>Error saving</span>}
                    </form>
                  </td>
                </tr>
              );
            }

            return (
              <tr key={shift.id}>
                <td>{staffMap.get(shift.staff_id) ?? shift.staff_id}</td>
                <td>{shift.status}</td>
                <td>{new Date(shift.clocked_in_at).toLocaleString()}</td>
                <td>{shift.clocked_out_at ? new Date(shift.clocked_out_at).toLocaleString() : '-'}</td>
                <td>
                  {write && (
                    <button onClick={() => {
                      setEditingId(shift.id);
                      setEditStatus(shift.status);
                      setEditClockIn(shift.clocked_in_at.slice(0, 16));
                      setEditClockOut(shift.clocked_out_at ? shift.clocked_out_at.slice(0, 16) : '');
                      setEditError(undefined);
                    }}>
                      Edit
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
          {(!shifts?.data || shifts.data.length === 0) && (
            <tr><td colSpan={5}>No shifts found.</td></tr>
          )}
        </tbody>
      </table>
    </section>
  );
}
