export const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown, public request_id?: string) {
    super(message); this.name = 'ApiError';
  }
}

export const getSessionToken = () => sessionStorage.getItem('session_token');
export const setSessionToken = (token: string) => sessionStorage.setItem('session_token', token);
export const clearSessionToken = () => sessionStorage.removeItem('session_token');
export function getTerminalCredential(): { terminal_id: string; secret: string } | null {
  const value = localStorage.getItem('terminal_credential');
  try { return value ? JSON.parse(value) : null; } catch { return null; }
}
export const setTerminalCredential = (credential: { terminal_id: string; secret: string }) => localStorage.setItem('terminal_credential', JSON.stringify(credential));

export async function apiFetch<T>(path: string, options: RequestInit & { ifMatch?: string | number } = {}): Promise<T> {
  const headers = new Headers(options.headers);
  const token = getSessionToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (options.ifMatch !== undefined) headers.set('If-Match', String(options.ifMatch));
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(`${BASE_URL}${path}`, { ...options, headers });
  if (!response.ok) {
    if (response.status === 401) { clearSessionToken(); window.dispatchEvent(new Event('auth:unauthorized')); }
    let error = { code: 'network_error', message: response.statusText, details: undefined as unknown, request_id: undefined as string | undefined };
    try { const body = await response.json(); error = body.error ?? error; } catch { /* non-JSON error */ }
    throw new ApiError(response.status, error.code, error.message, error.details, error.request_id);
  }
  return response.status === 204 ? ({} as T) : response.json() as Promise<T>;
}
