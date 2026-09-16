import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { BASE_URL, getSessionToken } from './api.js';

export function useRealtime(locationId: string) {
  const queryClient = useQueryClient();
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const backoffRef = useRef(1000);

  useEffect(() => {
    if (!locationId) return;

    let isMounted = true;

    function connect() {
      if (!isMounted) return;

      const wsUrl = BASE_URL.replace(/^http/, 'ws') + '/api/v1/realtime';
      const token = getSessionToken();
      
      // Note: Browsers do not support custom headers in WebSocket. 
      // We pass the token as a subprotocol as a best-effort, but if the backend only 
      // checks the Authorization header, this will fail and needs a backend fix.
      const protocols = token ? ['Bearer', token] : undefined;
      const ws = new WebSocket(wsUrl, protocols);

      ws.onopen = () => {
        backoffRef.current = 1000;
        // Invalidate once immediately on reconnect
        queryClient.invalidateQueries();
      };

      ws.onmessage = () => {
        // Any message invalidates the relevant queries
        queryClient.invalidateQueries({ queryKey: ['tables', locationId] });
        queryClient.invalidateQueries({ queryKey: ['visits', locationId] });
      };

      ws.onclose = () => {
        if (!isMounted) return;
        const delay = backoffRef.current;
        backoffRef.current = Math.min(delay * 2, 30000); // cap at 30s
        reconnectTimeoutRef.current = window.setTimeout(connect, delay);
      };

      wsRef.current = ws;
    }

    connect();

    return () => {
      isMounted = false;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [locationId, queryClient]);
}
