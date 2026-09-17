import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { apiFetch } from './api.js';

type LoyaltySettings = {
  spend_amount_for_one_point: number;
  version: number;
};

type LoyaltyReward = {
  id: string;
  name: string;
  description: string | null;
  cost_in_points: number | null;
  cost_in_visits: number | null;
  discount_type: 'PERCENTAGE' | 'AMOUNT';
  discount_value: number;
  is_active: boolean;
  version: number;
};

type LoyaltyCoupon = {
  id: string;
  code: string;
  discount_type: 'PERCENTAGE' | 'AMOUNT';
  discount_value: number;
  is_active: boolean;
  version: number;
};

export function Loyalty({ permissions }: { permissions: string[] }) {
  const qc = useQueryClient();
  const [error, setError] = useState<unknown>();
  
  const settings = useQuery({
    queryKey: ['loyalty-settings'],
    queryFn: () => apiFetch<LoyaltySettings>('/api/v1/loyalty-settings'),
  });

  const rewards = useQuery({
    queryKey: ['loyalty-rewards'],
    queryFn: () => apiFetch<{ data: LoyaltyReward[] }>('/api/v1/loyalty-rewards'),
  });

  const coupons = useQuery({
    queryKey: ['loyalty-coupons'],
    queryFn: () => apiFetch<{ data: LoyaltyCoupon[] }>('/api/v1/loyalty-coupons'),
  });

  const updateSettings = useMutation({
    mutationFn: (body: { spend_amount_for_one_point: number }) =>
      apiFetch('/api/v1/loyalty-settings', { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['loyalty-settings'] }),
    onError: setError,
  });

  const createReward = useMutation({
    mutationFn: (body: { name: string; discount_type: 'PERCENTAGE' | 'AMOUNT'; discount_value: number; cost_in_points: number | null; cost_in_visits: number | null }) =>
      apiFetch('/api/v1/loyalty-rewards', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['loyalty-rewards'] }),
    onError: setError,
  });

  const toggleReward = useMutation({
    mutationFn: (reward: LoyaltyReward) =>
      apiFetch(`/api/v1/loyalty-rewards/${reward.id}`, {
        method: 'PUT',
        ifMatch: reward.version,
        body: JSON.stringify({ is_active: !reward.is_active }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['loyalty-rewards'] }),
    onError: setError,
  });

  const createCoupon = useMutation({
    mutationFn: (body: { code: string; discount_type: 'PERCENTAGE' | 'AMOUNT'; discount_value: number }) =>
      apiFetch('/api/v1/loyalty-coupons', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['loyalty-coupons'] }),
    onError: setError,
  });

  const toggleCoupon = useMutation({
    mutationFn: (coupon: LoyaltyCoupon) =>
      apiFetch(`/api/v1/loyalty-coupons/${coupon.id}`, {
        method: 'PUT',
        ifMatch: coupon.version,
        body: JSON.stringify({ is_active: !coupon.is_active }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['loyalty-coupons'] }),
    onError: setError,
  });

  return (
    <section>
      <h2>Loyalty Settings</h2>
      {error ? <p className="error">{String(error)}</p> : null}
      
      <div className="panel">
        <h3>Accrual Formula</h3>
        {permissions.includes('loyalty.settings.write') ? (
          <form
            className="compact"
            onSubmit={(e) => {
              e.preventDefault();
              const val = new FormData(e.currentTarget).get('spend_amount_for_one_point');
              updateSettings.mutate({ spend_amount_for_one_point: Number(val) * 100 });
            }}
          >
            <label>
              Spend ($) for 1 Point
              <input
                name="spend_amount_for_one_point"
                type="number"
                step="0.01"
                min="0.01"
                defaultValue={settings.data ? settings.data.spend_amount_for_one_point / 100 : ''}
                required
              />
            </label>
            <button>Save</button>
          </form>
        ) : (
          <p>
            Current formula: $
            {settings.data ? (settings.data.spend_amount_for_one_point / 100).toFixed(2) : '...'} = 1 point
          </p>
        )}
      </div>

      <div className="panel">
        <h3>Rewards</h3>
        {permissions.includes('loyalty.rewards.write') && (
          <form
            className="compact"
            onSubmit={(e) => {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              const costPoints = fd.get('cost_in_points');
              const costVisits = fd.get('cost_in_visits');
              createReward.mutate({
                name: String(fd.get('name')),
                discount_type: fd.get('discount_type') as 'PERCENTAGE' | 'AMOUNT',
                discount_value: fd.get('discount_type') === 'AMOUNT' ? Number(fd.get('discount_value')) * 100 : Number(fd.get('discount_value')),
                cost_in_points: costPoints ? Number(costPoints) : null,
                cost_in_visits: costVisits ? Number(costVisits) : null,
              });
              e.currentTarget.reset();
            }}
          >
            <input name="name" placeholder="Reward Name" required />
            <select name="discount_type" required>
              <option value="AMOUNT">Amount off ($)</option>
              <option value="PERCENTAGE">Percentage off (%)</option>
            </select>
            <input name="discount_value" type="number" step="0.01" min="0.01" placeholder="Discount value" required />
            <input name="cost_in_points" type="number" placeholder="Cost in Points" />
            <input name="cost_in_visits" type="number" placeholder="Cost in Visits" />
            <button>Add Reward</button>
          </form>
        )}
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Discount</th>
              <th>Cost</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rewards.data?.data.map((r) => (
              <tr key={r.id}>
                <td>{r.name}</td>
                <td>
                  {r.discount_type === 'PERCENTAGE' ? `${r.discount_value}%` : `$${(r.discount_value / 100).toFixed(2)}`}
                </td>
                <td>
                  {r.cost_in_points ? `${r.cost_in_points} pts` : ''}
                  {r.cost_in_visits ? `${r.cost_in_visits} visits` : ''}
                </td>
                <td>{r.is_active ? 'Active' : 'Inactive'}</td>
                <td>
                  {permissions.includes('loyalty.rewards.write') && (
                    <button onClick={() => toggleReward.mutate(r)}>
                      Toggle Status
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="panel">
        <h3>Coupons</h3>
        {permissions.includes('loyalty.rewards.write') && (
          <form
            className="compact"
            onSubmit={(e) => {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              const discountType = fd.get('discount_type') as 'PERCENTAGE' | 'AMOUNT';
              createCoupon.mutate({
                code: String(fd.get('code')),
                discount_type: discountType,
                discount_value: discountType === 'AMOUNT' ? Number(fd.get('discount_value')) * 100 : Number(fd.get('discount_value')),
              });
              e.currentTarget.reset();
            }}
          >
            <input name="code" placeholder="Coupon Code" required />
            <select name="discount_type" required>
              <option value="AMOUNT">Amount off ($)</option>
              <option value="PERCENTAGE">Percentage off (%)</option>
            </select>
            <input name="discount_value" type="number" step="0.01" min="0.01" placeholder="Discount value" required />
            <button>Add Coupon</button>
          </form>
        )}
        <table>
          <thead>
            <tr>
              <th>Code</th>
              <th>Discount</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {coupons.data?.data.map((c) => (
              <tr key={c.id}>
                <td>{c.code}</td>
                <td>
                  {c.discount_type === 'PERCENTAGE' ? `${c.discount_value}%` : `$${(c.discount_value / 100).toFixed(2)}`}
                </td>
                <td>{c.is_active ? 'Active' : 'Inactive'}</td>
                <td>
                  {permissions.includes('loyalty.rewards.write') && (
                    <button onClick={() => toggleCoupon.mutate(c)}>
                      Toggle Status
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
