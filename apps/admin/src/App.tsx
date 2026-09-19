import { Timeclock } from './Timeclock.js';
/* eslint-disable react-refresh/only-export-components */
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { BrowserRouter, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { FormEvent, useEffect, useState } from 'react';
import {
  apiFetch,
  ApiError,
  clearSessionToken,
  getSessionToken,
  getTerminalCredential,
  setSessionToken,
  setTerminalCredential,
} from './api.js';
import { useRealtime } from './realtime.js';
import { Loyalty } from './Loyalty.js';
import { Promotions } from './Promotions.js';

type Me = {
  staff: { first_name: string; last_name: string };
  location_id: string;
  organization_id: string;
  permissions: string[];
};
type Category = { id: string; name: string; is_active: boolean };
type Table = { id: string; name: string; status: string };
type Terminal = {
  id: string;
  location_id: string;
  name: string;
  is_active: boolean;
  version: number;
  app_target: 'KITCHEN' | 'SELF_SERVICE' | 'STAFF' | null;
  profile_config: unknown | null;
};
type Product = {
  id: string;
  category_id: string | null;
  name: string;
  description: string | null;
  photo_url: string | null;
  notes: string | null;
  allergens: string[];
  tags: string[];
  is_active: boolean;
  version: number;
  price: number;
  variants: Array<{ id: string; name: string; price_adjustment: number }>;
  modifier_groups: Array<{
    id: string;
    name: string;
    modifiers: Array<{ id: string; name: string }>;
  }>;
  availability: { status: string; available: boolean };
};
type Staff = {
  id: string;
  first_name: string;
  last_name: string;
  active: boolean;
  version: number;
};
type Role = {
  id: string;
  name: string;
  description: string | null;
  is_system_template: boolean;
  permissions: Array<{ permission_name: string; scope: 'organization' | 'location' }>;
};
type Module = {
  key: string;
  display_name: string;
  description: string;
  module_key: string;
  status: string;
  attention_reason: string | null;
  version: number;
};
const client = new QueryClient();
const money = (n: number) =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(n / 100);
const csv = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
export const navForPermissions = (permissions: string[]) =>
  [
    ['Menu', '/menu', 'menu.catalog.read'],
    ['Inventory', '/inventory', 'inventory.stock.read'],
    ['Delivery Zones', '/delivery-zones', 'delivery.zones.read'],
    ['Reservations', '/reservations', 'reservations.settings.read'],
    ['Scheduled Orders', '/scheduled-orders', 'online_ordering.settings.read'],

    ['Loyalty', '/loyalty', 'loyalty.settings.read'],
    ['Promotions', '/promotions', 'promotions.promotions.read'],
    ['Employee Clocking', '/timeclock', 'timeclock.shifts.read'],
    ['Module Center', '/modules', 'module_center.modules.read'],
    ...(permissions.includes('iam.staff.read') || permissions.includes('iam.terminals.read')
      ? [['Staff & Roles', '/staff', 'iam.staff.read']]
      : []),
    ['Reports', '/reports', 'reports.sales.read'],
  ].filter((x): x is [string, string, string] => permissions.includes(x[2]));
export function reportRange(from: string, to: string) {
  const start = new Date(`${from}T00:00:00.000Z`),
    end = new Date(`${to}T23:59:59.999Z`);
  if (Number.isNaN(+start) || Number.isNaN(+end) || start >= end)
    throw new Error('Choose a valid date range.');
  return { from: start.toISOString(), to: end.toISOString() };
}
function ErrorNotice({ error }: { error: unknown }) {
  return error ? (
    <p className="error" role="alert">
      {error instanceof Error ? error.message : 'Request failed.'}
    </p>
  ) : null;
}
function Conflict({ error, refresh }: { error: unknown; refresh: () => void }) {
  return error instanceof ApiError && error.status === 409 ? (
    <p className="conflict">
      This record changed since you opened it. It was not overwritten.{' '}
      <button onClick={refresh}>Reload latest</button>
    </p>
  ) : null;
}

function Enrollment() {
  const [token, setToken] = useState(''),
    [locationId, setLocation] = useState(''),
    [name, setName] = useState('Admin desktop'),
    [error, setError] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      setSessionToken(token);
      const res = await apiFetch<{ terminal: { id: string }; terminal_credential: string }>(
        '/api/v1/terminals/enroll',
        {
          method: 'POST',
          body: JSON.stringify({ location_id: locationId, name }),
        },
      );
      setTerminalCredential(locationId, { terminal_id: res.terminal.id, secret: res.terminal_credential });
      window.location.reload();
    } catch (err) {
      clearSessionToken();
      setError(err instanceof Error ? err.message : 'Enrollment failed');
    }
  }
  return (
    <main className="auth">
      <h1>Enroll Admin terminal</h1>
      <p>Provision this browser once with an Owner or Manager session.</p>
      <ErrorNotice error={error} />
      <form onSubmit={submit}>
        <label>
          Admin session token
          <input required value={token} onChange={(e) => setToken(e.target.value)} />
        </label>
        <label>
          Location ID
          <input required value={locationId} onChange={(e) => setLocation(e.target.value)} />
        </label>
        <label>
          Terminal name
          <input required value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <button>Enroll</button>
      </form>
    </main>
  );
}
function Unlock() {
  const [staff, setStaff] = useState(''),
    [pin, setPin] = useState(''),
    [error, setError] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      // A pending location switch (see handleSwitchLocation) stores its target
      // here; without this, unlock would fall back to whichever location's
      // credential happens to occupy the single legacy slot, which is only
      // ever updated on a fresh enrollment — not on every switch to an
      // already-enrolled location — and would silently unlock the WRONG
      // location's session.
      const targetLocationId = sessionStorage.getItem('target_location_id') ?? undefined;
      const credential = getTerminalCredential(targetLocationId);
      if (!credential) throw new Error('Terminal enrollment is required.');
      const res = await apiFetch<{ token: string }>('/api/v1/auth/pin-unlock', {
        method: 'POST',
        headers: { 'x-terminal-credential': credential.secret },
        body: JSON.stringify({ staff_id: staff, pin }),
      });
      setSessionToken(res.token);
      sessionStorage.removeItem('target_location_id');
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unlock failed');
    }
  }
  return (
    <main className="auth">
      <h1>Unlock Admin</h1>
      <ErrorNotice error={error} />
      <form onSubmit={submit}>
        <label>
          Staff ID
          <input required value={staff} onChange={(e) => setStaff(e.target.value)} />
        </label>
        <label>
          PIN
          <input required type="password" value={pin} onChange={(e) => setPin(e.target.value)} />
        </label>
        <button>Unlock</button>
      </form>
    </main>
  );
}
function Shell() {
  const me = useQuery({ queryKey: ['me'], queryFn: () => apiFetch<Me>('/api/v1/auth/me') });
  if (me.isLoading) return <main className="auth">Loading…</main>;
  if (!me.data)
    return (
      <main className="auth">
        <ErrorNotice error={me.error} />
      </main>
    );
  return <Workspace me={me.data} />;
}
async function handleSwitchLocation(newLocationId: string, currentLoc: string) {
  if (newLocationId === currentLoc) return;
  let cred = getTerminalCredential(newLocationId);
  if (!cred) {
    try {
      const res = await apiFetch<{ terminal: { id: string }; terminal_credential: string }>(
        '/api/v1/terminals/enroll',
        {
          method: 'POST',
          body: JSON.stringify({ location_id: newLocationId, name: 'Virtual Admin Terminal' }),
        },
      );
      cred = { terminal_id: res.terminal.id, secret: res.terminal_credential };
      setTerminalCredential(newLocationId, cred);
    } catch (err) {
      alert('Failed to enroll virtual terminal: ' + (err instanceof Error ? err.message : String(err)));
      return;
    }
  }
  clearSessionToken();
  sessionStorage.setItem('target_location_id', newLocationId);
  window.location.reload();
}

