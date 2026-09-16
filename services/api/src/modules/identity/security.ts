import argon2 from 'argon2';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BACKOFF_MS = 5 * 60 * 1000;
const BASE_BACKOFF_MS = 1000;

export const pinHashOptions = {
  type: argon2.argon2id,
  memoryCost: 19 * 1024,
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPin(pin: string): Promise<string> {
  return argon2.hash(pin, pinHashOptions);
}

export async function verifyPin(pinHash: string, pin: string): Promise<boolean> {
  try {
    return await argon2.verify(pinHash, pin);
  } catch {
    return false;
  }
}

export function generateSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export function secretMatchesHash(secret: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashSecret(secret), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function fingerprintPresentedCredential(credential: string): string {
  return hashSecret(credential);
}

/** Routing prefixes are public metadata; only the random suffix is a bearer secret. */
export function createTerminalCredential(locationId: string, terminalId: string): string {
  return `${locationId}.${terminalId}.${generateSecret()}`;
}

export function parseTerminalCredential(value: string | undefined):
  | { locationId: string; terminalId: string; credential: string }
  | undefined {
  if (!value) return undefined;
  const [locationId, terminalId, secret, ...rest] = value.split('.');
  if (!locationId || !terminalId || !secret || rest.length > 0 || !UUID.test(locationId) || !UUID.test(terminalId) || secret.length < 32) {
    return undefined;
  }
  return { locationId, terminalId, credential: value };
}

export function createSessionToken(locationId: string): string {
  return `${locationId}.${generateSecret()}`;
}

export function parseSessionToken(value: string | undefined): { locationId: string; token: string } | undefined {
  if (!value) return undefined;
  const [locationId, secret, ...rest] = value.split('.');
  if (!locationId || !secret || rest.length > 0 || !UUID.test(locationId) || secret.length < 32) return undefined;
  return { locationId, token: value };
}

export interface PinAttemptState {
  failureCount: number;
  nextAttemptAt: Date | null;
}

export function retryAfterSeconds(state: PinAttemptState, now: Date): number | undefined {
  if (!state.nextAttemptAt || state.nextAttemptAt <= now) return undefined;
  return Math.ceil((state.nextAttemptAt.getTime() - now.getTime()) / 1000);
}

export function nextFailedPinAttempt(state: PinAttemptState, now: Date): PinAttemptState {
  const failureCount = state.failureCount + 1;
  const delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (failureCount - 1));
  return { failureCount, nextAttemptAt: new Date(now.getTime() + delay) };
}

/**
 * Mirrors the default permission matrix in docs/architecture/permission-catalog.md section 4
 * exactly. Update both together if the catalog changes.
 */
const OWNER_AND_MANAGER_PERMISSIONS: readonly string[] = [
  'iam.terminals.enroll', 'iam.terminals.read', 'iam.staff.read', 'iam.staff.create', 'iam.staff.update', 'iam.roles.read', 'iam.roles.update',
  'menu.catalog.read', 'menu.products.write', 'menu.prices.update', 'menu.availability.update',
  'floor.layout.read', 'floor.layout.write', 'floor.tables.update_status', 'floor.sections.assign',
  'module_center.modules.read', 'module_center.modules.write',
  'orders.visits.create', 'orders.visits.close', 'orders.visits.read_all', 'orders.visits.transfer',
  'orders.orders.create', 'orders.lines.add', 'orders.lines.hold', 'orders.lines.send', 'orders.lines.void', 'orders.lines.void_override',
  'orders.orders.cancel', 'orders.orders.cancel_override',
  'accounts.accounts.create', 'accounts.accounts.split', 'accounts.accounts.reopen', 'accounts.discounts.apply', 'accounts.discounts.apply_override',
  'payments.payments.create', 'payments.refunds.create', 'payments.refunds.override', 'payments.cash.open_drawer', 'payments.cash.reconcile',
  'kitchen.tickets.read', 'kitchen.tickets.update_status',
  'reports.sales.read', 'reports.audit.read',
];

export const SYSTEM_ROLE_TEMPLATES: ReadonlyArray<{ name: string; description: string; permissions: readonly string[] }> = [
  { name: 'Owner', description: 'Full installation administration.', permissions: OWNER_AND_MANAGER_PERMISSIONS },
  { name: 'Manager', description: 'Restaurant operations management.', permissions: OWNER_AND_MANAGER_PERMISSIONS },
  {
    name: 'Waiter',
    description: 'Table service operations.',
    permissions: [
      'menu.catalog.read', 'floor.layout.read', 'floor.tables.update_status',
      'orders.visits.create', 'orders.visits.close', 'orders.visits.transfer',
      'orders.orders.create', 'orders.lines.add', 'orders.lines.hold', 'orders.lines.send', 'orders.lines.void', 'orders.orders.cancel',
      'accounts.accounts.create', 'accounts.accounts.split', 'accounts.discounts.apply', 'payments.payments.create',
    ],
  },
  {
    name: 'Cashier',
    description: 'Checkout operations.',
    permissions: [
      'menu.catalog.read', 'floor.layout.read', 'floor.tables.update_status',
      'orders.visits.create', 'orders.visits.close', 'orders.visits.read_all', 'orders.visits.transfer',
      'orders.orders.create', 'orders.lines.add', 'orders.lines.hold', 'orders.lines.send', 'orders.lines.void', 'orders.orders.cancel',
      'accounts.accounts.create', 'accounts.accounts.split', 'accounts.accounts.reopen', 'accounts.discounts.apply',
      'payments.payments.create', 'payments.refunds.create', 'payments.cash.open_drawer', 'payments.cash.reconcile', 'reports.sales.read',
    ],
  },
  {
    name: 'Host',
    description: 'Guest arrival and seating operations.',
    permissions: ['menu.catalog.read', 'floor.layout.read', 'floor.tables.update_status', 'floor.sections.assign', 'orders.visits.create', 'orders.visits.close', 'orders.visits.read_all'],
  },
  {
    name: 'Kitchen',
    description: 'Kitchen display operations.',
    permissions: ['menu.catalog.read', 'menu.availability.update', 'kitchen.tickets.read', 'kitchen.tickets.update_status'],
  },
];

export function isPermissionName(value: string): boolean {
  return /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(value);
}
