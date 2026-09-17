import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { BrowserRouter, Link, Route, Routes, useNavigate, useParams, Navigate } from 'react-router-dom';
import {
  ApiError,
  LOCATION_HOURS,
  ORGANIZATION_ID,
  apiFetch,
  clearCustomerToken,
  getCustomerToken,
  setCustomerToken,
  type Category,
  type Customer,
  type Location,
  type OnlineCheckoutRequest,
  type OnlineCheckoutResponse,
  type OnlineOrderDetail,
  type OnlineOrderListItem,
  type OnlineOrderListResponse,
  type Product,
} from './api.js';
import { cartItemPrice, cartTotal, requiresDeliveryAddress, meetsDeliveryMinimum, type CartItem } from './logic.js';

const queryClient = new QueryClient();
const money = (amount: number) =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(amount / 100);
type StoredOrder = { id: string; locationId: string; orderToken: string | null; createdAt: string };
const historyKey = (customer?: Customer | null) =>
  `customer-online-orders:${ORGANIZATION_ID}:${customer?.id ?? 'guest'}`;
const readOrders = (customer?: Customer | null): StoredOrder[] => {
  try {
    return JSON.parse(localStorage.getItem(historyKey(customer)) ?? '[]') as StoredOrder[];
  } catch {
    return [];
  }
};
const storeOrder = (order: StoredOrder, customer?: Customer | null) => {
  const current = readOrders(customer).filter((item) => item.id !== order.id);
  localStorage.setItem(historyKey(customer), JSON.stringify([order, ...current].slice(0, 20)));
};
const onlineOrderPath = (locationId: string, orderId: string, orderToken?: string | null) =>
  `/api/v1/locations/${locationId}/online-orders/${orderId}${orderToken ? `?order_token=${encodeURIComponent(orderToken)}` : ''}`;

function ErrorMessage({ error }: { error: unknown }) {
  const apiError = error as ApiError;
  return <p className="error">{apiError.message || 'Something went wrong. Please try again.'}</p>;
}

function LocationGate({ children }: { children: (location: Location) => React.ReactNode }) {
  const [locationId, setLocationId] = useState(() =>
    localStorage.getItem(`customer-location:${ORGANIZATION_ID}`),
  );
  const locations = useQuery({
    queryKey: ['customer-locations', ORGANIZATION_ID],
    queryFn: () =>
      apiFetch<{ data: Location[] }>(`/api/v1/organizations/${ORGANIZATION_ID}/locations`),
    enabled: Boolean(ORGANIZATION_ID),
  });
  useEffect(() => {
    if (locations.data?.data.length === 1 && !locationId) setLocationId(locations.data.data[0].id);
  }, [locationId, locations.data]);
  if (!ORGANIZATION_ID)
    return (
      <main className="centered">
        <h1>Restaurant setup needed</h1>
        <p>Set VITE_ORGANIZATION_ID for this installation.</p>
      </main>
    );
  if (locations.isPending)
    return (
      <main className="centered">
        <h1>Finding locations…</h1>
      </main>
    );
  if (locations.isError)
    return (
      <main className="centered">
        <h1>We could not load locations</h1>
        <ErrorMessage error={locations.error} />
      </main>
    );
  const selected = locations.data?.data.find((location) => location.id === locationId);
  if (!selected)
    return (
      <main className="centered location-picker">
        <h1>Choose your location</h1>
        <p>Start with the restaurant you want to order from.</p>
        {locations.data?.data.map((location) => (
          <button
            key={location.id}
            onClick={() => {
              localStorage.setItem(`customer-location:${ORGANIZATION_ID}`, location.id);
              setLocationId(location.id);
            }}
          >
            <strong>{location.name}</strong>
            <span>{location.address ?? location.timezone}</span>
          </button>
        ))}
      </main>
    );
  return <>{children(selected)}</>;
}

function Header({
  location,
  customer,
  cartCount,
  onSignOut,
}: {
  location: Location;
  customer?: Customer | null;
  cartCount: number;
  onSignOut: () => void;
}) {
  return (
    <header>
      <Link className="brand" to="/">
        {location.name}
      </Link>
      <nav>
                <Link to="/">Menu</Link>
        <Link to="/reservations">Book a Table</Link>
        {customer && <Link to="/loyalty">Loyalty</Link>}
        <Link to="/history">Orders</Link>
        <Link to="/checkout">Cart ({cartCount})</Link>
        {customer ? (
          <button className="link-button" onClick={onSignOut}>
            Sign out
          </button>
        ) : (
          <Link to="/login">Sign in</Link>
        )}
      </nav>
    </header>
  );
}

