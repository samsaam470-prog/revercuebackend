import type { Bindings } from '../types';

function encodeArg(a: any): { type: string; value: string } {
  if (a === null || a === undefined) {
    return { type: 'text', value: '' };
  }
  if (typeof a === 'number' || typeof a === 'bigint') {
    return { type: 'integer', value: String(a) };
  }
  return { type: 'text', value: String(a) };
}

export async function tursoQuery(
  env: Bindings,
  sql: string,
  args: any[] = []
): Promise<{ rows: any[]; columns: string[] }> {
  const url = env.TURSO_URL.replace('libsql://', 'https://');
  const res = await fetch(`${url}/v2/pipeline`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.TURSO_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      requests: [
        { type: 'execute', stmt: { sql, args: args.map(encodeArg) } },
        { type: 'close' },
      ],
    }),
  });

  const text = await res.text();

  if (!res.ok) {
    console.error('TURSO_HTTP_ERROR', res.status, text);
    throw new Error(`Turso error ${res.status}: ${text}`);
  }

  let data: any;
  try {
    data = JSON.parse(text);
  } catch (e) {
    console.error('TURSO_PARSE_ERROR', text);
    throw new Error(`Turso parse error: ${text}`);
  }

  const result = data.results?.[0];
  if (!result || result.type === 'error') {
    console.error('TURSO_QUERY_ERROR', JSON.stringify(result));
    throw new Error(`Turso query error: ${JSON.stringify(result)}`);
  }

  const cols = result.response?.result?.cols?.map((c: any) => c.name) ?? [];
  const rawRows = result.response?.result?.rows ?? [];
  const rows = rawRows.map((row: any[]) => {
    const obj: any = {};
    cols.forEach((col: string, i: number) => {
      const cell = row[i];
      obj[col] = cell?.value ?? null;
    });
    return obj;
  });

  return { rows, columns: cols };
}

export async function tursoExecute(
  env: Bindings,
  sql: string,
  args: any[] = []
): Promise<void> {
  await tursoQuery(env, sql, args);
}
