import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { BASE_URL, getSessionToken } from './api.js';

/** Realtime is intentionally only a refetch signal; REST remains authoritative. */
export function useRealtime(locationId: string) {
  const client = useQueryClient(); const timer = useRef<number | null>(null); const socket = useRef<WebSocket | null>(null); const backoff = useRef(1000);
  useEffect(() => {
    if (!locationId) return; let live = true;
    const connect = () => {
      const token = getSessionToken();
      // Browsers cannot set Authorization on WebSocket; API accepts this subprotocol workaround.
      const ws = new WebSocket(`${BASE_URL.replace(/^http/, 'ws')}/api/v1/realtime`, token ? ['Bearer', token] : undefined);
      socket.current = ws;
      ws.onopen = () => { backoff.current = 1000; void client.invalidateQueries(); };
      ws.onmessage = () => void client.invalidateQueries();
      ws.onclose = () => { if (live) { const delay = backoff.current; backoff.current = Math.min(delay * 2, 30_000); timer.current = window.setTimeout(connect, delay); } };
    }; connect();
    return () => { live = false; if (timer.current) clearTimeout(timer.current); socket.current?.close(); };
  }, [locationId, client]);
}
