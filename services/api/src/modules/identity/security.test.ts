import { describe, expect, it } from 'vitest';

import { hashPin, nextFailedPinAttempt, retryAfterSeconds, verifyPin } from './security.js';

describe('PIN verification', () => {
  it('uses Argon2id hashes and rejects an incorrect PIN', async () => {
    const hash = await hashPin('2468');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    await expect(verifyPin(hash, '2468')).resolves.toBe(true);
    await expect(verifyPin(hash, '0000')).resolves.toBe(false);
  });
});

describe('per-terminal PIN backoff', () => {
  it('escalates only the attempt state for the presented terminal and credential', () => {
    const now = new Date('2026-09-15T12:00:00.000Z');
    const first = nextFailedPinAttempt({ failureCount: 0, nextAttemptAt: null }, now);
    const second = nextFailedPinAttempt(first, now);

    expect(first.failureCount).toBe(1);
    expect(retryAfterSeconds(first, now)).toBe(1);
    expect(second.failureCount).toBe(2);
    expect(retryAfterSeconds(second, now)).toBe(2);
    expect(retryAfterSeconds({ failureCount: 0, nextAttemptAt: null }, now)).toBeUndefined();
  });
});