function ProductDialog({
  product,
  onClose,
  onAdd,
}: {
  product: Product;
  onClose: () => void;
  onAdd: (item: CartItem) => void;
}) {
  const [modifierIds, setModifierIds] = useState<string[]>([]);
  const activeModifierGroups = product.modifier_groups.filter((group) => group.is_active);
  const valid =
    activeModifierGroups.filter((group) => {
      const selected = group.modifiers.filter((modifier) =>
        modifierIds.includes(modifier.id),
      ).length;
      return (
        selected >= group.min_selections &&
        (group.max_selections === null || selected <= group.max_selections)
      );
    }).length === product.modifier_groups.length;
  const toggle = (id: string, group: Product['modifier_groups'][number]) =>
    setModifierIds((current) => {
      if (current.includes(id)) return current.filter((item) => item !== id);
      const selected = group.modifiers.filter((modifier) => current.includes(modifier.id)).length;
      return group.max_selections !== null && selected >= group.max_selections
        ? current
        : [...current, id];
    });
  return (
    <div className="dialog-backdrop">
      <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="product-title">
        <button className="close" onClick={onClose} aria-label="Close">
          ×
        </button>
        <h2 id="product-title">{product.name}</h2>
        <p>{product.description}</p>
        {product.variants.length > 0 && (
          <p className="muted">Sizes are not available for online ordering yet.</p>
        )}
        {activeModifierGroups.map((group) => (
          <fieldset key={group.id}>
            <legend>
              {group.name}{' '}
              {group.min_selections > 0 ? `(choose at least ${group.min_selections})` : ''}
            </legend>
            {group.modifiers
              .filter((modifier) => modifier.is_active)
              .map((modifier) => (
                <label key={modifier.id}>
                  <input
                    type="checkbox"
                    checked={modifierIds.includes(modifier.id)}
                    onChange={() => toggle(modifier.id, group)}
                  />{' '}
                  {modifier.name}
                  {modifier.price_adjustment ? ` (+${money(modifier.price_adjustment)})` : ''}
                </label>
              ))}
          </fieldset>
        ))}
        <button
          className="primary"
          disabled={!valid}
          onClick={() => onAdd({ product, quantity: 1, modifierIds })}
        >
          Add to cart · {money(cartItemPrice({ product, quantity: 1, modifierIds }))}
        </button>
      </section>
    </div>
  );
}

function Menu({
  location,
  setCart,
}: {
  location: Location;
  setCart: React.Dispatch<React.SetStateAction<CartItem[]>>;
}) {
  const [fulfillment, setFulfillment] = useState<'PICKUP' | 'DELIVERY'>('PICKUP');
  const [category, setCategory] = useState('all');
  const [selected, setSelected] = useState<Product | null>(null);
  const categories = useQuery({
    queryKey: ['categories', location.id],
    queryFn: () => apiFetch<{ data: Category[] }>(`/api/v1/categories?location_id=${location.id}`),
  });
  const products = useQuery({
    queryKey: ['products', location.id, fulfillment],
    queryFn: () =>
      apiFetch<{ data: Product[] }>(
        `/api/v1/products?location_id=${location.id}&channel=${fulfillment}&service_type=${fulfillment}`,
      ),
  });
  const visible = (products.data?.data ?? []).filter(
    (product) =>
      product.is_active &&
      product.availability.available &&
      (category === 'all' || product.category_id === category),
  );
  return (
    <main>
      <section className="hero">
        <p className="eyebrow">Order ahead</p>
        <h1>Good food, on your schedule.</h1>
        <p>{location.address ?? `Serving ${location.name}`}</p>
        <p>Hours: {LOCATION_HOURS}</p>
        <div className="toggle">
          <button
            className={fulfillment === 'PICKUP' ? 'active' : ''}
            onClick={() => setFulfillment('PICKUP')}
          >
            Pickup
          </button>
          <button
            className={fulfillment === 'DELIVERY' ? 'active' : ''}
            onClick={() => setFulfillment('DELIVERY')}
          >
            Delivery
          </button>
        </div>
      </section>
      <section>
        <h2>Menu</h2>
        <div className="category-tabs">
          <button className={category === 'all' ? 'active' : ''} onClick={() => setCategory('all')}>
            All
          </button>
          {(categories.data?.data ?? [])
            .filter((item) => item.is_active)
            .map((item) => (
              <button
                className={category === item.id ? 'active' : ''}
                key={item.id}
                onClick={() => setCategory(item.id)}
              >
                {item.name}
              </button>
            ))}
        </div>
        {products.isPending && <p>Loading menu…</p>}
        {products.isError && <ErrorMessage error={products.error} />}
        <div className="product-grid">
          {visible.map((product) => (
            <button className="product-card" key={product.id} onClick={() => setSelected(product)}>
              {product.photo_url && <img src={product.photo_url} alt="" />}
              <strong>{product.name}</strong>
              <span>{product.description}</span>
              <b>{money(product.price)}</b>
            </button>
          ))}
        </div>
        {!products.isPending && visible.length === 0 && (
          <p>No items are currently available for {fulfillment.toLowerCase()}.</p>
        )}
      </section>
      {selected && (
        <ProductDialog
          product={selected}
          onClose={() => setSelected(null)}
          onAdd={(item) => {
            setCart((current) => [...current, item]);
            setSelected(null);
          }}
        />
      )}
    </main>
  );
}

