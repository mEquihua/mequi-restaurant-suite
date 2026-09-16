import type { components } from '@restaurant-suite/contracts';

export const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';
export const ORGANIZATION_ID = import.meta.env.VITE_ORGANIZATION_ID || '';
export const LOCATION_HOURS =
  import.meta.env.VITE_LOCATION_HOURS || 'Contact the location for current hours.';
const CUSTOMER_TOKEN_KEY = 'customer_session_token';

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

export type Category = components['schemas']['Category'];
export type Customer = components['schemas']['Customer'];
export type Location = components['schemas']['Location'];
export type OnlineCheckoutRequest = components['schemas']['OnlineCheckoutRequest'];
export type OnlineCheckoutResponse = components['schemas']['OnlineCheckoutResponse'];
export type OnlineOrderDetail = components['schemas']['OnlineOrderDetailResponse'];
export type OnlineOrderListItem = components['schemas']['OnlineOrderListItem'];
export type OnlineOrderListResponse = components['schemas']['OnlineOrderListResponse'];
export type Product = components['schemas']['Product'];

export function getCustomerToken() {
  return sessionStorage.getItem(CUSTOMER_TOKEN_KEY);
}
export function setCustomerToken(token: string) {
  sessionStorage.setItem(CUSTOMER_TOKEN_KEY, token);
}
export function clearCustomerToken() {
  sessionStorage.removeItem(CUSTOMER_TOKEN_KEY);
}

export async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  const token = getCustomerToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, { ...options, headers });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Unable to reach the restaurant.');
  }
  if (!response.ok) {
    let error = {
      code: 'UNKNOWN_ERROR',
      message: response.statusText,
      details: undefined as unknown,
    };
    try {
      const body = (await response.json()) as {
        error?: { code?: string; message?: string; details?: unknown };
      };
      error = {
        code: body.error?.code ?? error.code,
        message: body.error?.message ?? error.message,
        details: body.error?.details,
      };
    } catch {
      // Keep the HTTP fallback if the response is not JSON.
    }
    if (response.status === 401) clearCustomerToken();
    throw new ApiError(response.status, error.code, error.message, error.details);
  }
  return response.json() as Promise<T>;
}
