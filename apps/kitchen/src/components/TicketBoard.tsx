import React, { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError } from '../api.js';
import { useRealtime } from '../realtime.js';

import { tokens } from '@restaurant-suite/ui-tokens';

interface OrderLine {
  id: string;
  order_id: string;
  visit_id: string;
  table_id: string | null;
  product_id: string;
  quantity: number;
  status: 'DRAFT' | 'HELD' | 'SENT' | 'PREPARING' | 'READY' | 'FULFILLED' | 'CANCELLED' | 'VOIDED';
  version: number;
  order_created_at: string;
  updated_at: string;
  modifiers: { modifier_id: string }[];
}

interface Product {
  id: string;
  category_id: string | null;
  name: string;
  allergens: string[];
  tags: string[];
  availability: { status: string, available: boolean };
  modifier_groups: { modifiers: { id: string; name: string }[] }[];
}

const STATION_OPTIONS = [
  { id: 'all', label: 'All Kitchen', tags: [] },
  { id: 'grill', label: 'Grill', tags: ['grill'] },
  { id: 'fry', label: 'Fry', tags: ['fry'] },
  { id: 'cold', label: 'Cold', tags: ['cold'] },
  { id: 'bar', label: 'Bar', tags: ['bar'] },
  { id: 'dessert', label: 'Dessert', tags: ['dessert'] },
];