function AuthScreen({
  mode,
  onAuthenticated,
}: {
  mode: 'login' | 'register';
  onAuthenticated: () => void;
}) {
  const navigate = useNavigate();
  const mutation = useMutation({
    mutationFn: async (form: HTMLFormElement) => {
      const data = new FormData(form);
      if (mode === 'register')
        await apiFetch(`/api/v1/organizations/${ORGANIZATION_ID}/customers`, {
          method: 'POST',
          body: JSON.stringify({
            name: data.get('name'),
            email: data.get('email'),
            phone: data.get('phone') || undefined,
            password: data.get('password'),
          }),
        });
      return apiFetch<{ token: string }>(
        `/api/v1/organizations/${ORGANIZATION_ID}/customer-sessions`,
        {
          method: 'POST',
          body: JSON.stringify({ email: data.get('email'), password: data.get('password') }),
        },
      );
    },
    onSuccess: ({ token }) => {
      setCustomerToken(token);
      onAuthenticated();
      navigate('/');
    },
  });
  return (
    <main className="narrow">
      <h1>{mode === 'login' ? 'Welcome back' : 'Create an account'}</h1>
      <p>
        {mode === 'login'
          ? 'Sign in to keep your orders together.'
          : 'An account is optional; you can also check out as a guest.'}
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          mutation.mutate(event.currentTarget);
        }}
      >
        {mode === 'register' && (
          <>
            <label>
              Name
              <input name="name" required maxLength={200} />
            </label>
            <label>
              Phone <input name="phone" maxLength={40} />
            </label>
          </>
        )}
        <label>
          Email
          <input name="email" type="email" required />
        </label>
        <label>
          Password
          <input name="password" type="password" minLength={mode === 'register' ? 8 : 1} required />
        </label>
        {mutation.isError && <ErrorMessage error={mutation.error} />}
        <button className="primary" disabled={mutation.isPending}>
          {mutation.isPending ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
        </button>
      </form>
      <p>
        {mode === 'login' ? (
          <>
            New here? <Link to="/register">Create an account</Link>
          </>
        ) : (
          <>
            Already have an account? <Link to="/login">Sign in</Link>
          </>
        )}
      </p>
    </main>
  );
}

function Cart({
  cart,
  setCart,
}: {
  cart: CartItem[];
  setCart: React.Dispatch<React.SetStateAction<CartItem[]>>;
}) {
  return (
    <aside className="cart">
      <h2>Your order</h2>
      {cart.map((item, index) => (
        <div className="cart-line" key={`${item.product.id}-${index}`}>
          <span>
            <strong>{item.product.name}</strong>
            <small>
              {item.modifierIds
                .map(
                  (id) =>
                    item.product.modifier_groups
                      .flatMap((group) => group.modifiers)
                      .find((modifier) => modifier.id === id)?.name,
                )
                .filter(Boolean)
                .join(', ')}
            </small>
          </span>
          <span>
            <button
              onClick={() =>
                setCart((items) =>
                  items.map((line, i) =>
                    i === index ? { ...line, quantity: Math.max(1, line.quantity - 1) } : line,
                  ),
                )
              }
            >
              −
            </button>{' '}
            {item.quantity}{' '}
            <button
              onClick={() =>
                setCart((items) =>
                  items.map((line, i) =>
                    i === index ? { ...line, quantity: line.quantity + 1 } : line,
                  ),
                )
              }
            >
              +
            </button>
            <button
              aria-label={`Remove ${item.product.name}`}
              onClick={() => setCart((items) => items.filter((_, i) => i !== index))}
            >
              ×
            </button>
          </span>
          <b>{money(cartItemPrice(item) * item.quantity)}</b>
        </div>
      ))}
      <div className="total">
        <span>Total</span>
        <strong>{money(cartTotal(cart))}</strong>
      </div>
    </aside>
  );
}

