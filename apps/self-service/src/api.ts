import type { components } from '@restaurant-suite/contracts';

export const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';
const GUEST_TOKEN_KEY = 'guest_session_token';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export type GuestSessionMintResponse = components['schemas']['GuestSessionMintResponse'];
export type Product = components['schemas']['Product'];
export type Category = components['schemas']['Category'];
export type GuestAddLinesRequest = components['schemas']['GuestAddLinesRequest'];
export type ServiceRequestType = components['schemas']['GuestServiceRequest']['request_type'];

export function getGuestToken() { return sessionStorage.getItem(GUEST_TOKEN_KEY); }
export function setGuestToken(token: string) { sessionStorage.setItem(GUEST_TOKEN_KEY, token); }
export function clearGuestToken() { sessionStorage.removeItem(GUEST_TOKEN_KEY); }

export async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  const token = getGuestToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, { ...options, headers });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Unable to reach the restaurant.');
  }
  if (!response.ok) {
    let error = { code: 'UNKNOWN_ERROR', message: response.statusText, details: undefined as unknown };
    try {
      const body = await response.json() as { error?: { code?: string; message?: string; details?: unknown } };
      error = { code: body.error?.code ?? error.code, message: body.error?.message ?? error.message, details: body.error?.details };
    } catch { /* retain HTTP fallback */ }
    if (response.status === 401) clearGuestToken();
    throw new ApiError(response.status, error.code, error.message, error.details);
  }
  return response.json() as Promise<T>;
}
