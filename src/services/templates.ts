import { tursoQuery } from '../utils/turso';
import { dbQuery } from '../utils/db';
import type { Bindings } from '../types';

export async function listTemplatesForUser(env: Bindings, userId: string, serviceTags: string[]) {
  const adminTemplates = await dbQuery(
    env,
    `SELECT id, name, type, tags, b2_key, source, status, times_used, documents_created, conversions FROM templates WHERE source = 'built_in' AND status IN ('active','featured')`
  );
  const customTemplates = await dbQuery(
    env,
    `SELECT id, name, type, tags, b2_key, source, status FROM templates WHERE source = 'custom' AND user_id = ? AND status IN ('active','featured')`,
    [userId]
  );
  const suggested = (t: any) => {
    const tags = JSON.parse(t.tags || '[]');
    return tags.some((tag: string) => serviceTags.includes(tag));
  };
  return {
    built_in: adminTemplates.map((t: any) => ({ ...t, suggested: suggested(t) })),
    custom: customTemplates.map((t: any) => ({ ...t, suggested: suggested(t) })),
  };
}

export async function matchTemplate(env: Bindings, type: string, serviceTags: string[]): Promise<any | null> {
  const templates = await dbQuery(
    env,
    `SELECT * FROM templates WHERE type = ? AND status = 'featured' ORDER BY times_used DESC LIMIT 10`,
    [type]
  );
  for (const t of templates as any[]) {
    const tags = JSON.parse(t.tags || '[]');
    if (tags.some((tag: string) => serviceTags.includes(tag))) return t;
  }
  return (templates[0] as any) ?? null;
}