function Checkout({
  location,
  cart,
  setCart,
  customer,
}: {
  location: Location;
  cart: CartItem[];
  setCart: React.Dispatch<React.SetStateAction<CartItem[]>>;
  customer?: Customer | null;
}) {
  const navigate = useNavigate();
  const [fulfillment, setFulfillment] = useState<'PICKUP' | 'DELIVERY'>('PICKUP');
  const [isScheduled, setIsScheduled] = useState(false);
  const [deliveryZoneId, setDeliveryZoneId] = useState<string>('');
  const { data: zonesData } = useQuery({
    queryKey: ['delivery-zones', location.id],
    queryFn: () => apiFetch<{ data: { id: string, name: string, fee: number, minimum_order_amount: number }[] }>(`/api/v1/locations/${location.id}/delivery-zones`),
    enabled: fulfillment === 'DELIVERY',
  });
  const zones = zonesData?.data ?? [];
  const selectedZone = deliveryZoneId ? zones.find(z => z.id === deliveryZoneId) : zones[0];
  
  const mutation = useMutation({
    mutationFn: (form: HTMLFormElement) => {
      const data = new FormData(form);
      const address = String(data.get('delivery_address') ?? '').trim();
      const request: OnlineCheckoutRequest = {
        items: cart.map((item) => ({
          product_id: item.product.id,
          quantity: item.quantity,
          modifiers: item.modifierIds.map((modifier_id) => ({ modifier_id, quantity: 1 })),
        })),
        fulfillment_type: fulfillment,
        scheduled_for: isScheduled && data.get('scheduled_for')
          ? new Date(String(data.get('scheduled_for'))).toISOString()
          : null,
        customer_name: String(data.get('name')),
        customer_email: String(data.get('email')),
        customer_phone: String(data.get('phone')),
        ...(requiresDeliveryAddress(fulfillment) ? { delivery_address: { address }, delivery_zone_id: selectedZone?.id } : {}),
      };
      return apiFetch<OnlineCheckoutResponse>(
        `/api/v1/locations/${location.id}/online-orders/checkout`,
        { method: 'POST', body: JSON.stringify(request) },
      );
    },
    onSuccess: (result) => {
      storeOrder(
        {
          id: result.order_id,
          locationId: location.id,
          orderToken: result.order_token ?? null,
          createdAt: new Date().toISOString(),
        },
        customer,
      );
      setCart([]);
      navigate(`/orders/${result.order_id}?token=${encodeURIComponent(result.order_token ?? '')}`);
    },
  });
  if (!cart.length)
    return (
      <main className="narrow">
        <h1>Your cart is empty</h1>
        <Link className="button primary" to="/">
          Browse the menu
        </Link>
      </main>
    );
  return (
    <main className="checkout">
      <section>
        <h1>Checkout</h1>
        <div className="toggle">
          <button
            className={fulfillment === 'PICKUP' ? 'active' : ''}
            onClick={() => setFulfillment('PICKUP')}
          >
            Pickup
          </button>
          <button
            className={fulfillment === 'DELIVERY' ? 'active' : ''}
            onClick={() => setFulfillment('DELIVERY')}
          >
            Delivery
          </button>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate(event.currentTarget);
          }}
        >
          <label>
            Name
            <input name="name" required defaultValue={customer?.name} />
          </label>
          <label>
            Email
            <input name="email" type="email" required defaultValue={customer?.email} />
          </label>
          <label>
            Phone
            <input name="phone" required defaultValue={customer?.phone ?? ''} />
          </label>
          <fieldset className="schedule-fieldset">
            <legend>When would you like this order?</legend>
            <div className="toggle">
              <button
                type="button"
                className={!isScheduled ? 'active' : ''}
                onClick={() => setIsScheduled(false)}
              >
                ASAP
              </button>
              <button
                type="button"
                className={isScheduled ? 'active' : ''}
                onClick={() => setIsScheduled(true)}
              >
                Scheduled
              </button>
            </div>
            {isScheduled && (
              <label>
                Select time:
                <input name="scheduled_for" type="datetime-local" required={isScheduled} />
              </label>
            )}
          </fieldset>
          {requiresDeliveryAddress(fulfillment) && (
            <>
              <label>
                Delivery address
                <textarea name="delivery_address" required />
              </label>
              <label>
                Delivery Zone
                <select value={selectedZone?.id ?? ''} onChange={(e) => setDeliveryZoneId(e.target.value)} required>
                  {zones.map(zone => (
                    <option key={zone.id} value={zone.id}>
                      {zone.name}
                    </option>
                  ))}
                </select>
              </label>
              {selectedZone && (
                <p className="payment-note">Fee: {money(selectedZone.fee)} &middot; {money(selectedZone.minimum_order_amount)} minimum order</p>
              )}
            </>
          )}
          <p className="payment-note">
            Pay when you {fulfillment === 'PICKUP' ? 'pick up your order' : 'receive your delivery'}
            .
          </p>
          {mutation.isError && <ErrorMessage error={mutation.error} />}
          {!meetsDeliveryMinimum(cartTotal(cart), selectedZone) && fulfillment === 'DELIVERY' && (
            <div className="error">Subtotal does not meet the delivery zone minimum.</div>
          )}
          <button className="primary" disabled={mutation.isPending || (fulfillment === 'DELIVERY' && !meetsDeliveryMinimum(cartTotal(cart), selectedZone))}>
            {mutation.isPending ? 'Placing order…' : `Place order · ${money(cartTotal(cart))}`}
          </button>
        </form>
      </section>
      <Cart cart={cart} setCart={setCart} />
    </main>
  );
}

