import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { BASE_URL, getGuestToken } from './api.js';

export function useGuestRealtime(locationId: string) {
  const client = useQueryClient();
  const [connected, setConnected] = useState(false);
  const socket = useRef<WebSocket | null>(null);
  const timeout = useRef<number | null>(null);
  const backoff = useRef(1000);
  useEffect(() => {
    if (!locationId) return;
    let active = true;
    const connect = () => {
      if (!active) return;
      const token = getGuestToken();
      socket.current = new WebSocket(
        `${BASE_URL.replace(/^http/, 'ws')}/api/v1/realtime`,
        token ? ['Bearer', token] : undefined,
      );
      socket.current.onopen = () => {
        if (active) {
          setConnected(true);
          backoff.current = 1000;
          client.invalidateQueries({ queryKey: ['guest-order', locationId] });
        }
      };
      socket.current.onmessage = () => {
        client.invalidateQueries({ queryKey: ['guest-order', locationId] });
      };
      socket.current.onclose = () => {
        if (!active) return;
        setConnected(false);
        const delay = backoff.current;
        backoff.current = Math.min(delay * 2, 30000);
        timeout.current = window.setTimeout(connect, delay);
      };
    };
    connect();
    return () => {
      active = false;
      if (timeout.current) clearTimeout(timeout.current);
      socket.current?.close();
    };
  }, [client, locationId]);
  return connected;
}
