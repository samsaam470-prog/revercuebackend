/**
 * SSRF protection for server-side fetches of user-supplied URLs.
 *
 * Workers cannot resolve DNS before fetching, so this guard blocks the
 * dangerous patterns that are reachable literally (loopback, private ranges,
 * link-local/cloud metadata, credentials in the URL, non-HTTP protocols) and
 * restricts redirects. A determined attacker can still use a public hostname
 * that resolves to a private address (DNS rebinding); that residual risk is
 * documented in docs/SECURITY.md and mitigated by fetching only metadata and
 * never forwarding responses to clients verbatim.
 */

const BLOCKED_HOST_PATTERNS: RegExp[] = [
  /^localhost$/i,
  /^127\./,
  /^0\.0\.0\.0$/,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./, // link-local + AWS/GCP metadata
  /^100\.6[4-9]\./,
  /^100\.[7-9]\d\./,
  /^100\.1[0-2]\d\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^\[?::1\]?$/,
  /^\[?fc00:/i,
  /^\[?fe80:/i,
  /metadata\.google\.internal$/i,
  /\.internal$/i,
  /\.local$/i,
];

const ALLOWED_PROTOCOLS = new Set(['https:']);

export interface UrlSafetyResult {
  ok: boolean;
  reason?: string;
  url?: URL;
}

export function checkPublicUrl(raw: string): UrlSafetyResult {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) return { ok: false, reason: 'insecure_protocol' };
  if (url.username || url.password) return { ok: false, reason: 'credentials_in_url' };
  if (url.port && url.port !== '443') return { ok: false, reason: 'non_standard_port' };
  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOST_PATTERNS.some((pattern) => pattern.test(host))) {
    return { ok: false, reason: 'private_host' };
  }
  if (!host.includes('.') && !host.endsWith(']')) {
    // Bare hostnames are resolved through search domains; refuse them.
    return { ok: false, reason: 'invalid_host' };
  }
  return { ok: true, url };
}

export interface SafeFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  headers?: Record<string, string>;
}

export interface SafeFetchResult {
  ok: boolean;
  status: number;
  body: string;
  contentType: string;
  reason?: string;
}

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_BYTES = 2_000_000;

export async function safeFetchPublic(
  raw: string,
  options: SafeFetchOptions = {}
): Promise<SafeFetchResult> {
  const check = checkPublicUrl(raw);
  if (!check.ok || !check.url) {
    return { ok: false, status: 0, body: '', contentType: '', reason: check.reason ?? 'unsafe_url' };
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(check.url.toString(), {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Revercue/2.0 (+https://revercue.pages.dev)',
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.5',
        ...(options.headers ?? {}),
      },
    });

    // A redirect may have landed on a private host; re-validate the final URL.
    if (response.url && response.url !== check.url.toString()) {
      const finalCheck = checkPublicUrl(response.url);
      if (!finalCheck.ok) {
        return { ok: false, status: response.status, body: '', contentType: '', reason: 'redirect_to_private_host' };
      }
    }

    const contentType = response.headers.get('Content-Type') ?? '';
    const reader = response.body?.getReader();
    if (!reader) {
      return { ok: response.ok, status: response.status, body: '', contentType };
    }

    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, status: response.status, body: '', contentType, reason: 'response_too_large' };
      }
      chunks.push(value);
    }

    const merged = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return {
      ok: response.ok,
      status: response.status,
      body: new TextDecoder().decode(merged),
      contentType,
    };
  } catch (error: any) {
    const reason = error?.name === 'AbortError' ? 'timeout' : 'fetch_failed';
    return { ok: false, status: 0, body: '', contentType: '', reason };
  } finally {
    clearTimeout(timer);
  }
}