function LocationSwitcher({ me, orgLocations, reportLocations, setReportLocations }: { me: Me; orgLocations: {id: string, name: string}[]; reportLocations: string[]; setReportLocations: React.Dispatch<React.SetStateAction<string[]>> }) {
  const { pathname } = useLocation();
  const isReports = pathname.startsWith('/reports');

  if (!isReports) {
    return (
      <div className="location-switcher" style={{ marginTop: '1rem', padding: '0.5rem', background: 'rgba(0,0,0,0.1)', borderRadius: '4px' }}>
        <label>
          <strong>Active Location</strong>
          <select value={me.location_id} onChange={(e) => handleSwitchLocation(e.target.value, me.location_id)} style={{ width: '100%', marginTop: '0.5rem' }}>
            {orgLocations.map(loc => <option key={loc.id} value={loc.id}>{loc.name}</option>)}
          </select>
        </label>
      </div>
    );
  }

  return (
    <div className="location-switcher reports-mode" style={{ marginTop: '1rem', padding: '0.5rem', background: 'rgba(0,0,0,0.1)', borderRadius: '4px' }}>
      <strong>Report Locations</strong>
      <label style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
        <input type="checkbox" checked={reportLocations[0] === 'all'} onChange={() => setReportLocations(['all'])} />
        All locations
      </label>
      {orgLocations.map(loc => (
        <label key={loc.id} style={{ display: 'flex', gap: '0.5rem', marginTop: '0.25rem' }}>
          <input type="checkbox" checked={reportLocations[0] !== 'all' && reportLocations.includes(loc.id)} onChange={(e) => {
            if (e.target.checked) {
              setReportLocations(prev => prev[0] === 'all' ? [loc.id] : [...prev, loc.id]);
            } else {
              setReportLocations(prev => {
                const next = prev.filter(id => id !== loc.id);
                return next.length === 0 ? ['all'] : next;
              });
            }
          }} />
          {loc.name}
        </label>
      ))}
    </div>
  );
}

function Workspace({ me }: { me: Me }) {
  useRealtime(me.location_id);
  const nav = navForPermissions(me.permissions);
  const [reportLocations, setReportLocations] = useState<string[]>(['all']);

  const orgLocationsQuery = useQuery({
    queryKey: ['org-locations', me.organization_id],
    queryFn: () => apiFetch<{ data: Array<{ id: string; name: string }> }>(`/api/v1/organizations/${me.organization_id}/locations`),
  });
  const orgLocations = orgLocationsQuery.data?.data ?? [];

  return (
    <div className="shell">
      <aside>
        <h1>
          Restaurant
          <br />
          Admin
        </h1>
        <p>
          {me.staff.first_name} {me.staff.last_name}
        </p>
        <LocationSwitcher me={me} orgLocations={orgLocations} reportLocations={reportLocations} setReportLocations={setReportLocations} />
        <nav style={{ marginTop: '1rem' }}>
          {nav.map(([label, path]) => (
            <NavLink key={path} to={path}>
              {label}
            </NavLink>
          ))}
        </nav>
        <button
          className="quiet"
          onClick={() => {
            clearSessionToken();
            window.location.reload();
          }}
        >
          Lock session
        </button>
      </aside>
      <main className="content">
        <Routes>
          <Route path="/menu" element={<Menu permissions={me.permissions} locationId={me.location_id} />} />
          <Route path="/inventory" element={<Inventory permissions={me.permissions} locationId={me.location_id} />} />
          <Route path="/modules" element={<Modules permissions={me.permissions} locationId={me.location_id} />} />
          <Route path="/delivery-zones" element={<DeliveryZones permissions={me.permissions} locationId={me.location_id} />} />
          <Route path="/reservations" element={<Reservations permissions={me.permissions} locationId={me.location_id} />} />
          <Route path="/scheduled-orders" element={<ScheduledOrders permissions={me.permissions} locationId={me.location_id} />} />

          <Route path="/loyalty" element={<Loyalty permissions={me.permissions} />} />
          <Route path="/promotions" element={<Promotions permissions={me.permissions} />} />
          <Route path="/timeclock" element={<Timeclock permissions={me.permissions} locationId={me.location_id} />} />
          <Route path="/staff" element={<People permissions={me.permissions} locationId={me.location_id} />} />
          <Route path="/reports" element={<Reports permissions={me.permissions} organizationId={me.organization_id} reportLocations={reportLocations} />} />
          <Route path="/no-access" element={<section><h2>No Admin access</h2></section>} />
          <Route path="*" element={<Navigate to={nav[0]?.[1] ?? '/no-access'} replace />} />
        </Routes>
      </main>
    </div>
  );
}