function OrderStatus({ location, customer }: { location: Location; customer?: Customer | null }) {
  const { orderId = '' } = useParams();
  const token =
    new URLSearchParams(window.location.search).get('token') ||
    readOrders(customer).find((item) => item.id === orderId)?.orderToken ||
    null;
  const order = useQuery({
    queryKey: ['online-order', location.id, orderId, token],
    queryFn: () => apiFetch<OnlineOrderDetail>(onlineOrderPath(location.id, orderId, token)),
    refetchInterval: 10_000,
  });
  if (order.isPending)
    return (
      <main className="centered">
        <h1>Getting your order…</h1>
      </main>
    );
  if (order.isError)
    return (
      <main className="centered">
        <h1>We could not find that order</h1>
        <ErrorMessage error={order.error} />
      </main>
    );
  const value = order.data;
  const lineStatus = value.lines.some((line) => line.status === 'READY')
    ? 'READY'
    : value.lines.some((line) => line.status === 'PREPARING')
      ? 'PREPARING'
      : value.order.status;
  const message =
    value.fulfillment.fulfillment_type === 'DELIVERY' &&
    value.fulfillment.status === 'OUT_FOR_DELIVERY'
      ? 'Out for delivery'
      : value.fulfillment.status === 'DELIVERED'
        ? 'Delivered'
        : lineStatus === 'READY'
          ? 'Ready for pickup'
          : lineStatus === 'PREPARING'
            ? 'Preparing your order'
            : 'Order received';
  return (
    <main className="narrow confirmation">
      <p className="eyebrow">Order confirmed</p>
      <h1>{message}</h1>
      <p>
        Your reference is <strong>{value.order.id}</strong>.
      </p>
      <p className="payment-note">
        Pay when you{' '}
        {value.fulfillment.fulfillment_type === 'PICKUP'
          ? 'pick up your order'
          : 'receive your delivery'}
        .
      </p>
      {value.order.totals && (
        <div style={{ padding: '1rem', background: '#f5f5f5', borderRadius: '4px', marginBottom: '1rem' }}>
          <div><strong>Total: {money(value.order.totals.total)}</strong></div>
          {value.order.totals.delivery_fee > 0 && (
            <div className="muted"><small>Includes {money(value.order.totals.delivery_fee)} delivery fee</small></div>
          )}
        </div>
      )}
      <p className="muted">We refresh this status automatically.</p>
      <Link className="button primary" to="/history">
        View recent orders
      </Link>
    </main>
  );
}

