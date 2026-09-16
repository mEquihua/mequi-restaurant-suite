import { createHash, randomBytes } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Guest tokens deliberately have their own wire format; never probe staff_sessions. */
export function createGuestSessionToken(locationId: string): string {
  return `guest.${locationId}.${randomBytes(32).toString('base64url')}`;
}

export function parseGuestSessionToken(value: string | undefined): { locationId: string; token: string } | undefined {
  if (!value) return undefined;
  const [kind, locationId, secret, ...rest] = value.split('.');
  if (kind !== 'guest' || !locationId || !secret || rest.length > 0 || !UUID.test(locationId) || secret.length < 32) return undefined;
  return { locationId, token: value };
}

export function hashGuestSecret(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