function Menu({ permissions, locationId }: { permissions: string[]; locationId: string }) {
  const qc = useQueryClient();
  const products = useQuery({
    queryKey: ['products', locationId],
    queryFn: () => apiFetch<{ data: Product[] }>('/api/v1/products'),
  });
  const categories = useQuery({
    queryKey: ['categories'],
    queryFn: () => apiFetch<{ data: Category[] }>('/api/v1/categories'),
  });
  const [selected, setSelected] = useState<Product | null>(null),
    [error, setError] = useState<unknown>();
  const writable = permissions.includes('menu.products.write');
  const refresh = () => void qc.invalidateQueries({ queryKey: ['products', locationId] });
  const create = useMutation({
    mutationFn: (body: unknown) =>
      apiFetch('/api/v1/products', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: refresh,
    onError: setError,
  });
  return (
    <section>
      <h2>Menu</h2>
      <p>Catalog, price and availability for this location.</p>
      <ErrorNotice error={error} />
      <div className="split">
        <div className="panel">
          <h3>Products</h3>
          {writable && (
            <ProductCreate
              categories={categories.data?.data ?? []}
              onSubmit={(body) => create.mutate(body)}
            />
          )}
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Category</th>
                <th>Price</th>
                <th>Availability</th>
              </tr>
            </thead>
            <tbody>
              {products.data?.data.map((p) => (
                <tr key={p.id} onClick={() => setSelected(p)}>
                  <td>
                    {p.name}
                    {!p.is_active && ' (inactive)'}
                  </td>
                  <td>{categories.data?.data.find((c) => c.id === p.category_id)?.name ?? '—'}</td>
                  <td>{money(p.price)}</td>
                  <td>{p.availability.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="panel">
          <h3>Categories</h3>
          {writable && (
            <CategoryCreate
              onSubmit={(body) =>
                apiFetch('/api/v1/categories', { method: 'POST', body: JSON.stringify(body) }).then(
                  () => qc.invalidateQueries({ queryKey: ['categories'] }),
                )
              }
            />
          )}
          <ul>
            {categories.data?.data.map((c) => (
              <li key={c.id}>{c.name}</li>
            ))}
          </ul>
        </div>
      </div>
      {selected && (
        <ProductEditor
          product={selected}
          categories={categories.data?.data ?? []}
          locationId={locationId}
          permissions={permissions}
          refresh={refresh}
        />
      )}
      <Conflict error={error} refresh={refresh} />
    </section>
  );
}
function ProductCreate({
  categories,
  onSubmit,
}: {
  categories: Category[];
  onSubmit: (body: unknown) => void;
}) {
  const [name, setName] = useState(''),
    [price, setPrice] = useState(''),
    [category, setCategory] = useState('');
  return (
    <form
      className="compact"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ name, base_price: Math.round(+price * 100), category_id: category || null });
        setName('');
        setPrice('');
      }}
    >
      <input
        required
        placeholder="Product name"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <input
        required
        placeholder="Price"
        type="number"
        min="0"
        step=".01"
        value={price}
        onChange={(e) => setPrice(e.target.value)}
      />
      <select value={category} onChange={(e) => setCategory(e.target.value)}>
        <option value="">No category</option>
        {categories.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <button>Add</button>
    </form>
  );
}
function CategoryCreate({ onSubmit }: { onSubmit: (body: unknown) => void }) {
  const [name, setName] = useState('');
  return (
    <form
      className="compact"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ name });
        setName('');
      }}
    >
      <input
        required
        placeholder="Category name"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <button>Add</button>
    </form>
  );
}
function ProductEditor({
  product,
  categories,
  locationId,
  permissions,
  refresh,
}: {
  product: Product;
  categories: Category[];
  locationId: string;
  permissions: string[];
  refresh: () => void;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    ...product,
    base_price: product.price / 100,
    allergens: product.allergens.join(', '),
    tags: product.tags.join(', '),
  });
  const [error, setError] = useState<unknown>();
  useEffect(
    () =>
      setForm({
        ...product,
        base_price: product.price / 100,
        allergens: product.allergens.join(', '),
        tags: product.tags.join(', '),
      }),
    [product],
  );
  const write = permissions.includes('menu.products.write');
  async function save(e: FormEvent) {
    e.preventDefault();
    try {
      await apiFetch(`/api/v1/products/${product.id}`, {
        method: 'PUT',
        ifMatch: product.version,
        body: JSON.stringify({
          name: form.name,
          category_id: form.category_id,
          description: form.description,
          photo_url: form.photo_url,
          notes: form.notes,
          allergens: csv(form.allergens),
          tags: csv(form.tags),
          base_price: Math.round(form.base_price * 100),
          is_active: form.is_active,
        }),
      });
      refresh();
    } catch (err) {
      setError(err);
    }
  }
  const post = async (path: string, body: unknown, ifMatch?: number) => {
    try {
      await apiFetch(path, { method: 'POST', ifMatch, body: JSON.stringify(body) });
      void qc.invalidateQueries({ queryKey: ['products', locationId] });
    } catch (err) {
      setError(err);
    }
  };
  return (
    <section className="panel detail">
      <h3>Edit {product.name}</h3>
      <ErrorNotice error={error} />
      <form className="form-grid" onSubmit={save}>
        <label>
          Name
          <input
            disabled={!write}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </label>
        <label>
          Category
          <select
            disabled={!write}
            value={form.category_id ?? ''}
            onChange={(e) => setForm({ ...form, category_id: e.target.value || null })}
          >
            <option value="">No category</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Base price
          <input
            disabled={!write}
            type="number"
            step=".01"
            value={form.base_price}
            onChange={(e) => setForm({ ...form, base_price: +e.target.value })}
          />
        </label>
        <label>
          Allergens
          <input
            disabled={!write}
            value={form.allergens}
            onChange={(e) => setForm({ ...form, allergens: e.target.value })}
          />
        </label>
        <label>
          Tags
          <input
            disabled={!write}
            value={form.tags}
            onChange={(e) => setForm({ ...form, tags: e.target.value })}
          />
        </label>
        <label>
          Photo URL
          <input
            disabled={!write}
            value={form.photo_url ?? ''}
            onChange={(e) => setForm({ ...form, photo_url: e.target.value })}
          />
        </label>
        <label className="wide">
          Description
          <textarea
            disabled={!write}
            value={form.description ?? ''}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
        </label>
        <label className="wide">
          Notes
          <textarea
            disabled={!write}
            value={form.notes ?? ''}
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
          />
        </label>
        {write && <button>Save product</button>}
      </form>
      <div className="subsection">
        <h4>Variants</h4>
        <ul>
          {product.variants.map((v) => (
            <li key={v.id}>
              {v.name} ({money(v.price_adjustment)})
            </li>
          ))}
        </ul>
        {write && (
          <QuickAdd
            label="Variant name"
            onSubmit={(name) => post(`/api/v1/products/${product.id}/variants`, { name })}
          />
        )}
      </div>
      <div className="subsection">
        <h4>Availability</h4>
        <p>Resolved now: {product.availability.status}</p>
        {permissions.includes('menu.availability.update') && (
          <Availability product={product} locationId={locationId} save={post} />
        )}
      </div>
      <div className="subsection">
        <h4>Location price override</h4>
        {permissions.includes('menu.prices.update') && (
          <QuickAdd
            label="Override price"
            onSubmit={(price) =>
              post(
                `/api/v1/locations/${locationId}/price-overrides/${product.id}`,
                { override_price: Math.round(+price * 100) },
                0,
              )
            }
          />
        )}
      </div>
      <Conflict error={error} refresh={refresh} />
    </section>
  );
}
function QuickAdd({ label, onSubmit }: { label: string; onSubmit: (value: string) => void }) {
  const [value, setValue] = useState('');
  return (
    <form
      className="compact"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(value);
        setValue('');
      }}
    >
      <input
        required
        placeholder={label}
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <button>Add</button>
    </form>
  );
}
function Availability({
  product,
  locationId,
  save,
}: {
  product: Product;
  locationId: string;
  save: (path: string, body: unknown, match?: number) => Promise<void>;
}) {
  const [status, setStatus] = useState('EXHAUSTED'),
    [channel, setChannel] = useState(''),
    [service, setService] = useState('');
  return (
    <form
      className="compact"
      onSubmit={(e) => {
        e.preventDefault();
        void save(
          `/api/v1/locations/${locationId}/products/${product.id}/${status === 'AVAILABLE' ? 'mark-available' : 'mark-unavailable'}`,
          {
            ...(status === 'AVAILABLE' ? {} : { status }),
            channel_scope: channel || null,
            service_type_scope: service || null,
          },
          0,
        );
      }}
    >
      <select value={status} onChange={(e) => setStatus(e.target.value)}>
        <option>EXHAUSTED</option>
        <option>HIDDEN</option>
        <option>SCHEDULED</option>
        <option>AVAILABLE</option>
      </select>
      <input
        placeholder="Channel scope"
        value={channel}
        onChange={(e) => setChannel(e.target.value)}
      />
      <input
        placeholder="Service type"
        value={service}
        onChange={(e) => setService(e.target.value)}
      />
      <button>Save rule</button>
    </form>
  );
}

type DeliveryZone = {
  id: string;
  location_id: string;
  organization_id: string;
  name: string;
  fee: number;
  minimum_order_amount: number;
  active: boolean;
  version: number;
};

function DeliveryZones({ permissions, locationId }: { permissions: string[]; locationId: string }) {
  const qc = useQueryClient();
  const zones = useQuery({
    queryKey: ['delivery-zones', locationId],
    queryFn: () =>
      apiFetch<{ data: DeliveryZone[] }>(`/api/v1/locations/${locationId}/delivery-zones/admin`),
  });
  const write = permissions.includes('delivery.zones.write');
  const [error, setError] = useState<unknown>();

  const [name, setName] = useState('');
  const [fee, setFee] = useState('');
  const [minimum, setMinimum] = useState('');

  async function create(e: FormEvent) {
    e.preventDefault();
    try {
      await apiFetch(`/api/v1/locations/${locationId}/delivery-zones`, {
        method: 'POST',
        body: JSON.stringify({
          name,
          fee: Math.round(+fee * 100),
          minimum_order_amount: Math.round(+minimum * 100),
        }),
      });
      setName('');
      setFee('');
      setMinimum('');
      void qc.invalidateQueries({ queryKey: ['delivery-zones', locationId] });
      setError(undefined);
    } catch (err) {
      setError(err);
    }
  }

  return (
    <section>
      <h2>Delivery Zones</h2>
      <Conflict
        error={error}
        refresh={() => void qc.invalidateQueries({ queryKey: ['delivery-zones', locationId] })}
      />
      {!(error instanceof ApiError && error.code === 'OPTIMISTIC_CONCURRENCY_CONFLICT') && (
        <ErrorNotice error={error} />
      )}
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Fee</th>
            <th>Minimum</th>
            <th>Active</th>
          </tr>
        </thead>
        <tbody>
          {zones.data?.data.map((zone) => (
            <DeliveryZoneRow
              key={zone.id}
              zone={zone}
              write={write}
              setError={setError}
              locationId={locationId}
            />
          ))}
        </tbody>
      </table>
      {write && (
        <article className="panel" style={{ marginTop: '2rem' }}>
          <h3>New Delivery Zone</h3>
          <form className="compact" onSubmit={create}>
            <input
              required
              placeholder="Zone Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <input
              required
              placeholder="Fee ($)"
              type="number"
              step=".01"
              value={fee}
              onChange={(e) => setFee(e.target.value)}
            />
            <input
              required
              placeholder="Minimum ($)"
              type="number"
              step=".01"
              value={minimum}
              onChange={(e) => setMinimum(e.target.value)}
            />
            <button>Create</button>
          </form>
        </article>
      )}
    </section>
  );
}

