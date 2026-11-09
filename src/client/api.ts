import { io, type Socket } from 'socket.io-client';

const TOKEN_KEY = 'teenpatti.token';
const NAME_KEY = 'teenpatti.name';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function getName(): string {
  return localStorage.getItem(NAME_KEY) ?? '';
}

export function setSession(token: string, name: string): void {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(NAME_KEY, name);
}

export function clearSession(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(NAME_KEY);
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(path, { ...init, headers });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message = (data && (data.error as string)) || `Request failed (${response.status})`;
    throw new Error(message);
  }
  return data as T;
}

export async function signInAsGuest(name: string): Promise<{ userId: string; name: string; token: string }> {
  const user = await api<{ userId: string; name: string; token: string }>('/api/auth/guest', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
  setSession(user.token, user.name);
  return user;
}

export function connectSocket(): Socket {
  return io({ auth: { token: getToken() }, transports: ['websocket', 'polling'] });
}

/**
 * `crypto.randomUUID()` only exists in secure contexts, which a plain
 * `http://100.x.y.z:3000` Tailscale or LAN origin is not. `getRandomValues()`
 * is available everywhere, so fall back to it and build a v4 UUID by hand.
 */
export function actionId(): string {
  const cryptoObj = globalThis.crypto;
  if (typeof cryptoObj?.randomUUID === 'function') return cryptoObj.randomUUID();
  const bytes = new Uint8Array(16);
  cryptoObj.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function roomLink(code: string): string {
  return `${window.location.origin}/#/join/${code}`;
}

/** Clipboard API is unavailable on plain http origins; fall back to a prompt. */
export async function copyText(text: string): Promise<void> {
  try {
    if (window.isSecureContext && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    /* fall through */
  }
  window.prompt('Copy this link:', text);
}