function CustomerOrderHistory({ location }: { location: Location }) {
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [accumulated, setAccumulated] = useState<OnlineOrderListItem[]>([]);

  const query = useQuery({
    queryKey: ['customer-orders', location.id, cursor],
    queryFn: async () => {
      const path = `/api/v1/locations/${location.id}/online-orders${cursor ? `?before=${encodeURIComponent(cursor)}` : ''}`;
      return apiFetch<OnlineOrderListResponse>(path);
    },
  });

  useEffect(() => {
    if (query.data?.data) {
      setAccumulated((prev) => {
        const existingIds = new Set(prev.map((item) => item.order.id));
        const newItems = query.data.data.filter((item) => !existingIds.has(item.order.id));
        return [...prev, ...newItems];
      });
    }
  }, [query.data]);

  const items = accumulated;
  const hasMore = Boolean(query.data?.next_before);

  return (
    <main>
      <h1>Recent orders</h1>
      <p className="muted">Orders linked to your account.</p>
      {query.isPending && !items.length && <p>Loading orders…</p>}
      {query.isError && <ErrorMessage error={query.error} />}
      {!query.isPending && !items.length && !query.isError && <p>No recent orders here yet.</p>}
      <div className="history-list">
        {items.map((item) => (
          <Link key={item.order.id} className="history-card" to={`/orders/${item.order.id}`}>
            <strong>{item.fulfillment.fulfillment_type}</strong>
            <span>{item.order.status}</span>
            <small>{new Date(item.order.created_at).toLocaleString()}</small>
            {item.order.totals && (
              <div style={{ marginTop: '0.5rem' }}>
                <div>Total: {money(item.order.totals.total)}</div>
                {item.order.totals.delivery_fee > 0 && (
                  <div className="muted"><small>Includes {money(item.order.totals.delivery_fee)} delivery fee</small></div>
                )}
              </div>
            )}
          </Link>
        ))}
      </div>
      {hasMore && (
        <button
          className="button secondary"
          style={{ marginTop: '1rem' }}
          disabled={query.isFetching}
          onClick={() => setCursor(query.data?.next_before ?? undefined)}
        >
          {query.isFetching ? 'Loading…' : 'Load more'}
        </button>
      )}
    </main>
  );
}

function History({ location, customer }: { location: Location; customer?: Customer | null }) {
  if (customer) {
    return <CustomerOrderHistory key={location.id} location={location} />;
  }
  const orders = readOrders(customer);
  return (
    <main>
      <h1>Recent orders</h1>
      <p className="muted">Orders saved in this browser.</p>
      {!orders.length && <p>No recent orders here yet.</p>}
      <div className="history-list">
        {orders.map((stored) => (
          <HistoryItem key={stored.id} stored={stored} />
        ))}
      </div>
    </main>
  );
}
function HistoryItem({ stored }: { stored: StoredOrder }) {
  const query = useQuery({
    queryKey: ['history-order', stored.locationId, stored.id, stored.orderToken],
    queryFn: () =>
      apiFetch<OnlineOrderDetail>(onlineOrderPath(stored.locationId, stored.id, stored.orderToken)),
    retry: false,
  });
  return (
    <Link
      className="history-card"
      to={`/orders/${stored.id}${stored.orderToken ? `?token=${encodeURIComponent(stored.orderToken)}` : ''}`}
    >
      <strong>{query.data?.fulfillment.fulfillment_type ?? 'Order'}</strong>
      <span>
        {query.data ? query.data.order.status : query.isError ? 'Unavailable' : 'Loading…'}
      </span>
      <small>{new Date(stored.createdAt).toLocaleString()}</small>
      {query.data?.order.totals && (
        <div style={{ marginTop: '0.5rem' }}>
          <div>Total: {money(query.data.order.totals.total)}</div>
          {query.data.order.totals.delivery_fee > 0 && (
            <div className="muted"><small>Includes {money(query.data.order.totals.delivery_fee)} delivery fee</small></div>
          )}
        </div>
      )}
    </Link>
  );
}


type CustomerLoyaltyReward = {
  id: string;
  name: string;
  description: string | null;
  cost_in_points: number | null;
  cost_in_visits: number | null;
};
type CustomerLoyalty = { points_balance: number; total_visits: number; available_rewards: CustomerLoyaltyReward[] };
type LoyaltyTransaction = { id: string; points_delta: number; reason: string; created_at: string };

