import type { Bindings } from '../types';

/**
 * AuthAction Management API client (server-side only).
 *
 * Uses the OAuth 2.0 Client Credentials flow to obtain an M2M access token,
 * caches it in isolate memory with a safety margin, and exposes the verified
 * users directory endpoints. Credentials and tokens never leave the backend.
 */

export class AuthActionManagementConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthActionManagementConfigError';
  }
}

export class AuthActionManagementApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'AuthActionManagementApiError';
    this.status = status;
  }
}

export interface AuthActionManagementUser {
  id: string;
  name: string;
  email: string;
  tenant: string | null;
  connection: string | null;
  applications: string[];
  roles: string[];
  emailVerified: boolean;
  isBlocked: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface AuthActionUsersPage {
  items: AuthActionManagementUser[];
  meta: {
    itemsCount: number;
    totalItems: number;
    itemsPerPage: number;
    totalPages: number;
    currentPage: number;
  };
}

interface TokenCacheEntry {
  token: string;
  expiresAt: number;
}

const tokenCache = new Map<string, TokenCacheEntry>();
const TOKEN_SAFETY_MARGIN_MS = 60 * 1000; // refresh 60s before expiry
const REQUEST_TIMEOUT_MS = 15000;

function cacheKey(env: Bindings): string {
  return `${env.AUTHACTION_ISSUER ?? ''}|${env.AUTHACTION_M2M_CLIENT_ID ?? ''}`;
}

function getM2MConfig(env: Bindings): { issuer: string; clientId: string; clientSecret: string; audience: string } {
  const issuer = (env.AUTHACTION_ISSUER ?? '').trim().replace(/\/$/, '');
  const clientId = (env.AUTHACTION_M2M_CLIENT_ID ?? '').trim();
  const clientSecret = (env.AUTHACTION_M2M_CLIENT_SECRET ?? '').trim();
  const audience = (env.AUTHACTION_M2M_AUDIENCE ?? '').trim() || issuer;
  if (!issuer) throw new AuthActionManagementConfigError('AUTHACTION_ISSUER is not configured.');
  if (!clientId) throw new AuthActionManagementConfigError('AUTHACTION_M2M_CLIENT_ID is not configured.');
  if (!clientSecret) throw new AuthActionManagementConfigError('AUTHACTION_M2M_CLIENT_SECRET is not configured.');
  return { issuer, clientId, clientSecret, audience };
}

export function isManagementConfigured(env: Bindings): boolean {
  return Boolean(
    (env.AUTHACTION_ISSUER ?? '').trim() &&
      (env.AUTHACTION_M2M_CLIENT_ID ?? '').trim() &&
      (env.AUTHACTION_M2M_CLIENT_SECRET ?? '').trim()
  );
}

export async function getManagementAccessToken(env: Bindings): Promise<string> {
  const config = getM2MConfig(env);
  const key = cacheKey(env);
  const cached = tokenCache.get(key);
  if (cached && Date.now() < cached.expiresAt - TOKEN_SAFETY_MARGIN_MS) {
    return cached.token;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${config.issuer}/oauth2/m2m/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        audience: config.audience,
        grant_type: 'client_credentials',
      }),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new AuthActionManagementApiError(response.status, `M2M token request failed (${response.status}): ${text.slice(0, 300)}`);
    }
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      throw new AuthActionManagementApiError(response.status, 'M2M token response was not JSON.');
    }
    const token = String(data?.access_token ?? '');
    const expiresIn = Number(data?.expires_in ?? 0);
    if (!token) throw new AuthActionManagementApiError(response.status, 'M2M token response missing access_token.');
    tokenCache.set(key, {
      token,
      expiresAt: Date.now() + (expiresIn > 0 ? expiresIn * 1000 : 60 * 60 * 1000),
    });
    return token;
  } catch (error: any) {
    if (error instanceof AuthActionManagementApiError) throw error;
    const reason = error?.name === 'AbortError' ? 'timeout' : error?.message ?? 'unknown';
    throw new AuthActionManagementApiError(0, `M2M token request failed: ${reason}`);
  } finally {
    clearTimeout(timer);
  }
}

export function resetManagementTokenCache(): void {
  tokenCache.clear();
}

function normalizeUser(raw: any): AuthActionManagementUser {
  return {
    id: String(raw?.id ?? ''),
    name: String(raw?.name ?? ''),
    email: String(raw?.email ?? '').trim().toLowerCase(),
    tenant: raw?.tenant ? String(raw.tenant) : null,
    connection: raw?.connection ? String(raw.connection) : null,
    applications: Array.isArray(raw?.applications) ? raw.applications.map((x: any) => String(x)) : [],
    roles: Array.isArray(raw?.roles) ? raw.roles.map((x: any) => String(x)) : [],
    emailVerified: raw?.emailVerified === true,
    isBlocked: raw?.isBlocked === true,
    createdAt: raw?.createdAt ? String(raw.createdAt) : null,
    updatedAt: raw?.updatedAt ? String(raw.updatedAt) : null,
  };
}

async function managementFetch(env: Bindings, path: string, init: RequestInit = {}): Promise<any> {
  const config = getM2MConfig(env);
  const doFetch = async (token: string) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${config.issuer}${path}`, {
        ...init,
        headers: {
          ...(init.headers ?? {}),
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
        signal: controller.signal,
      });
      const text = await response.text();
      return { response, text };
    } finally {
      clearTimeout(timer);
    }
  };

  let token = await getManagementAccessToken(env);
  let { response, text } = await doFetch(token);

  // Retry once on 401 by refreshing the token.
  if (response.status === 401) {
    resetManagementTokenCache();
    token = await getManagementAccessToken(env);
    ({ response, text } = await doFetch(token));
  }

  if (!response.ok) {
    throw new AuthActionManagementApiError(response.status, `Management API ${path} failed (${response.status}): ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new AuthActionManagementApiError(response.status, `Management API ${path} returned non-JSON.`);
  }
}

export async function listManagementUsers(
  env: Bindings,
  opts: { page?: number; limit?: number } = {}
): Promise<AuthActionUsersPage> {
  const page = Math.max(0, Number(opts.page ?? 0));
  const limit = Math.min(Math.max(Number(opts.limit ?? 10), 1), 100);
  const qs = `?page=${page}&limit=${limit}`;
  const data = await managementFetch(env, `/api/v1/users${qs}`);
  const meta = data?.data?.meta ?? {};
  const items = Array.isArray(data?.data?.items) ? data.data.items : [];
  return {
    items: items.map(normalizeUser),
    meta: {
      itemsCount: Number(meta.itemsCount ?? items.length),
      totalItems: Number(meta.totalItems ?? items.length),
      itemsPerPage: Number(meta.itemsPerPage ?? limit),
      totalPages: Number(meta.totalPages ?? 1),
      currentPage: Number(meta.currentPage ?? page),
    },
  };
}

export async function getManagementUser(env: Bindings, id: string): Promise<AuthActionManagementUser | null> {
  try {
    const data = await managementFetch(env, `/api/v1/users/${encodeURIComponent(id)}`);
    const raw = data?.data ?? data;
    if (!raw || !raw.id) return null;
    return normalizeUser(raw);
  } catch (error: any) {
    if (error instanceof AuthActionManagementApiError && error.status === 404) return null;
    throw error;
  }
}