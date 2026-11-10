import type { Bindings } from '../types';

export async function fetchFromB2(
  env: Bindings,
  key: string
): Promise<Response> {
  const endpoint = env.B2_S3_ENDPOINT.replace('https://', '');
  const url = `https://${endpoint}/${env.B2_BUCKET_NAME}/${key}`;

  const auth = btoa(`${env.B2_KEY_ID}:${env.B2_APP_KEY}`);
  const res = await fetch(url, {
    headers: {
      'Authorization': `Basic ${auth}`,
    },
  });

  if (!res.ok) {
    throw new Error(`B2 fetch failed: ${res.status}`);
  }

  return new Response(res.body, {
    headers: {
      'Content-Type': res.headers.get('Content-Type') ?? 'application/octet-stream',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}

export async function uploadToB2(
  env: Bindings,
  key: string,
  body: ArrayBuffer,
  contentType: string
): Promise<boolean> {
  const endpoint = env.B2_S3_ENDPOINT.replace('https://', '');
  const url = `https://${endpoint}/${env.B2_BUCKET_NAME}/${key}`;
  const auth = btoa(`${env.B2_KEY_ID}:${env.B2_APP_KEY}`);
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': contentType,
    },
    body,
  });
  return res.ok;
}