function LoyaltyScreen() {
  const account = useQuery({
    queryKey: ['customer-loyalty'],
    queryFn: () => apiFetch<CustomerLoyalty>(`/api/v1/customers/me/loyalty`),
  });

  const history = useQuery({
    queryKey: ['customer-loyalty-history'],
    queryFn: () => apiFetch<{ data: LoyaltyTransaction[] }>(`/api/v1/customers/me/loyalty/history`),
  });

  if (account.isPending || history.isPending) return <main className="narrow">Loading...</main>;
  if (account.isError) return <main className="narrow"><ErrorMessage error={account.error} /></main>;

  return (
    <main className="narrow">
      <h1>Your Loyalty Rewards</h1>
      <div className="panel" style={{ padding: '2rem', textAlign: 'center', background: '#f8f9fa', borderRadius: '8px', marginBottom: '2rem' }}>
        <h2>{account.data?.points_balance ?? 0} points</h2>
        <p className="muted">Total lifetime visits: {account.data?.total_visits ?? 0}</p>
      </div>

      <h3>Available Rewards</h3>
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {account.data?.available_rewards.map((r) => (
          <li key={r.id} style={{ padding: '1rem', borderBottom: '1px solid #eee', display: 'flex', justifyContent: 'space-between' }}>
            <div>
              <strong>{r.name}</strong>
              {r.description && <div className="muted"><small>{r.description}</small></div>}
            </div>
            <div>
              {r.cost_in_points ? <span>{r.cost_in_points} pts</span> : null}
              {r.cost_in_visits ? <span>{r.cost_in_visits} visits</span> : null}
            </div>
          </li>
        ))}
        {account.data?.available_rewards.length === 0 && <p className="muted">No rewards currently available.</p>}
      </ul>

      <h3 style={{ marginTop: '2rem' }}>Recent History</h3>
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {history.data?.data.map((tx) => (
          <li key={tx.id} style={{ padding: '1rem', borderBottom: '1px solid #eee' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <strong>{tx.points_delta > 0 ? '+' : ''}{tx.points_delta} pts</strong>
              <small className="muted">{new Date(tx.created_at).toLocaleDateString()}</small>
            </div>
            <div className="muted"><small>{tx.reason}</small></div>
          </li>
        ))}
        {history.data?.data.length === 0 && <p className="muted">No history yet.</p>}
      </ul>
    </main>
  );
}

function CustomerRoutes({ location }: { location: Location }) {
  const [cart, setCart] = useState<CartItem[]>([]);
  const session = useQuery({
    queryKey: ['customer-session'],
    queryFn: () =>
      apiFetch<Customer>(`/api/v1/organizations/${ORGANIZATION_ID}/customer-sessions/current`),
    enabled: Boolean(getCustomerToken()),
    retry: false,
  });
  const customer = session.data;
  const onSignOut = () => {
    clearCustomerToken();
    queryClient.removeQueries({ queryKey: ['customer-session'] });
  };
  return (
    <>
      <Header
        location={location}
        customer={customer}
        cartCount={cart.reduce((sum, item) => sum + item.quantity, 0)}
        onSignOut={onSignOut}
      />
      <Routes>
        <Route path="/" element={<Menu location={location} setCart={setCart} />} />
        <Route
          path="/loyalty"
          element={customer ? <LoyaltyScreen /> : <Navigate to="/login" />}
        />
        <Route
          path="/checkout"
          element={
            <Checkout location={location} cart={cart} setCart={setCart} customer={customer} />
          }
        />
        <Route
          path="/login"
          element={
            <AuthScreen
              mode="login"
              onAuthenticated={() =>
                queryClient.invalidateQueries({ queryKey: ['customer-session'] })
              }
            />
          }
        />
        <Route
          path="/register"
          element={
            <AuthScreen
              mode="register"
              onAuthenticated={() =>
                queryClient.invalidateQueries({ queryKey: ['customer-session'] })
              }
            />
          }
        />
        <Route
          path="/orders/:orderId"
          element={<OrderStatus location={location} customer={customer} />}
        />
                <Route path="/history" element={<History location={location} customer={customer} />} />
        <Route path="/reservations" element={<ReservationRequest location={location} customer={customer} />} />
        <Route path="/reservations/:id" element={<ReservationStatus location={location} customer={customer} />} />
      </Routes>
    </>
  );
}
export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <LocationGate>{(location) => <CustomerRoutes location={location} />}</LocationGate>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

const resHistoryKey = (customer?: Customer | null) => `customer-reservations:${ORGANIZATION_ID}:${customer?.id ?? 'guest'}`;

type StoredReservation = { id: string; locationId: string; guestToken: string | null; createdAt: string };

function storeReservation(res: StoredReservation, customer?: Customer | null) {
  let current: StoredReservation[] = [];
  try {
    current = JSON.parse(localStorage.getItem(resHistoryKey(customer)) ?? '[]');
  } catch {
    // ignore malformed localStorage state
  }
  current = current.filter((item) => item.id !== res.id);
  localStorage.setItem(resHistoryKey(customer), JSON.stringify([res, ...current].slice(0, 20)));
}

function readReservations(customer?: Customer | null) {
  try {
    return JSON.parse(localStorage.getItem(resHistoryKey(customer)) ?? '[]') as { id: string; locationId: string; guestToken: string | null; createdAt: string }[];
  } catch {
    return [];
  }
}

function ReservationRequest({ location, customer }: { location: Location; customer?: Customer | null }) {
  const navigate = useNavigate();
  const mutation = useMutation({
    mutationFn: (form: HTMLFormElement) => {
      const data = new FormData(form);
      const reqTime = data.get('reservation_time');
      const partySize = data.get('party_size');
      return apiFetch<{ reservation_id: string; guest_token: string | null }>(`/api/v1/locations/${location.id}/reservations/request`, {
        method: 'POST',
        body: JSON.stringify({
          reservation_time: reqTime ? new Date(String(reqTime)).toISOString() : null,
          party_size: Number(partySize),
          customer_name: String(data.get('customer_name')),
          customer_email: String(data.get('customer_email') || ''),
          customer_phone: String(data.get('customer_phone') || ''),
          special_requests: String(data.get('special_requests') || '')
        })
      });
    },
    onSuccess: (data) => {
      storeReservation({
        id: data.reservation_id,
        locationId: location.id,
        guestToken: data.guest_token,
        createdAt: new Date().toISOString()
      }, customer);
      navigate(`/reservations/${data.reservation_id}?token=${encodeURIComponent(data.guest_token || '')}`);
    }
  });

  return (
    <main className="narrow">
      <h1>Book a Table</h1>
      <p>Reserve a spot at {location.name}.</p>
      <form onSubmit={(e) => { e.preventDefault(); mutation.mutate(e.currentTarget); }}>
        <label>
          Name
          <input name="customer_name" required defaultValue={customer?.name || ''} />
        </label>
        <label>
          Email
          <input name="customer_email" type="email" defaultValue={customer?.email || ''} />
        </label>
        <label>
          Phone
          <input name="customer_phone" defaultValue={customer?.phone || ''} />
        </label>
        <label>
          Party Size
          <input name="party_size" type="number" min="1" required defaultValue="2" />
        </label>
        <label>
          Reservation Time
          <input name="reservation_time" type="datetime-local" required />
        </label>
        <label>
          Special Requests
          <textarea name="special_requests" />
        </label>
        {mutation.isError && <ErrorMessage error={mutation.error} />}
        <button className="primary" disabled={mutation.isPending}>Request Reservation</button>
      </form>
      
      <div style={{ marginTop: '2rem' }}>
        <h2>Your Recent Reservations</h2>
        <ul>
          {readReservations(customer).map(r => (
            <li key={r.id}>
              <Link to={`/reservations/${r.id}?token=${encodeURIComponent(r.guestToken || '')}`}>
                Reservation on {new Date(r.createdAt).toLocaleDateString()}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}

interface ReservationDetail {
  status: string;
  reservation_time: string;
  party_size: number;
  customer_name: string;
  version: number;
}

function ReservationStatus({ location, customer }: { location: Location; customer?: Customer | null }) {
  const { id } = useParams();
  const token = new URLSearchParams(window.location.search).get('token') || readReservations(customer).find(r => r.id === id)?.guestToken || null;
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: ['reservation', location.id, id, token],
    queryFn: () => apiFetch<ReservationDetail>(`/api/v1/locations/${location.id}/reservations/${id}${token ? `?guest_token=${encodeURIComponent(token)}` : ''}`),
    refetchInterval: 10000
  });

  const cancelMut = useMutation({
    mutationFn: (version: number) => {
      const payload: { guest_token?: string } = {};
      if (token && !customer) payload.guest_token = token;
      return apiFetch(`/api/v1/locations/${location.id}/reservations/${id}/cancel`, {
        method: 'POST',
        headers: { 'if-match': `"${version}"` },
        body: JSON.stringify(payload)
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['reservation', location.id, id, token] });
    }
  });

  if (query.isPending) return <main className="centered">Loading...</main>;
  if (query.isError) return <main className="centered"><ErrorMessage error={query.error} /></main>;

  const r = query.data;

  return (
    <main className="narrow confirmation">
      <p className="eyebrow">Reservation Status</p>
      <h1>{r.status}</h1>
      <p>Time: {new Date(r.reservation_time).toLocaleString()}</p>
      <p>Party of {r.party_size}</p>
      <p>Name: {r.customer_name}</p>
      {['REQUESTED', 'CONFIRMED'].includes(r.status) && (
        <button onClick={() => cancelMut.mutate(r.version)} disabled={cancelMut.isPending} style={{ marginTop: '1rem' }}>
          Cancel Reservation
        </button>
      )}
    </main>
  );
}
