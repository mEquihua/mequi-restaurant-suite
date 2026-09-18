import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { apiFetch } from './api.js';

type Promotion = {
  id: string;
  name: string;
  description: string | null;
  discount_type: 'PERCENTAGE' | 'AMOUNT';
  discount_value: number;
  category_id: string | null;
  product_id: string | null;
  is_active: boolean;
  starts_at: string | null;
  ends_at: string | null;
  days_of_week: number[] | null;
  start_time: string | null;
  end_time: string | null;
  version: number;
};

type Category = { id: string; name: string };
type Product = { id: string; name: string };

export function Promotions({ permissions }: { permissions: string[] }) {
  const qc = useQueryClient();
  const [error, setError] = useState<unknown>();
  
  const promotions = useQuery({
    queryKey: ['promotions'],
    queryFn: () => apiFetch<{ data: Promotion[] }>('/api/v1/promotions'),
  });

  const categories = useQuery({
    queryKey: ['categories'],
    queryFn: () => apiFetch<{ data: Category[] }>('/api/v1/categories'),
  });

  const products = useQuery({
    queryKey: ['products'],
    queryFn: () => apiFetch<{ data: Product[] }>('/api/v1/products'),
  });

  const createPromotion = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch('/api/v1/promotions', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['promotions'] }),
    onError: setError,
  });

  const updatePromotion = useMutation({
    mutationFn: (promo: Record<string, unknown> & { id: string; version: number }) => {
      const { id, version, ...body } = promo;
      return apiFetch(`/api/v1/promotions/${id}`, {
        method: 'PUT',
        ifMatch: version,
        body: JSON.stringify(body),
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['promotions'] }),
    onError: setError,
  });

  
  const [targetType, setTargetType] = useState<'GLOBAL' | 'CATEGORY' | 'PRODUCT'>('GLOBAL');

  return (
    <section>
      <h2>Promotions</h2>
      {error ? <p className="error">{String(error)}</p> : null}
      
      <div className="panel">
        <h3>Create Promotion</h3>
        {permissions.includes('promotions.promotions.write') && (
          <form
            className="compact"
            onSubmit={(e) => {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              const discountType = fd.get('discount_type') as 'PERCENTAGE' | 'AMOUNT';
              const isPercentage = discountType === 'PERCENTAGE';
              const rawDiscount = Number(fd.get('discount_value'));

              const starts_at = fd.get('starts_at') ? new Date(fd.get('starts_at') as string).toISOString() : null;
              const ends_at = fd.get('ends_at') ? new Date(fd.get('ends_at') as string).toISOString() : null;
              
              const days_of_week = Array.from(fd.getAll('days_of_week')).map(Number);
              const start_time = fd.get('start_time') || null;
              const end_time = fd.get('end_time') || null;

              const catId = targetType === 'CATEGORY' ? fd.get('category_id') : null;
              const prodId = targetType === 'PRODUCT' ? fd.get('product_id') : null;

              createPromotion.mutate({
                name: String(fd.get('name')),
                description: fd.get('description') || null,
                discount_type: discountType,
                discount_value: isPercentage ? rawDiscount : rawDiscount * 100,
                is_active: fd.get('is_active') === 'true',
                category_id: catId || null,
                product_id: prodId || null,
                starts_at,
                ends_at,
                days_of_week: days_of_week.length > 0 ? days_of_week : null,
                start_time,
                end_time,
              });
              e.currentTarget.reset();
              setTargetType('GLOBAL');
            }}
          >
            <input name="name" placeholder="Promotion Name" required />
            <input name="description" placeholder="Description" />
            
            <select name="discount_type" required>
              <option value="PERCENTAGE">Percentage (%)</option>
              <option value="AMOUNT">Amount ($)</option>
            </select>
            <input name="discount_value" type="number" step="0.01" placeholder="Discount Value" required min="0.01" />

            <select value={targetType} onChange={(e) => setTargetType(e.target.value as 'GLOBAL' | 'CATEGORY' | 'PRODUCT')}>
              <option value="GLOBAL">Global (All Products)</option>
              <option value="CATEGORY">Specific Category</option>
              <option value="PRODUCT">Specific Product</option>
            </select>

            {targetType === 'CATEGORY' && (
              <select name="category_id" required>
                <option value="">Select Category...</option>
                {categories.data?.data.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            )}

            {targetType === 'PRODUCT' && (
              <select name="product_id" required>
                <option value="">Select Product...</option>
                {products.data?.data.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            )}

            <div>
              <label>Starts At: <input type="datetime-local" name="starts_at" /></label>
              <label>Ends At: <input type="datetime-local" name="ends_at" /></label>
            </div>

            <div>
              <label>Time Window: 
                <input type="time" name="start_time" /> to <input type="time" name="end_time" />
              </label>
            </div>

            <fieldset>
              <legend>Days of Week</legend>
              {[1, 2, 3, 4, 5, 6, 7].map(d => (
                <label key={d}>
                  <input type="checkbox" name="days_of_week" value={d} /> {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][d - 1]}
                </label>
              ))}
            </fieldset>

            <label>
              <input type="radio" name="is_active" value="true" defaultChecked /> Active
            </label>
            <label>
              <input type="radio" name="is_active" value="false" /> Inactive
            </label>
            <button>Create</button>
          </form>
        )}
      </div>

      <div className="list">
        <h3>Existing Promotions</h3>
        {promotions.data?.data.map((p) => (
          <div key={p.id} className="item">
            <h4>{p.name} {p.is_active ? '(Active)' : '(Inactive)'}</h4>
            <p>{p.discount_type === 'PERCENTAGE' ? `${p.discount_value}%` : `$${(p.discount_value / 100).toFixed(2)}`} off</p>
            {permissions.includes('promotions.promotions.write') && (
              <button
                onClick={() => {
                  updatePromotion.mutate({
                    ...p,
                    is_active: !p.is_active,
                  });
                }}
              >
                Toggle Active
              </button>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
