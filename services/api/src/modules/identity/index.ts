import type { FastifyPluginAsync } from 'fastify';

import { identityRoute, type IdentityRouteOptions } from './route.js';

export { IdentityHttpError, requirePermission, withAuthenticatedSession } from './authentication.js';
export type { AuthenticatedSession } from './authentication.js';
export {
  lockPinAttempt,
  recordFailedPinAttempt,
  resetPinAttempt,
  findStaff,
} from './persistence/repository.js';
export {
  verifyPin,
  fingerprintPresentedCredential,
  retryAfterSeconds,
  nextFailedPinAttempt,
} from './security.js';
export { DUMMY_PIN_HASH } from './route.js';

/** Public identity module entry point. Other modules may import only from this file. */
export const identityModule: FastifyPluginAsync<IdentityRouteOptions> = async (app, options) => {
  await app.register(identityRoute, options);
};

export type { IdentityRouteOptions } from './route.js';
