export const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

export class ApiError extends Error {
  public status: number;
  public code: string;
  public details?: unknown;
  public request_id?: string;

  constructor(status: number, errorPayload: { code: string; message: string; details?: unknown; request_id?: string }) {
    super(errorPayload.message);
    this.name = 'ApiError';
    this.status = status;
    this.code = errorPayload.code;
    this.details = errorPayload.details;
    this.request_id = errorPayload.request_id;
  }
}

export function getSessionToken() {
  return sessionStorage.getItem('session_token');
}

export function setSessionToken(token: string) {
  sessionStorage.setItem('session_token', token);
}

export function clearSessionToken() {
  sessionStorage.removeItem('session_token');
}

export function getTerminalCredential() {
  const cred = localStorage.getItem('terminal_credential');
  return cred ? JSON.parse(cred) : null;
}

export function setTerminalCredential(cred: { terminal_id: string; secret: string }) {
  localStorage.setItem('terminal_credential', JSON.stringify(cred));
}

export async function apiFetch<T>(
  path: string,
  options: RequestInit & { ifMatch?: string } = {}
): Promise<T> {
  const url = `${BASE_URL}${path}`;
  const headers = new Headers(options.headers);

  const token = getSessionToken();
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  
  if (options.ifMatch) {
    headers.set('If-Match', options.ifMatch);
  }

  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(url, {
    ...options,
    headers,
  });

  if (!response.ok) {
    if (response.status === 401) {
      clearSessionToken();
      // Use a custom event or a global router reference to trigger redirect
      window.dispatchEvent(new Event('auth:unauthorized'));
    }

    let errorPayload;
    try {
      const body = await response.json();
      errorPayload = body.error || { code: 'unknown_error', message: 'An unknown error occurred' };
    } catch {
      errorPayload = { code: 'network_error', message: response.statusText };
    }
    
    throw new ApiError(response.status, errorPayload);
  }

  if (response.status === 204) {
    return {} as T;
  }

  return response.json() as Promise<T>;
}
