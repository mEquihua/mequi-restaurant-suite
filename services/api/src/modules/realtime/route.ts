import type { FastifyPluginAsync } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { withAuthenticatedSession } from '../identity/index.js';
import { Redis } from 'ioredis';
import type { WebSocket } from 'ws';

// We use a shared redis subscriber per API instance to avoid one connection per websocket client.
let redisSubscriber: Redis | null = null;
const clientMap = new Map<string, Set<WebSocket>>(); // locationId -> Set of websocket connections

// Browsers cannot set custom headers (e.g. Authorization) on a WebSocket
// handshake request, so browser clients pass the session token as a
// subprotocol instead: `new WebSocket(url, ['Bearer', token])`, which the
// browser sends as `Sec-WebSocket-Protocol: Bearer, <token>`. `handleProtocols`
// must echo back one of the offered protocols, or per RFC 6455 the browser
// fails the connection even though the server otherwise accepted it.
function extractBearerFromProtocol(secWebSocketProtocol: string | undefined): string | undefined {
  if (!secWebSocketProtocol) return undefined;
  const parts = secWebSocketProtocol.split(',').map((p) => p.trim());
  if (parts.length === 2 && parts[0] === 'Bearer' && parts[1]) return parts[1];
  return undefined;
}

export const realtimeRoute: FastifyPluginAsync = async (app) => {
  await app.register(fastifyWebsocket, {
    options: {
      handleProtocols: (protocols) => (protocols.has('Bearer') ? 'Bearer' : false),
    },
  });

  // Initialize redis subscriber lazily or on route load.
  const redisUrl = process.env.VALKEY_URL || process.env.REDIS_URL || 'redis://valkey:6379';
  redisSubscriber = new Redis(redisUrl);

  // We use pattern subscribe to listen to all location events: location:*:events
  // This keeps the implementation simpler than dynamic subscriptions per client connection.
  await redisSubscriber.psubscribe('location:*:events');

  redisSubscriber.on('pmessage', (pattern: string, channel: string, message: string) => {
    // Channel is like "location:{location_id}:events"
    const match = /^location:([^:]+):events$/.exec(channel);
    if (!match) return;
    const locationId = match[1];

    const clients = clientMap.get(locationId);
    if (clients) {
      for (const socket of clients) {
        socket.send(message);
      }
    }
  });

  app.addHook('onClose', async () => {
    if (redisSubscriber) {
      await redisSubscriber.quit();
    }
  });

  app.get('/api/v1/realtime', { websocket: true }, (connection, req) => {
    // A real browser cannot send an Authorization header on the WebSocket
    // handshake; fall back to the Sec-WebSocket-Protocol-carried token so
    // withAuthenticatedSession's existing bearerToken() lookup picks it up
    // unchanged. Non-browser clients (tests, other services) may still use
    // a real Authorization header.
    if (!req.headers.authorization) {
      const token = extractBearerFromProtocol(req.headers['sec-websocket-protocol']);
      if (token) req.headers.authorization = `Bearer ${token}`;
    }
    // Authenticate the session
    // We execute withAuthenticatedSession just to get the session info and then return immediately
    // so we don't hold open the database transaction for the duration of the websocket connection.
    withAuthenticatedSession(app, req, new Date(), 24 * 60 * 60 * 1000, async (session) => {
      return session.locationId;
    }).then(locationId => {
      // Add client to the map for this location
      let clients = clientMap.get(locationId);
      if (!clients) {
        clients = new Set();
        clientMap.set(locationId, clients);
      }
      clients.add(connection);

      connection.on('close', () => {
        const set = clientMap.get(locationId);
        if (set) {
          set.delete(connection);
          if (set.size === 0) {
            clientMap.delete(locationId);
          }
        }
      });
      
      // Note: Do not attempt to replay missed events to a reconnecting client from Valkey 
      // (it has no durability) — that is what the existing REST endpoints are for.
    }).catch(err => {
      // Unauthorized or invalid session
      req.log.info({ err }, 'WebSocket authentication failed');
      connection.close(1008, 'Unauthorized');
    });
  });
};
