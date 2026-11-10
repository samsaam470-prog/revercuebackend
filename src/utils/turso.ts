import type { Bindings } from '../types';

interface TursoResult {
  columns: string[];
  rows: any[][];
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
        { type: 'execute', stmt: { sql, args: args.map((a) => ({ type: 'text', value: String(a) })) } },
        { type: 'close' },
      ],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Turso error ${res.status}: ${text}`);
  }

  const data = await res.json();
  const result = data.results?.[0];
  if (!result || result.type === 'error') {
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