function DeliveryZoneRow({
  zone,
  write,
  setError,
  locationId,
}: {
  zone: DeliveryZone;
  write: boolean;
  setError: (e: unknown) => void;
  locationId: string;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(zone.name);
  const [fee, setFee] = useState((zone.fee / 100).toFixed(2));
  const [minimum, setMinimum] = useState((zone.minimum_order_amount / 100).toFixed(2));

  async function update(payload: Record<string, unknown>) {
    try {
      await apiFetch(`/api/v1/locations/${locationId}/delivery-zones/${zone.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ version: zone.version, ...payload }),
      });
      void qc.invalidateQueries({ queryKey: ['delivery-zones', locationId] });
      setError(undefined);
    } catch (err) {
      setError(err);
    }
  }

  return (
    <tr>
      <td>
        <input
          disabled={!write}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name !== zone.name && update({ name })}
        />
      </td>
      <td>
        $
        <input
          disabled={!write}
          type="number"
          step=".01"
          value={fee}
          onChange={(e) => setFee(e.target.value)}
          onBlur={() =>
            Math.round(+fee * 100) !== zone.fee && update({ fee: Math.round(+fee * 100) })
          }
          style={{ width: '80px' }}
        />
      </td>
      <td>
        $
        <input
          disabled={!write}
          type="number"
          step=".01"
          value={minimum}
          onChange={(e) => setMinimum(e.target.value)}
          onBlur={() =>
            Math.round(+minimum * 100) !== zone.minimum_order_amount &&
            update({ minimum_order_amount: Math.round(+minimum * 100) })
          }
          style={{ width: '80px' }}
        />
      </td>
      <td>
        <label>
          <input
            disabled={!write}
            type="checkbox"
            checked={zone.active}
            onChange={(e) => update({ active: e.target.checked })}
          />{' '}
          Active
        </label>
      </td>
    </tr>
  );
}

function Modules({ permissions, locationId }: { permissions: string[]; locationId: string }) {
  const qc = useQueryClient();
  const modules = useQuery({
    queryKey: ['modules', locationId],
    queryFn: () => apiFetch<{ data: Module[] }>(`/api/v1/locations/${locationId}/modules`),
  });
  const [error, setError] = useState<unknown>();
  const write = permissions.includes('module_center.modules.write');
  async function command(module: Module, action: string, reason?: string) {
    try {
      await apiFetch(`/api/v1/locations/${locationId}/modules/${module.module_key}/${action}`, {
        method: 'POST',
        ...(module.version ? { ifMatch: module.version } : {}),
        body: JSON.stringify(reason ? { reason } : {}),
      });
      void qc.invalidateQueries({ queryKey: ['modules', locationId] });
    } catch (err) {
      setError(err);
    }
  }
  return (
    <section>
      <h2>Module Center</h2>
      <p>Activate capabilities per location without deleting their historical data.</p>
      <ErrorNotice error={error} />
      <table>
        <thead>
          <tr>
            <th>Module</th>
            <th>Status</th>
            <th>Attention</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {modules.data?.data.map((module) => (
            <tr key={module.key}>
              <td>
                <strong>{module.display_name}</strong>
                <br />
                <small>{module.description}</small>
              </td>
              <td>{module.status}</td>
              <td>{module.attention_reason ?? '—'}</td>
              <td>
                {write && (
                  <>
                    <button onClick={() => void command(module, 'activate')}>Activate</button>{' '}
                    <button onClick={() => void command(module, 'pause')}>Pause</button>{' '}
                    <button onClick={() => void command(module, 'deactivate')}>Deactivate</button>{' '}
                    <button
                      onClick={() => {
                        const reason = window.prompt('Attention reason');
                        if (reason) void command(module, 'flag-attention', reason);
                      }}
                    >
                      Flag attention
                    </button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Conflict
        error={error}
        refresh={() => void qc.invalidateQueries({ queryKey: ['modules', locationId] })}
      />
    </section>
  );
}

const permissions = [
  'iam.terminals.enroll',
  'iam.terminals.read',
  'iam.staff.read',
  'iam.staff.create',
  'iam.staff.update',
  'iam.roles.read',
  'iam.roles.update',
  'menu.catalog.read',
  'menu.products.write',
  'menu.prices.update',
  'menu.availability.update',
  'floor.layout.read',
  'floor.layout.write',
  'floor.tables.update_status',
  'floor.sections.assign',
  'module_center.modules.read',
  'module_center.modules.write',
  'orders.visits.create',
  'orders.visits.close',
  'orders.visits.read_all',
  'orders.visits.transfer',
  'orders.orders.create',
  'orders.lines.add',
  'orders.lines.hold',
  'orders.lines.send',
  'orders.lines.void',
  'orders.lines.void_override',
  'orders.orders.cancel',
  'orders.orders.cancel_override',
  'accounts.accounts.create',
  'accounts.accounts.split',
  'accounts.accounts.reopen',
  'accounts.discounts.apply',
  'accounts.discounts.apply_override',
  'payments.payments.create',
  'payments.refunds.create',
  'payments.refunds.override',
  'payments.cash.open_drawer',
  'payments.cash.reconcile',
  'kitchen.tickets.read',
  'kitchen.tickets.update_status',
  'reports.sales.read',
  'reports.audit.read',
];
function People({
  permissions: grants,
  locationId,
}: {
  permissions: string[];
  locationId: string;
}) {
  const qc = useQueryClient();
  const staff = useQuery({
    queryKey: ['staff'],
    queryFn: () => apiFetch<{ data: Staff[] }>('/api/v1/staff'),
  });
  const roles = useQuery({
    queryKey: ['roles'],
    queryFn: () => apiFetch<{ data: Role[] }>('/api/v1/roles'),
  });
  const terminals = useQuery({
    queryKey: ['terminals'],
    queryFn: () => apiFetch<{ data: Terminal[] }>('/api/v1/terminals'),
  });
  const categories = useQuery({
    queryKey: ['categories'],
    queryFn: () => apiFetch<{ data: Category[] }>('/api/v1/categories'),
  });
  const tables = useQuery({
    queryKey: ['tables', locationId],
    queryFn: () => apiFetch<{ data: Table[] }>(`/api/v1/locations/${locationId}/tables`),
  });
  const [error, setError] = useState<unknown>();
  const canCreate = grants.includes('iam.staff.create'),
    canUpdate = grants.includes('iam.staff.update'),
    canRoles = grants.includes('iam.roles.update'),
    canEnrollTerminal = grants.includes('iam.terminals.enroll');
  async function createStaff(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    try {
      await apiFetch('/api/v1/staff', {
        method: 'POST',
        body: JSON.stringify({
          first_name: data.get('first_name'),
          last_name: data.get('last_name'),
          pin: data.get('pin'),
          role_ids: data.getAll('role_ids'),
        }),
      });
      e.currentTarget.reset();
      void qc.invalidateQueries({ queryKey: ['staff'] });
    } catch (err) {
      setError(err);
    }
  }
  async function toggle(person: Staff) {
    try {
      await apiFetch(`/api/v1/staff/${person.id}`, {
        method: 'PUT',
        ifMatch: person.version,
        body: JSON.stringify({ active: !person.active }),
      });
      void qc.invalidateQueries({ queryKey: ['staff'] });
    } catch (err) {
      setError(err);
    }
  }
  return (
    <section>
      <h2>Staff & Roles</h2>
      <ErrorNotice error={error} />
      <div className="split">
        <div className="panel">
          <h3>Staff</h3>
          {canCreate && (
            <form className="compact" onSubmit={createStaff}>
              <input name="first_name" required placeholder="First name" />
              <input name="last_name" required placeholder="Last name" />
              <input name="pin" required pattern="\\d{4,12}" placeholder="PIN" />
              {roles.data?.data.map((role) => (
                <label key={role.id} className="check">
                  <input type="checkbox" name="role_ids" value={role.id} />
                  {role.name}
                </label>
              ))}
              <button>Create staff</button>
            </form>
          )}
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {staff.data?.data.map((person) => (
                <tr key={person.id}>
                  <td>
                    {person.first_name} {person.last_name}
                  </td>
                  <td>{person.active ? 'Active' : 'Inactive'}</td>
                  <td>
                    {canUpdate && (
                      <button onClick={() => void toggle(person)}>
                        {person.active ? 'Deactivate' : 'Activate'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="panel">
          <h3>Roles & permission grants</h3>
          {roles.data?.data.map((role) => (
            <RoleEditor key={role.id} role={role} editable={canRoles} onError={setError} />
          ))}
        </div>
      </div>
      <div className="panel">
        <h3>Terminals</h3>
        {canEnrollTerminal && (
          <TerminalEnroll locationId={locationId} onError={setError} />
        )}
        <ul>
          {terminals.data?.data.map((terminal) => (
            <li key={terminal.id}>
              {terminal.name} ·{' '}
              {terminalPurpose(terminal, categories.data?.data ?? [], tables.data?.data ?? [])} ·{' '}
              {terminal.is_active ? 'active' : 'inactive'}
              {canEnrollTerminal && (
                <TerminalProfileEditor
                  terminal={terminal}
                  categories={categories.data?.data ?? []}
                  tables={tables.data?.data ?? []}
                  onError={setError}
                />
              )}
            </li>
          ))}
        </ul>
      </div>
      <Conflict error={error} refresh={() => void qc.invalidateQueries()} />
    </section>
  );
}
function RoleEditor({
  role,
  editable,
  onError,
}: {
  role: Role;
  editable: boolean;
  onError: (error: unknown) => void;
}) {
  const qc = useQueryClient();
  const [selected, setSelected] = useState(
    () => new Set(role.permissions.map((p) => p.permission_name)),
  );
  const [open, setOpen] = useState(false);
  useEffect(() => setSelected(new Set(role.permissions.map((p) => p.permission_name))), [role]);
  async function save() {
    try {
      await apiFetch(`/api/v1/roles/${role.id}/permissions`, {
        method: 'PUT',
        body: JSON.stringify({
          permissions: [...selected].map((permission_name) => ({
            permission_name,
            scope: 'location',
          })),
        }),
      });
      void qc.invalidateQueries({ queryKey: ['roles'] });
    } catch (err) {
      onError(err);
    }
  }
  const domains = [...new Set(permissions.map((p) => p.split('.')[0]))];
  return (
    <article className="role">
      <button className="role-title" onClick={() => setOpen(!open)}>
        {role.name} {role.is_system_template && '(system)'}
      </button>
      {open && (
        <>
          <p>{role.description ?? 'No description'}</p>
          {domains.map((domain) => (
            <fieldset key={domain}>
              <legend>{domain}</legend>
              {permissions
                .filter((p) => p.startsWith(`${domain}.`))
                .map((permission) => (
                  <label className="check" key={permission}>
                    <input
                      disabled={!editable}
                      type="checkbox"
                      checked={selected.has(permission)}
                      onChange={(e) =>
                        setSelected((current) => {
                          const next = new Set(current);
                          if (e.target.checked) next.add(permission);
                          else next.delete(permission);
                          return next;
                        })
                      }
                    />
                    {permission}
                  </label>
                ))}
            </fieldset>
          ))}
          {editable && <button onClick={() => void save()}>Save permission grants</button>}
        </>
      )}
    </article>
  );
}
function TerminalEnroll({
  locationId,
  onError,
}: {
  locationId: string;
  onError: (error: unknown) => void;
}) {
  const [name, setName] = useState(''),
    [credential, setCredential] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      const result = await apiFetch<{ terminal_credential: string }>('/api/v1/terminals/enroll', {
        method: 'POST',
        body: JSON.stringify({
          location_id: locationId,
          name,
        }),
      });
      setCredential(result.terminal_credential);
    } catch (err) {
      onError(err);
    }
  }
  return (
    <>
      <form className="compact" onSubmit={submit}>
        <input
          required
          placeholder="Terminal name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button>Enroll terminal</button>
      </form>
      {credential && (
        <p className="credential">
          <strong>Copy now — shown once:</strong> {credential}
        </p>
      )}
    </>
  );
}

function terminalPurpose(terminal: Terminal, categories: Category[], tables: Table[]) {
  const profile = terminal.profile_config as Record<string, unknown> | null;
  if (!terminal.app_target || !profile) return 'No purpose';
  if (terminal.app_target === 'KITCHEN' && profile.scope === 'ALL') return 'Kitchen / All';
  if (terminal.app_target === 'KITCHEN' && profile.scope === 'CATEGORY') {
    const names = Array.isArray(profile.category_ids)
      ? profile.category_ids
          .map((id) => categories.find((category) => category.id === id)?.name ?? String(id))
          .join(', ')
      : '';
    return `Kitchen / ${names || 'selected categories'}`;
  }
  if (terminal.app_target === 'SELF_SERVICE' && profile.mode === 'KIOSK')
    return 'Self-Service / Kiosk';
  if (terminal.app_target === 'SELF_SERVICE' && profile.mode === 'TABLE')
    return `Self-Service / ${tables.find((table) => table.id === profile.table_id)?.name ?? 'table'}`;
  if (terminal.app_target === 'SELF_SERVICE' && profile.mode === 'ORDER_STATUS')
    return 'Self-Service / Order Status';
  if (terminal.app_target === 'STAFF' && profile.mode === 'HOST') return 'Staff / Host';
  return 'Configuration mismatch';
}

function TerminalProfileEditor({
  terminal,
  categories,
  tables,
  onError,
}: {
  terminal: Terminal;
  categories: Category[];
  tables: Table[];
  onError: (error: unknown) => void;
}) {
  const qc = useQueryClient();
  const existing = terminal.profile_config as Record<string, unknown> | null;
  const [target, setTarget] = useState<Terminal['app_target']>(terminal.app_target);
  const [kitchenScope, setKitchenScope] = useState<'ALL' | 'CATEGORY'>(
    terminal.app_target === 'KITCHEN' && existing?.scope === 'CATEGORY' ? 'CATEGORY' : 'ALL',
  );
  const [categoryIds, setCategoryIds] = useState<string[]>(
    terminal.app_target === 'KITCHEN' && Array.isArray(existing?.category_ids)
      ? existing.category_ids.filter((id): id is string => typeof id === 'string')
      : [],
  );
  const [selfServiceMode, setSelfServiceMode] = useState<'KIOSK' | 'TABLE' | 'ORDER_STATUS'>(
    terminal.app_target === 'SELF_SERVICE' && typeof existing?.mode === 'string'
      ? existing.mode as 'KIOSK' | 'TABLE' | 'ORDER_STATUS'
      : 'KIOSK',
  );
  const [tableId, setTableId] = useState(
    terminal.app_target === 'SELF_SERVICE' && typeof existing?.table_id === 'string'
      ? existing.table_id
      : '',
  );
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const profile = terminal.profile_config as Record<string, unknown> | null;
    setTarget(terminal.app_target);
    setKitchenScope(terminal.app_target === 'KITCHEN' && profile?.scope === 'CATEGORY' ? 'CATEGORY' : 'ALL');
    setCategoryIds(
      terminal.app_target === 'KITCHEN' && Array.isArray(profile?.category_ids)
        ? profile.category_ids.filter((id): id is string => typeof id === 'string')
        : [],
    );
    setSelfServiceMode(
      terminal.app_target === 'SELF_SERVICE' && typeof profile?.mode === 'string'
        ? profile.mode as 'KIOSK' | 'TABLE' | 'ORDER_STATUS'
        : 'KIOSK',
    );
    setTableId(terminal.app_target === 'SELF_SERVICE' && typeof profile?.table_id === 'string' ? profile.table_id : '');
  }, [terminal]);
  async function save(clear = false) {
    let profile_config: unknown = null;
    const app_target: Terminal['app_target'] = clear ? null : target;
    if (!clear && target === 'KITCHEN')
      profile_config = kitchenScope === 'ALL' ? { scope: 'ALL' } : { scope: 'CATEGORY', category_ids: categoryIds };
    if (!clear && target === 'SELF_SERVICE')
      profile_config = selfServiceMode === 'TABLE' ? { mode: 'TABLE', table_id: tableId } : { mode: selfServiceMode };
    if (!clear && target === 'STAFF') profile_config = { mode: 'HOST' };
    try {
      await apiFetch(`/api/v1/terminals/${terminal.id}/profile`, {
        method: 'PUT',
        ifMatch: terminal.version,
        body: JSON.stringify({ app_target, profile_config }),
      });
      setOpen(false);
      void qc.invalidateQueries({ queryKey: ['terminals'] });
    } catch (error) {
      onError(error);
    }
  }
  return (
    <details open={open} onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)} style={{ marginTop: '0.5rem' }}>
      <summary>Edit purpose</summary>
      <div className="compact">
        <select value={target ?? ''} onChange={(event) => setTarget((event.target.value || null) as Terminal['app_target'])}>
          <option value="">No purpose</option>
          <option value="KITCHEN">Kitchen</option>
          <option value="SELF_SERVICE">Self-Service</option>
          <option value="STAFF">Staff</option>
        </select>
        {target === 'KITCHEN' && <>
          <select value={kitchenScope} onChange={(event) => setKitchenScope(event.target.value as 'ALL' | 'CATEGORY')}>
            <option value="ALL">All</option><option value="CATEGORY">Selected categories</option>
          </select>
          {kitchenScope === 'CATEGORY' && <select multiple value={categoryIds} onChange={(event) => setCategoryIds(Array.from(event.target.selectedOptions, (option) => option.value))}>
            {categories.filter((category) => category.is_active).map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
          </select>}
        </>}
        {target === 'SELF_SERVICE' && <>
          <select value={selfServiceMode} onChange={(event) => setSelfServiceMode(event.target.value as 'KIOSK' | 'TABLE' | 'ORDER_STATUS')}>
            <option value="KIOSK">Kiosk</option><option value="TABLE">Table</option><option value="ORDER_STATUS">Order Status</option>
          </select>
          {selfServiceMode === 'TABLE' && <select value={tableId} onChange={(event) => setTableId(event.target.value)}>
            <option value="">Select table</option>{tables.map((table) => <option key={table.id} value={table.id}>{table.name}</option>)}
          </select>}
        </>}
        {target === 'STAFF' && <span>Host</span>}
        <button type="button" onClick={() => void save()}>Save purpose</button>
        <button type="button" onClick={() => void save(true)}>Clear purpose</button>
      </div>
    </details>
  );
}

const reportEndpoints = [
  ['Sales by day', 'sales/by-day', 'reports.sales.read'],
  ['Sales by hour', 'sales/by-hour', 'reports.sales.read'],
  ['Sales by product', 'sales/by-product', 'reports.sales.read'],
  ['Sales by category', 'sales/by-category', 'reports.sales.read'],
  ['Sales by employee', 'sales/by-employee', 'reports.sales.read'],
  ['Orders summary', 'orders/summary', 'reports.sales.read'],
  ['Payments by method', 'payments/by-method', 'reports.sales.read'],
  ['Discounts', 'discounts', 'reports.sales.read'],
  ['Voids & cancellations', 'voids-and-cancellations', 'reports.audit.read'],
  ['Refunds', 'refunds', 'reports.audit.read'],
  ['Tips', 'tips', 'reports.sales.read'],
  ['Sales by channel', 'sales/by-channel', 'reports.sales.read'],
  ['Covers by day', 'covers/by-day', 'reports.sales.read'],
  ['Labor hours', 'labor/hours', 'reports.audit.read'],
] as const;
function Reports({ permissions, organizationId, reportLocations }: { permissions: string[]; organizationId: string; reportLocations: string[] }) {
  const [from, setFrom] = useState(() => new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10));
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));
  let rangeError = '';
  let range: { from: string; to: string } | undefined;
  try {
    range = reportRange(from, to);
  } catch (error) {
    rangeError = error instanceof Error ? error.message : 'Invalid range';
  }
  const active = reportEndpoints.filter(([, , permission]) => permissions.includes(permission));
  const isAll = reportLocations[0] === 'all';
  const isMulti = isAll || reportLocations.length > 1;

  return (
    <section>
      <h2>Reports</h2>
      <form className="compact">
        <label>
          From
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          To
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
      </form>
      <ErrorNotice error={rangeError} />
      {range && (
        <div className="reports">
          {active.map(([title, endpoint]) => {
            const basePath = isMulti 
              ? `/api/v1/organizations/${organizationId}/reports/${endpoint}`
              : `/api/v1/locations/${reportLocations[0]}/reports/${endpoint}`;
            const qs = isMulti ? (isAll ? `&all=true` : `&location_ids=${reportLocations.join(',')}`) : '';
            return (
              <ReportTable
                key={endpoint}
                title={title}
                path={`${basePath}?from=${encodeURIComponent(range!.from)}&to=${encodeURIComponent(range!.to)}${qs}`}
                isMulti={isMulti}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}
function ReportTable({ title, path, isMulti }: { title: string; path: string; isMulti: boolean }) {
  const query = useQuery({
    queryKey: ['report', path],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    queryFn: () => apiFetch<{ data: any }>(path),
  });

  const renderTable = (rows: Array<Record<string, unknown>>, subTitle?: string) => {
    const columns = rows[0] ? Object.keys(rows[0]) : [];
    return (
      <div key={subTitle ?? 'single'} style={{ marginBottom: '1rem' }}>
        {subTitle && <h4 style={{ margin: '0.5rem 0' }}>{subTitle}</h4>}
        {rows.length === 0 ? <p>No data in this range.</p> : (
          <table>
            <thead><tr>{columns.map(c => <th key={c}>{c.replaceAll('_', ' ')}</th>)}</tr></thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i}>{columns.map(c => <td key={c}>{String(row[c] ?? '')}</td>)}</tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    );
  };

  const data = query.data?.data ?? [];
  return (
    <article className="panel report">
      <h3>{title}</h3>
      {query.isLoading ? <p>Loading…</p> : (
        <>
          <ErrorNotice error={query.error} />
          {isMulti ? (
            data.length === 0 ? <p>No locations returned data.</p> : data.map((locGroup: { data: Array<Record<string, unknown>>; location_name: string }) => renderTable(locGroup.data, locGroup.location_name))
          ) : (
            renderTable(data)
          )}
        </>
      )}
    </article>
  );
}

function Root() {
  const [state, setState] = useState<'enroll' | 'unlock' | 'app'>('enroll');
  useEffect(() => {
    setState(!getTerminalCredential() ? 'enroll' : getSessionToken() ? 'app' : 'unlock');
    const unauthorized = () => setState('unlock');
    window.addEventListener('auth:unauthorized', unauthorized);
    return () => window.removeEventListener('auth:unauthorized', unauthorized);
  }, []);
  return (
    <QueryClientProvider client={client}>
      <BrowserRouter>
        {state === 'enroll' ? <Enrollment /> : state === 'unlock' ? <Unlock /> : <Shell />}
      </BrowserRouter>
    </QueryClientProvider>
  );
}
export function App() {
  return <Root />;
}
export default App;
type Ingredient = {
  id: string;
  name: string;
  unit_of_measure: string;
};

type RecipeLine = {
  id: string;
  product_id: string | null;
  modifier_id: string | null;
  ingredient_id: string;
  quantity_per_unit: string;
};

type InventoryItem = {
  id: string;
  name: string;
  unit_of_measure: string;
  quantity_on_hand: string | null;
  low_stock_threshold: string | null;
  version: number | null;
  stock_id: string | null;
};

function Inventory({ permissions, locationId }: { permissions: string[]; locationId: string }) {
  const [tab, setTab] = useState<'ingredients' | 'recipes' | 'stock'>('stock');
  return (
    <section>
      <h2>Inventory & Recipes</h2>
      <nav className="tabs" style={{ display: 'flex', gap: '1rem', marginBottom: '1rem' }}>
        <button className={tab === 'stock' ? 'active' : ''} onClick={() => setTab('stock')}>
          Stock
        </button>
        <button
          className={tab === 'ingredients' ? 'active' : ''}
          onClick={() => setTab('ingredients')}
        >
          Ingredients
        </button>
        <button className={tab === 'recipes' ? 'active' : ''} onClick={() => setTab('recipes')}>
          Recipes
        </button>
      </nav>
      {tab === 'stock' && <InventoryStock permissions={permissions} locationId={locationId} />}
      {tab === 'ingredients' && <InventoryIngredients permissions={permissions} />}
      {tab === 'recipes' && <InventoryRecipes permissions={permissions} />}
    </section>
  );
}

function InventoryIngredients({ permissions }: { permissions: string[] }) {
  const qc = useQueryClient();
  const write = permissions.includes('inventory.ingredients.write');
  const [error, setError] = useState<unknown>();
  const ingredients = useQuery({
    queryKey: ['ingredients'],
    queryFn: () => apiFetch<{ data: Ingredient[] }>('/api/v1/ingredients'),
  });

  const [name, setName] = useState('');
  const [unit, setUnit] = useState('');

  async function create(e: FormEvent) {
    e.preventDefault();
    try {
      await apiFetch('/api/v1/ingredients', {
        method: 'POST',
        body: JSON.stringify({ name, unit_of_measure: unit }),
      });
      setName('');
      setUnit('');
      void qc.invalidateQueries({ queryKey: ['ingredients'] });
      setError(undefined);
    } catch (err) {
      setError(err);
    }
  }

  return (
    <div>
      <ErrorNotice error={error} />
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Unit</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {ingredients.data?.data.map((ing) => (
            <IngredientRow key={ing.id} ing={ing} write={write} setError={setError} />
          ))}
        </tbody>
      </table>
      {write && (
        <article className="panel" style={{ marginTop: '2rem' }}>
          <h3>New Ingredient</h3>
          <form className="compact" onSubmit={create}>
            <input
              required
              placeholder="Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <input
              required
              placeholder="Unit (e.g. kg)"
              value={unit}
              onChange={(e) => setUnit(e.target.value)}
            />
            <button>Create</button>
          </form>
        </article>
      )}
    </div>
  );
}

function IngredientRow({
  ing,
  write,
  setError,
}: {
  ing: Ingredient;
  write: boolean;
  setError: (err: unknown) => void;
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(ing.name);
  const [unit, setUnit] = useState(ing.unit_of_measure);

  async function save() {
    try {
      await apiFetch(`/api/v1/ingredients/${ing.id}`, {
        method: 'PUT',
        body: JSON.stringify({ name, unit_of_measure: unit }),
      });
      setEditing(false);
      void qc.invalidateQueries({ queryKey: ['ingredients'] });
      setError(undefined);
    } catch (err) {
      setError(err);
    }
  }

  if (editing) {
    return (
      <tr>
        <td>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </td>
        <td>
          <input value={unit} onChange={(e) => setUnit(e.target.value)} />
        </td>
        <td>
          <button onClick={save}>Save</button>
          <button onClick={() => setEditing(false)}>Cancel</button>
        </td>
      </tr>
    );
  }

  return (
    <tr>
      <td>{ing.name}</td>
      <td>{ing.unit_of_measure}</td>
      <td>{write && <button onClick={() => setEditing(true)}>Edit</button>}</td>
    </tr>
  );
}

function InventoryRecipes({ permissions }: { permissions: string[] }) {
  const qc = useQueryClient();
  const write = permissions.includes('inventory.recipes.write');
  const [error, setError] = useState<unknown>();

  const ingredients = useQuery({
    queryKey: ['ingredients'],
    queryFn: () => apiFetch<{ data: Ingredient[] }>('/api/v1/ingredients'),
  });

  const products = useQuery({
    queryKey: ['products'],
    queryFn: () => apiFetch<{ data: Product[] }>('/api/v1/products'),
  });

  const [productId, setProductId] = useState('');

  const recipes = useQuery({
    queryKey: ['recipes', productId],
    queryFn: () =>
      apiFetch<{ data: RecipeLine[] }>(
        `/api/v1/recipes${productId ? `?product_id=${productId}` : ''}`,
      ),
    enabled: !!productId,
  });

  const [ingredientId, setIngredientId] = useState('');
  const [quantity, setQuantity] = useState('');

  async function create(e: FormEvent) {
    e.preventDefault();
    if (!productId) return;
    try {
      await apiFetch('/api/v1/recipes', {
        method: 'POST',
        body: JSON.stringify({
          product_id: productId,
          ingredient_id: ingredientId,
          quantity_per_unit: quantity,
        }),
      });
      setIngredientId('');
      setQuantity('');
      void qc.invalidateQueries({ queryKey: ['recipes', productId] });
      setError(undefined);
    } catch (err) {
      setError(err);
    }
  }

  async function remove(id: string) {
    if (!confirm('Delete recipe line?')) return;
    try {
      await apiFetch(`/api/v1/recipes/${id}`, { method: 'DELETE' });
      void qc.invalidateQueries({ queryKey: ['recipes', productId] });
      setError(undefined);
    } catch (err) {
      setError(err);
    }
  }

  return (
    <div>
      <ErrorNotice error={error} />
      <div style={{ marginBottom: '1rem' }}>
        <label>
          Select Product:
          <select value={productId} onChange={(e) => setProductId(e.target.value)}>
            <option value="">-- Choose a product --</option>
            {products.data?.data.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {productId && (
        <>
          <table>
            <thead>
              <tr>
                <th>Ingredient</th>
                <th>Qty Per Unit</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {recipes.data?.data.map((r) => {
                const ingName =
                  ingredients.data?.data.find((i) => i.id === r.ingredient_id)?.name ??
                  r.ingredient_id;
                const unit =
                  ingredients.data?.data.find((i) => i.id === r.ingredient_id)?.unit_of_measure ??
                  '';
                return (
                  <tr key={r.id}>
                    <td>{ingName}</td>
                    <td>
                      {r.quantity_per_unit} {unit}
                    </td>
                    <td>{write && <button onClick={() => remove(r.id)}>Delete</button>}</td>
                  </tr>
                );
              })}
              {(!recipes.data?.data || recipes.data.data.length === 0) && (
                <tr>
                  <td colSpan={3}>No recipe lines defined for this product.</td>
                </tr>
              )}
            </tbody>
          </table>

          {write && (
            <article className="panel" style={{ marginTop: '2rem' }}>
              <h3>Add Recipe Line</h3>
              <form className="compact" onSubmit={create}>
                <select
                  required
                  value={ingredientId}
                  onChange={(e) => setIngredientId(e.target.value)}
                >
                  <option value="">-- Ingredient --</option>
                  {ingredients.data?.data.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name} ({i.unit_of_measure})
                    </option>
                  ))}
                </select>
                <input
                  required
                  placeholder="Quantity"
                  type="number"
                  step=".0001"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                />
                <button>Add</button>
              </form>
            </article>
          )}
        </>
      )}
    </div>
  );
}

function InventoryStock({
  permissions,
  locationId,
}: {
  permissions: string[];
  locationId: string;
}) {
  const qc = useQueryClient();
  const write = permissions.includes('inventory.stock.adjust');
  const [error, setError] = useState<unknown>();

  const stock = useQuery({
    queryKey: ['inventory', locationId],
    queryFn: () => apiFetch<{ data: InventoryItem[] }>(`/api/v1/locations/${locationId}/inventory`),
  });

  return (
    <div>
      <Conflict
        error={error}
        refresh={() => void qc.invalidateQueries({ queryKey: ['inventory', locationId] })}
      />
      {!(error instanceof ApiError && error.code === 'OPTIMISTIC_CONCURRENCY_CONFLICT') && (
        <ErrorNotice error={error} />
      )}
      <table>
        <thead>
          <tr>
            <th>Ingredient</th>
            <th>On Hand</th>
            <th>Unit</th>
            <th>Adjust</th>
          </tr>
        </thead>
        <tbody>
          {stock.data?.data.map((item) => (
            <StockRow
              key={item.id}
              item={item}
              write={write}
              setError={setError}
              locationId={locationId}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StockRow({
  item,
  write,
  setError,
  locationId,
}: {
  item: InventoryItem;
  write: boolean;
  setError: (err: unknown) => void;
  locationId: string;
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [newQty, setNewQty] = useState(item.quantity_on_hand ?? '0');
  const [reason, setReason] = useState('');

  async function adjust(e: FormEvent) {
    e.preventDefault();
    try {
      await apiFetch(`/api/v1/locations/${locationId}/inventory/${item.id}/adjust`, {
        method: 'POST',
        headers: item.stock_id ? { 'If-Match': String(item.version) } : {},
        body: JSON.stringify({ new_quantity: newQty, reason }),
      });
      setEditing(false);
      setReason('');
      void qc.invalidateQueries({ queryKey: ['inventory', locationId] });
      setError(undefined);
    } catch (err) {
      setError(err);
    }
  }

  if (editing) {
    return (
      <tr>
        <td>{item.name}</td>
        <td colSpan={3}>
          <form
            className="compact"
            onSubmit={adjust}
            style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}
          >
            <input
              required
              type="number"
              step=".0001"
              placeholder="New Qty"
              value={newQty}
              onChange={(e) => setNewQty(e.target.value)}
              style={{ width: '100px' }}
            />
            <input
              required
              placeholder="Reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <button>Save</button>
            <button type="button" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </form>
        </td>
      </tr>
    );
  }

  return (
    <tr>
      <td>{item.name}</td>
      <td>{item.quantity_on_hand ?? '0'}</td>
      <td>{item.unit_of_measure}</td>
      <td>{write && <button onClick={() => setEditing(true)}>Adjust</button>}</td>
    </tr>
  );
}

type ReservationSettings = {
  accepts_reservations: boolean;
  operating_hours: Array<{ day_of_week: number; open_time: string; close_time: string }>;
  estimated_visit_duration_minutes: number;
  minimum_lead_time_minutes: number;
  maximum_party_size: number;
  auto_confirm: boolean;
  version: number;
};

function Reservations({ permissions, locationId }: { permissions: string[]; locationId: string }) {
  const qc = useQueryClient();
  const settings = useQuery({
    queryKey: ['reservation-settings', locationId],
    queryFn: () => apiFetch<ReservationSettings>(`/api/v1/locations/${locationId}/reservation-settings`),
  });
  
  const [error, setError] = useState<unknown>();
  const write = permissions.includes('reservations.settings.write');
  
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!settings.data) return;
    try {
      await apiFetch(`/api/v1/locations/${locationId}/reservation-settings`, {
        method: 'PUT',
        body: JSON.stringify(settings.data),
      });
      void qc.invalidateQueries({ queryKey: ['reservation-settings', locationId] });
      setError(undefined);
    } catch (err) {
      setError(err);
    }
  }

  if (settings.isLoading) return <section>Loading settings...</section>;
  if (!settings.data) return <section><ErrorNotice error={settings.error} /></section>;

  const form = settings.data;

  return (
    <section>
      <h2>Reservation Settings</h2>
      <ErrorNotice error={error} />
      <form className="form-grid" onSubmit={save}>
        <label>
          <input
            type="checkbox"
            disabled={!write}
            checked={form.accepts_reservations}
            onChange={(e) => qc.setQueryData(['reservation-settings', locationId], { ...form, accepts_reservations: e.target.checked })}
          />
          Accepts Reservations
        </label>
        <label>
          <input
            type="checkbox"
            disabled={!write}
            checked={form.auto_confirm}
            onChange={(e) => qc.setQueryData(['reservation-settings', locationId], { ...form, auto_confirm: e.target.checked })}
          />
          Auto-Confirm Reservations
        </label>
        <label>
          Max Party Size
          <input
            type="number"
            disabled={!write}
            value={form.maximum_party_size}
            onChange={(e) => qc.setQueryData(['reservation-settings', locationId], { ...form, maximum_party_size: +e.target.value })}
          />
        </label>
        <label>
          Est. Visit Duration (minutes)
          <input
            type="number"
            disabled={!write}
            value={form.estimated_visit_duration_minutes}
            onChange={(e) => qc.setQueryData(['reservation-settings', locationId], { ...form, estimated_visit_duration_minutes: +e.target.value })}
          />
        </label>
        <label>
          Min Lead Time (minutes)
          <input
            type="number"
            disabled={!write}
            value={form.minimum_lead_time_minutes}
            onChange={(e) => qc.setQueryData(['reservation-settings', locationId], { ...form, minimum_lead_time_minutes: +e.target.value })}
          />
        </label>
        <div style={{ gridColumn: '1 / -1' }}>
          <h4>Operating Hours</h4>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {[1, 2, 3, 4, 5, 6, 7].map((day) => {
              const h = form.operating_hours.find(x => x.day_of_week === day);
              return (
                <div key={day} style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
                  <span style={{ width: '100px' }}>Day {day}</span>
                  <label>
                    <input type="checkbox" checked={!!h} onChange={(e) => {
                      let next = [...form.operating_hours];
                      if (e.target.checked) next.push({ day_of_week: day, open_time: '09:00', close_time: '17:00' });
                      else next = next.filter(x => x.day_of_week !== day);
                      qc.setQueryData(['reservation-settings', locationId], { ...form, operating_hours: next });
                    }} disabled={!write} />
                    Open
                  </label>
                  {h && (
                    <>
                      <input type="time" disabled={!write} value={h.open_time} onChange={e => {
                        const next = [...form.operating_hours];
                        const idx = next.findIndex(x => x.day_of_week === day);
                        next[idx] = { ...next[idx], open_time: e.target.value };
                        qc.setQueryData(['reservation-settings', locationId], { ...form, operating_hours: next });
                      }} />
                      to
                      <input type="time" disabled={!write} value={h.close_time} onChange={e => {
                        const next = [...form.operating_hours];
                        const idx = next.findIndex(x => x.day_of_week === day);
                        next[idx] = { ...next[idx], close_time: e.target.value };
                        qc.setQueryData(['reservation-settings', locationId], { ...form, operating_hours: next });
                      }} />
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        {write && <button style={{ gridColumn: '1 / -1', marginTop: '1rem' }}>Save Settings</button>}
      </form>
    </section>
  );
}

type ScheduledOrderSettings = {
  accepts_scheduled_orders: boolean;
  minimum_lead_time_minutes: number;
  maximum_lead_time_days: number;
  operating_hours: Array<{ day_of_week: number; open_time: string; close_time: string }>;
  version: number;
};

function ScheduledOrders({ permissions, locationId }: { permissions: string[]; locationId: string }) {
  const qc = useQueryClient();
  const settings = useQuery({
    queryKey: ['scheduled-order-settings', locationId],
    queryFn: () => apiFetch<ScheduledOrderSettings>(`/api/v1/locations/${locationId}/scheduled-order-settings`),
  });

  const write = permissions.includes('online_ordering.settings.write');
  const form = settings.data;

  const save = useMutation({
    mutationFn: async () => {
      await apiFetch(`/api/v1/locations/${locationId}/scheduled-order-settings`, {
        method: 'PUT',
        body: JSON.stringify(form),
      });
      void qc.invalidateQueries({ queryKey: ['scheduled-order-settings', locationId] });
    },
  });

  if (settings.isLoading) return <div className="p-4">Loading...</div>;
  if (!form) return <div className="p-4">Error loading settings.</div>;

  return (
    <div className="p-4 max-w-2xl">
      <h2 className="text-2xl font-bold mb-6">Scheduled Orders Configuration</h2>
      <div className="space-y-6">
        <label className="flex items-center space-x-2">
          <input
            type="checkbox"
            checked={form.accepts_scheduled_orders}
            onChange={(e) => qc.setQueryData(['scheduled-order-settings', locationId], { ...form, accepts_scheduled_orders: e.target.checked })}
            disabled={!write}
          />
          <span className="font-medium">Accept Scheduled Orders</span>
        </label>
        
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium mb-1">Minimum Lead Time (minutes)</label>
            <input
              type="number"
              className="w-full border rounded p-2"
              value={form.minimum_lead_time_minutes}
              onChange={(e) => qc.setQueryData(['scheduled-order-settings', locationId], { ...form, minimum_lead_time_minutes: +e.target.value })}
              disabled={!write}
              min="1"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Maximum Lead Time (days)</label>
            <input
              type="number"
              className="w-full border rounded p-2"
              value={form.maximum_lead_time_days}
              onChange={(e) => qc.setQueryData(['scheduled-order-settings', locationId], { ...form, maximum_lead_time_days: +e.target.value })}
              disabled={!write}
              min="1"
            />
          </div>
        </div>
        
        <div>
          <h3 className="text-lg font-medium mb-2">Operating Hours</h3>
          <div className="space-y-2">
            {[1, 2, 3, 4, 5, 6, 7].map((day) => {
              const h = form.operating_hours.find((x) => x.day_of_week === day);
              const name = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][day - 1];
              return (
                <div key={day} className="flex items-center space-x-4">
                  <label className="w-16 flex items-center space-x-2">
                    <input
                      type="checkbox"
                      checked={!!h}
                      disabled={!write}
                      onChange={(e) => {
                        const next = form.operating_hours.filter((x) => x.day_of_week !== day);
                        if (e.target.checked) next.push({ day_of_week: day, open_time: '09:00', close_time: '17:00' });
                        qc.setQueryData(['scheduled-order-settings', locationId], { ...form, operating_hours: next });
                      }}
                    />
                    <span>{name}</span>
                  </label>
                  {h && (
                    <>
                      <input
                        type="time"
                        className="border rounded p-1"
                        value={h.open_time}
                        disabled={!write}
                        onChange={(e) => {
                          const next = form.operating_hours.map((x) => (x.day_of_week === day ? { ...x, open_time: e.target.value } : x));
                          qc.setQueryData(['scheduled-order-settings', locationId], { ...form, operating_hours: next });
                        }}
                      />
                      <span>to</span>
                      <input
                        type="time"
                        className="border rounded p-1"
                        value={h.close_time}
                        disabled={!write}
                        onChange={(e) => {
                          const next = form.operating_hours.map((x) => (x.day_of_week === day ? { ...x, close_time: e.target.value } : x));
                          qc.setQueryData(['scheduled-order-settings', locationId], { ...form, operating_hours: next });
                        }}
                      />
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {write && (
          <button
            onClick={() => save.mutate()}
            disabled={save.isPending}
            className="bg-blue-600 text-white px-4 py-2 rounded font-medium disabled:opacity-50"
          >
            {save.isPending ? 'Saving...' : 'Save Changes'}
          </button>
        )}
      </div>
    </div>
  );
}
