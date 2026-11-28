import { dbFirst, dbRun } from '../utils/db';
import type { Bindings } from '../types';

/**
 * Every document builder keeps its own columns, so Shareable Builder and
 * Offline Builder read and write through this one adapter instead of growing
 * five copies of the same logic. Adding a builder means adding a mapping here.
 */

export const DOCUMENT_TYPES = ['proposal', 'contract', 'invoice', 'form'] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export function isDocumentType(value: unknown): value is DocumentType {
  return typeof value === 'string' && (DOCUMENT_TYPES as readonly string[]).includes(value);
}

const TABLES: Record<DocumentType, string> = {
  proposal: 'proposals',
  contract: 'contracts',
  invoice: 'invoices',
  form: 'forms',
};

export interface DocumentPayload {
  id: string;
  title: string;
  type: DocumentType;
  /** Canonical editable content, shaped per builder. */
  content: Record<string, unknown>;
  updated_at: string | null;
}

function parseJson(value: unknown): unknown {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Reads one document owned by `userId`, normalised across builders. */
export async function readDocument(
  env: Bindings,
  type: DocumentType,
  id: string,
  userId: string
): Promise<DocumentPayload | null> {
  const table = TABLES[type];
  const row = await dbFirst<Record<string, any>>(
    env,
    `SELECT * FROM ${table} WHERE id = ? AND user_id = ? LIMIT 1`,
    [id, userId]
  );
  if (!row) return null;

  let content: Record<string, unknown> = {};
  if (type === 'proposal' || type === 'contract') {
    content = asRecord(parseJson(row.content));
  } else if (type === 'invoice') {
    content = {
      line_items: parseJson(row.line_items) ?? [],
      notes: row.notes ?? '',
      currency: row.currency ?? 'USD',
      tax: Number(row.tax ?? 0),
      total: Number(row.total ?? 0),
      due_date: row.due_date ?? null,
      payment_arrangement: parseJson(row.payment_arrangement) ?? null,
    };
  } else {
    content = {
      description: row.description ?? '',
      questions: parseJson(row.questions) ?? [],
      branching: parseJson(row.branching) ?? null,
      thank_you_config: parseJson(row.thank_you_config) ?? null,
    };
  }

  return {
    id: String(row.id),
    title: String(row.title ?? ''),
    type,
    content,
    updated_at: row.updated_at ? String(row.updated_at) : null,
  };
}

/** Writes the editable part of a document. Returns false when not owned. */
export async function writeDocument(
  env: Bindings,
  type: DocumentType,
  id: string,
  userId: string,
  content: Record<string, unknown>
): Promise<{ ok: boolean; updated_at: string }> {
  const table = TABLES[type];
  const now = new Date().toISOString();
  const owned = await dbFirst<{ id: string }>(
    env,
    `SELECT id FROM ${table} WHERE id = ? AND user_id = ? LIMIT 1`,
    [id, userId]
  );
  if (!owned) return { ok: false, updated_at: now };

  if (type === 'proposal' || type === 'contract') {
    const payload = asRecord(content.content ?? content);
    await dbRun(env, `UPDATE ${table} SET content = ?, updated_at = ? WHERE id = ? AND user_id = ?`, [
      JSON.stringify(payload),
      now,
      id,
      userId,
    ]);
  } else if (type === 'invoice') {
    await dbRun(
      env,
      `UPDATE invoices SET line_items = COALESCE(?, line_items), notes = COALESCE(?, notes),
         currency = COALESCE(?, currency), tax = COALESCE(?, tax), total = COALESCE(?, total),
         due_date = COALESCE(?, due_date), payment_arrangement = COALESCE(?, payment_arrangement),
         updated_at = ? WHERE id = ? AND user_id = ?`,
      [
        content.line_items === undefined ? null : JSON.stringify(content.line_items),
        content.notes === undefined ? null : String(content.notes),
        content.currency === undefined ? null : String(content.currency),
        content.tax === undefined ? null : Number(content.tax),
        content.total === undefined ? null : Number(content.total),
        content.due_date === undefined ? null : String(content.due_date),
        content.payment_arrangement === undefined ? null : JSON.stringify(content.payment_arrangement),
        now,
        id,
        userId,
      ]
    );
  } else {
    await dbRun(
      env,
      `UPDATE forms SET description = COALESCE(?, description), questions = COALESCE(?, questions),
         branching = COALESCE(?, branching), thank_you_config = COALESCE(?, thank_you_config),
         updated_at = ? WHERE id = ? AND user_id = ?`,
      [
        content.description === undefined ? null : String(content.description),
        content.questions === undefined ? null : JSON.stringify(content.questions),
        content.branching === undefined ? null : JSON.stringify(content.branching),
        content.thank_you_config === undefined ? null : JSON.stringify(content.thank_you_config),
        now,
        id,
        userId,
      ]
    );
  }
  return { ok: true, updated_at: now };
}