export function TicketBoard({
  locationId,
  terminalProfile,
}: {
  locationId: string;
  terminalProfile: { app_target: string | null; profile_config: unknown | null };
}) {
  const isConnected = useRealtime(locationId);
  const queryClient = useQueryClient();

  const [stationId, setStationId] = useState<string>(() => {
    return localStorage.getItem('kitchen_station') || 'all';
  });
  
  const [printingTicket, setPrintingTicket] = useState<{tableId: string, lines: OrderLine[]} | null>(null);

  useEffect(() => {
    localStorage.setItem('kitchen_station', stationId);
  }, [stationId]);
  
  useEffect(() => {
    if (printingTicket) {
      setTimeout(() => {
        window.print();
        setPrintingTicket(null);
      }, 100);
    }
  }, [printingTicket]);

  const { data: linesData, error: linesError, isError: isLinesError } = useQuery<{ data: OrderLine[] }>({
    queryKey: ['order-lines', locationId],
    queryFn: () => apiFetch(`/api/v1/locations/${locationId}/order-lines?status=HELD,SENT,PREPARING,READY`),
    refetchInterval: 10000,
  });

  const { data: productsData } = useQuery<{ data: Product[] }>({
    queryKey: ['products'],
    queryFn: () => apiFetch('/api/v1/products'),
  });

  const products = productsData?.data || [];
  const productsById = new Map(products.map(p => [p.id, p]));
  const modifierNamesById = new Map<string, string>();
  for (const p of products) {
    for (const group of p.modifier_groups) {
      for (const modifier of group.modifiers) {
        modifierNamesById.set(modifier.id, modifier.name);
      }
    }
  }

  const currentStation = STATION_OPTIONS.find(s => s.id === stationId) || STATION_OPTIONS[0];
  const categoryIds =
    terminalProfile.app_target === 'KITCHEN' &&
    typeof terminalProfile.profile_config === 'object' &&
    terminalProfile.profile_config !== null &&
    !Array.isArray(terminalProfile.profile_config) &&
    (terminalProfile.profile_config as { scope?: unknown }).scope === 'CATEGORY' &&
    Array.isArray((terminalProfile.profile_config as { category_ids?: unknown }).category_ids)
      ? new Set(
          (terminalProfile.profile_config as { category_ids: unknown[] }).category_ids.filter(
            (id): id is string => typeof id === 'string',
          ),
        )
      : undefined;
  const hasCategoryProfile = categoryIds !== undefined;

  // Filtering lines based on station tags
  const filteredLines = (linesData?.data || []).filter(line => {
    if (categoryIds) return categoryIds.has(productsById.get(line.product_id)?.category_id ?? '');
    if (currentStation.id === 'all') return true;
    const p = productsById.get(line.product_id);
    if (!p) return false;
    return p.tags.some(t => currentStation.tags.includes(t));
  });

  const updateLineStatus = useMutation({
    mutationFn: async ({ lineId, status, version }: { lineId: string, status: string, version: number }) => {
      let action = '';
      if (status === 'PREPARING') action = 'mark-preparing';
      if (status === 'READY') action = 'mark-ready';
      if (status === 'FULFILLED') action = 'mark-fulfilled';
      return apiFetch(`/api/v1/locations/${locationId}/order-lines/${lineId}/${action}`, {
        method: 'POST',
        ifMatch: version.toString(),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['order-lines', locationId] });
    }
  });

  const markUnavailable = useMutation({
    mutationFn: async (productId: string) => {
      // A product's first-ever availability rule for this location must be
      // created with If-Match: 0 (see menu module's changeAvailability); once
      // it exists, mark-unavailable/mark-available cycles bump its version,
      // so a repeat 86 on the same product must read the current version off
      // the resulting 409 and retry, or it never succeeds a second time.
      try {
        return await apiFetch(`/api/v1/locations/${locationId}/products/${productId}/mark-unavailable`, {
          method: 'POST',
          ifMatch: '0',
          body: JSON.stringify({ status: 'EXHAUSTED' })
        });
      } catch (e) {
        if (e instanceof ApiError && e.status === 409 && typeof e.details === 'object' && e.details !== null && 'current_version' in e.details) {
          const currentVersion = (e.details as { current_version: number }).current_version;
          return apiFetch(`/api/v1/locations/${locationId}/products/${productId}/mark-unavailable`, {
            method: 'POST',
            ifMatch: String(currentVersion),
            body: JSON.stringify({ status: 'EXHAUSTED' })
          });
        }
        throw e;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['products'] });
    }
  });

  if (isLinesError) {
    return (
      <div style={{ padding: '2rem', background: '#fee', color: '#c00' }}>
        <h2>Connection Error</h2>
        <p>Could not fetch live tickets. {linesError?.message}</p>
        <button onClick={() => queryClient.invalidateQueries()}>Retry</button>
      </div>
    );
  }

  const ticketsByOrder = new Map<string, OrderLine[]>();
  for (const line of filteredLines) {
    const arr = ticketsByOrder.get(line.order_id) || [];
    arr.push(line);
    ticketsByOrder.set(line.order_id, arr);
  }

  // All Day
  const allDayCounts = new Map<string, number>();
  for (const line of filteredLines) {
    if (['SENT', 'PREPARING'].includes(line.status)) {
      allDayCounts.set(line.product_id, (allDayCounts.get(line.product_id) || 0) + line.quantity);
    }
  }

  return (
    <div style={{ fontFamily: tokens.font.sans, display: 'flex', flexDirection: 'column', height: '100vh', backgroundColor: '#f5f5f5' }}>
      <header style={{ padding: '1rem', background: '#fff', borderBottom: '1px solid #ccc', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ margin: 0, fontSize: '1.5rem' }}>Kitchen Display</h1>
        {!isConnected && <div style={{ background: '#d32f2f', color: 'white', padding: '0.5rem 1rem', borderRadius: '4px', fontWeight: 'bold' }}>OFFLINE / STALE DATA</div>}
        
        {!hasCategoryProfile && (
          <select
            value={stationId}
            onChange={e => setStationId(e.target.value)}
            style={{ padding: '0.5rem', fontSize: '1.25rem' }}
          >
            {STATION_OPTIONS.map(s => (
              <option key={s.id} value={s.id}>{s.label}</option>
            ))}
          </select>
        )}
      </header>

      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <main style={{ flex: 1, padding: '1rem', overflowX: 'auto', display: 'flex', gap: '1rem' }}>
          {Array.from(ticketsByOrder.entries()).map(([orderId, lines]) => {
            return (
              <TicketCard
                key={orderId}

                lines={lines}
                productsById={productsById}
                modifierNamesById={modifierNamesById}
                onUpdateStatus={(lineId, status, version) => updateLineStatus.mutate({ lineId, status, version })}
                onMarkUnavailable={(productId) => {
                  if (confirm('Mark this product as out of stock?')) {
                    markUnavailable.mutate(productId);
                  }
                }}
                setPrintingTicket={setPrintingTicket}
              />
            );
          })}
        </main>
        
        <aside style={{ width: '300px', background: '#fff', borderLeft: '1px solid #ccc', padding: '1rem', overflowY: 'auto' }}>
          <h2>All Day</h2>
          <ul style={{ listStyle: 'none', padding: 0 }}>
            {Array.from(allDayCounts.entries()).map(([productId, count]) => {
              const p = productsById.get(productId);
              if (!p) return null;
              return (
                <li key={productId} style={{ padding: '0.5rem 0', borderBottom: '1px solid #eee', fontSize: '1.25rem' }}>
                  <strong>{count} ×</strong> {p.name}
                </li>
              );
            })}
          </ul>
        </aside>
      </div>

      {printingTicket && (
        <div className="print-template" style={{ display: 'none' }}>
          <h2 style={{ margin: '0 0 10px 0', fontSize: '1.5rem', textAlign: 'center' }}>
            {printingTicket.tableId === 'Takeout/Other' ? 'Takeout' : `Table ${printingTicket.tableId.slice(0,4)}`}
          </h2>
          <div style={{ borderTop: '1px solid black', margin: '10px 0' }}></div>
          {printingTicket.lines.map(line => (
            <div key={line.id} style={{ marginBottom: '5px', fontSize: '1.2rem' }}>
              <strong>{line.quantity} ×</strong> {productsById.get(line.product_id)?.name || 'Unknown'}
              {line.modifiers && line.modifiers.map(m => (
                <div key={m.modifier_id} style={{ marginLeft: '1rem', fontSize: '1rem' }}>
                  + {modifierNamesById.get(m.modifier_id) || 'Unknown'}
                </div>
              ))}
            </div>
          ))}
          <div style={{ borderTop: '1px solid black', margin: '10px 0' }}></div>
          <div style={{ textAlign: 'center', fontSize: '0.8rem' }}>
            {new Date().toLocaleString()}
          </div>
        </div>
      )}
    </div>
  );
}

