import type { Bindings } from '../types';

/**
 * Backblaze B2 access.
 *
 * Object keys are stored in the database; public URLs are never persisted.
 * Keys under `private/` hold signatures, signed contracts and retention PDFs
 * and must only be served through an authorized route. Keys under `public/`
 * hold non-sensitive brand assets that document pages need to render.
 */

export function isPublicKey(key: string): boolean {
  return key.startsWith('public/');
}

function endpointFor(env: Bindings, key: string): string {
  const endpoint = env.B2_S3_ENDPOINT.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const encodedKey = key
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `https://${endpoint}/${env.B2_BUCKET_NAME}/${encodedKey}`;
}

function authHeader(env: Bindings): string {
  return `Basic ${btoa(`${env.B2_KEY_ID}:${env.B2_APP_KEY}`)}`;
}

export async function fetchFromB2(env: Bindings, key: string): Promise<Response> {
  if (!key || key.includes('..')) throw new Error('Invalid object key');
  const res = await fetch(endpointFor(env, key), {
    headers: { Authorization: authHeader(env) },
  });
  if (!res.ok) {
    throw new Error(`B2 fetch failed: ${res.status}`);
  }
  const contentType = res.headers.get('Content-Type') ?? 'application/octet-stream';
  return new Response(res.body, {
    headers: {
      'Content-Type': contentType,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': isPublicKey(key) ? 'public, max-age=86400' : 'private, no-store',
    },
  });
}

export async function fetchFromB2Bytes(env: Bindings, key: string): Promise<Uint8Array | null> {
  try {
    const res = await fetchFromB2(env, key);
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  } catch (error) {
    console.error('B2_BYTES_FETCH_FAILED', key, error);
    return null;
  }
}

export async function putObject(
  env: Bindings,
  key: string,
  body: ArrayBuffer | Uint8Array,
  contentType: string
): Promise<{ ok: boolean; status: number }> {
  if (!key || key.includes('..')) return { ok: false, status: 400 };
  try {
    const payload = body instanceof Uint8Array ? body : new Uint8Array(body);
    const res = await fetch(endpointFor(env, key), {
      method: 'PUT',
      headers: {
        Authorization: authHeader(env),
        'Content-Type': contentType,
        'Content-Length': String(payload.byteLength),
      },
      body: payload,
    });
    if (!res.ok) {
      console.error('B2_PUT_FAILED', key, res.status, (await res.text()).slice(0, 300));
    }
    return { ok: res.ok, status: res.status };
  } catch (error) {
    console.error('B2_PUT_THROW', key, error);
    return { ok: false, status: 0 };
  }
}

/** Deletes an object (used by proof cleanup and account deletion). */
export async function deleteObject(env: Bindings, key: string): Promise<boolean> {
  if (!key || key.includes('..')) return false;
  try {
    const res = await fetch(endpointFor(env, key), {
      method: 'DELETE',
      headers: { Authorization: authHeader(env) },
    });
    if (!res.ok && res.status !== 404) {
      console.error('B2_DELETE_FAILED', key, res.status);
      return false;
    }
    return true;
  } catch (error) {
    console.error('B2_DELETE_THROW', key, error);
    return false;
  }
}

/** Backwards-compatible boolean wrapper used by older call sites. */
export async function uploadToB2(
  env: Bindings,
  key: string,
  body: ArrayBuffer,
  contentType: string
): Promise<boolean> {
  const result = await putObject(env, key, body, contentType);
  return result.ok;
}

/**
 * Sanitises user-supplied HTML templates. This is a defence-in-depth measure:
 * uploaded templates are also served with `nosniff` and are never rendered in
 * the API origin's DOM. A DOM-based sanitiser (DOMPurify) would be stronger and
 * is tracked as remaining work.
 */
export function sanitizeHtml(html: string): string {
  let out = html;
  out = out.replace(/<script[\s\S]*?<\/script>/gi, '');
  out = out.replace(/<style[\s\S]*?<\/style>/gi, (match) => (/(expression|javascript:|@import)/i.test(match) ? '' : match));
  out = out.replace(/<iframe[\s\S]*?<\/iframe>/gi, '');
  out = out.replace(/<object[\s\S]*?<\/object>/gi, '');
  out = out.replace(/<embed[\s\S]*?>/gi, '');
  out = out.replace(/<(link|meta|base)\b[^>]*>/gi, '');
  out = out.replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '');
  out = out.replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '');
  out = out.replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '');
  out = out.replace(/\s(href|src|xlink:href)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, ' $1="#"');
  out = out.replace(/javascript:/gi, '');
  out = out.replace(/data:text\/html/gi, 'data:text/plain');
  return out;
}

export function safeFilename(name: string, fallback = 'file'): string {
  const cleaned = name
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 120);
  return cleaned || fallback;
}