function useCurrentTime() {
  const [now, setNow] = React.useState(new Date());
  React.useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 10000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function TicketCard({
  lines,
  productsById,
  modifierNamesById,
  onUpdateStatus,
  onMarkUnavailable,
  setPrintingTicket,
}: {
  lines: OrderLine[];
  productsById: Map<string, { name: string; allergens: string[] | null }>;
  modifierNamesById: Map<string, string>;
  onUpdateStatus: (lineId: string, status: string, version: number) => void;
  onMarkUnavailable: (productId: string) => void;
  setPrintingTicket: (ticket: { tableId: string, lines: OrderLine[] } | null) => void;
}) {
  const tableId = lines[0]?.table_id || 'Takeout/Other';
  // updated_at reflects the last status transition; for a line still sitting
  // in SENT it equals the actual send time (order_created_at is the same for
  // every line in the order regardless of when each was individually fired,
  // which would make every line on a multi-round ticket look equally fresh
  // or equally late).
  const sentAt = new Date(Math.min(...lines.map(l => new Date(l.updated_at).getTime())));
  const now = useCurrentTime();
  const elapsedMinutes = Math.floor((now.getTime() - sentAt.getTime()) / 60000);
  
  let timeColor = '#333';
  if (elapsedMinutes >= 15) timeColor = '#d32f2f'; // Late
  else if (elapsedMinutes >= 10) timeColor = '#f57c00'; // Approaching

  const isHeld = lines.every(l => l.status === 'HELD');
  const isReady = lines.every(l => l.status === 'READY');

  return (
    <div style={{ 
      minWidth: '320px', 
      background: isHeld ? '#eee' : '#fff', 
      border: `2px solid ${isReady ? '#4caf50' : '#ccc'}`,
      borderRadius: '8px',
      display: 'flex',
      flexDirection: 'column'
    }}>
      <div style={{ padding: '1rem', borderBottom: '1px solid #ccc', background: isReady ? '#e8f5e9' : 'transparent' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ margin: 0, fontSize: '2rem' }}>{tableId === 'Takeout/Other' ? 'Takeout' : `Table ${tableId.slice(0,4)}`}</h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
            <span style={{ fontSize: '1.5rem', fontWeight: 'bold', color: timeColor }}>
              {elapsedMinutes}m {elapsedMinutes >= 15 ? '(LATE)' : ''}
            </span>
            <button onClick={() => setPrintingTicket({ tableId, lines })} style={{ padding: '0.5rem', background: '#e0e0e0', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>Print</button>
          </div>
        </div>
        {isHeld && <div style={{ color: '#666', fontWeight: 'bold', marginTop: '0.5rem' }}>HELD</div>}
      </div>

      <div style={{ padding: '1rem', flex: 1, overflowY: 'auto' }}>
        {lines.map(line => {
          const product = productsById.get(line.product_id);
          const hasAllergens = product?.allergens && product.allergens.length > 0;
          return (
            <div key={line.id} style={{ 
              marginBottom: '1rem', 
              padding: '0.5rem',
              background: line.status === 'READY' ? '#e8f5e9' : 'transparent',
              textDecoration: line.status === 'READY' ? 'line-through' : 'none',
              borderLeft: hasAllergens ? '4px solid #d32f2f' : 'none'
            }}>
              <div style={{ fontSize: '1.5rem', display: 'flex', justifyContent: 'space-between' }}>
                <span><strong>{line.quantity} ×</strong> {product?.name || 'Unknown'}</span>
              </div>
              
              {hasAllergens && (
                <div style={{ color: '#d32f2f', fontWeight: 'bold', marginTop: '0.25rem' }}>
                  ALLERGY: {(product?.allergens || []).join(', ')}
                </div>
              )}
              
              {line.modifiers.length > 0 && (
                <ul style={{ margin: '0.25rem 0 0 1.5rem', color: '#555' }}>
                  {line.modifiers.map(m => (
                    <li key={m.modifier_id}>{modifierNamesById.get(m.modifier_id) || 'Modifier'}</li>
                  ))}
                </ul>
              )}

              <div style={{ marginTop: '0.5rem', display: 'flex', gap: '0.5rem' }}>
                {line.status === 'SENT' && (
                  <button onClick={() => onUpdateStatus(line.id, 'PREPARING', line.version)} style={{ padding: '0.5rem 1rem' }}>Prepare</button>
                )}
                {line.status === 'PREPARING' && (
                  <button onClick={() => onUpdateStatus(line.id, 'READY', line.version)} style={{ padding: '0.5rem 1rem', background: '#4caf50', color: 'white' }}>Ready</button>
                )}
                {line.status === 'READY' && (
                  <button onClick={() => onUpdateStatus(line.id, 'PREPARING', line.version)} style={{ padding: '0.5rem 1rem' }}>Recall</button>
                )}
                <button onClick={() => onMarkUnavailable(line.product_id)} style={{ padding: '0.5rem', fontSize: '0.8rem' }}>86 (Out)</button>
              </div>
            </div>
          );
        })}
      </div>
      
      <div style={{ padding: '1rem', borderTop: '1px solid #ccc' }}>
        {!isReady && (
          <button 
            style={{ width: '100%', padding: '1rem', fontSize: '1.25rem', background: '#2196f3', color: 'white', border: 'none', borderRadius: '4px' }}
            onClick={() => {
              lines.forEach(line => {
                if (line.status !== 'READY') onUpdateStatus(line.id, 'READY', line.version);
              });
            }}
          >
            Mark Ticket Ready
          </button>
        )}
      </div>
    </div>
  );
}
