import { dbFirst, dbRun } from '../utils/db';
import { ARCHIVE_COUNT_LIMIT, ARCHIVE_RETENTION_DAYS } from '../config/constants';
import type { Bindings } from '../types';

/**
 * Archiving for contracts, forms and invoices.
 *
 * Proposals already carry their own archive columns. The other document tables
 * may not, so their archive state lives in `document_archive` (additive table)
 * while `status = 'archived'` marks the document itself — the same status the
 * public routes already treat as closed.
 */

export type ArchivableType = 'contract' | 'form' | 'invoice';

const TABLE: Record<ArchivableType, string> = {
  contract: 'contracts',
  form: 'forms',
  invoice: 'invoices',
};

export async function getArchiveState(
  env: Bindings,
  documentType: ArchivableType,
  documentId: string
): Promise<{ archived_at: string; archive_deletion_date: string | null; status_before: string | null } | null> {
  return dbFirst(
    env,
    `SELECT archived_at, archive_deletion_date, status_before FROM document_archive WHERE document_type = ? AND document_id = ? AND unarchived_at IS NULL LIMIT 1`,
    [documentType, documentId]
  );
}

export async function archiveDocument(
  env: Bindings,
  documentType: ArchivableType,
  documentId: string,
  userId: string,
  plan: string,
  currentStatus: string
): Promise<{ archive_deletion_date: string | null }> {
  const count = await dbFirst<{ c: number }>(
    env,
    `SELECT COUNT(*) as c FROM document_archive WHERE user_id = ? AND unarchived_at IS NULL`,
    [userId]
  );
  const limit = ARCHIVE_COUNT_LIMIT[plan as keyof typeof ARCHIVE_COUNT_LIMIT] ?? 5;
  if (Number(count?.c ?? 0) >= limit) {
    const error = new Error('archive_limit_reached') as Error & { status?: number };
    error.status = 403;
    throw error;
  }

  const days = ARCHIVE_RETENTION_DAYS[plan as keyof typeof ARCHIVE_RETENTION_DAYS] ?? 30;
  const now = new Date();
  const deletionDate = new Date(now.getTime() + days * 86400000).toISOString();

  await dbRun(
    env,
    `INSERT INTO document_archive (id, document_type, document_id, user_id, status_before, archived_at, archive_retention_days, archive_deletion_date, unarchived_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT(document_type, document_id) DO UPDATE SET archived_at = excluded.archived_at,
       archive_deletion_date = excluded.archive_deletion_date, unarchived_at = NULL, status_before = excluded.status_before`,
    [
      `arc_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`,
      documentType,
      documentId,
      userId,
      currentStatus,
      now.toISOString(),
      days,
      deletionDate,
    ]
  );

  await dbRun(
    env,
    `UPDATE ${TABLE[documentType]} SET status = 'archived', updated_at = ? WHERE id = ? AND user_id = ?`,
    [now.toISOString(), documentId, userId]
  );

  return { archive_deletion_date: deletionDate };
}

export async function unarchiveDocument(
  env: Bindings,
  documentType: ArchivableType,
  documentId: string,
  userId: string
): Promise<{ status: string }> {
  const state = await getArchiveState(env, documentType, documentId);
  const restore = state?.status_before && state.status_before !== 'archived' ? state.status_before : 'draft';
  const now = new Date().toISOString();
  await dbRun(
    env,
    `UPDATE document_archive SET unarchived_at = ? WHERE document_type = ? AND document_id = ? AND unarchived_at IS NULL`,
    [now, documentType, documentId]
  );
  await dbRun(env, `UPDATE ${TABLE[documentType]} SET status = ?, updated_at = ? WHERE id = ? AND user_id = ?`, [
    restore,
    now,
    documentId,
    userId,
  ]);
  return { status: restore };
}

/** Rows whose archive retention expired (used by the hourly cron). */
export async function listExpiredArchives(env: Bindings, now: string, limit = 50) {
  const { dbQuery } = await import('../utils/db');
  return dbQuery<{
    document_type: ArchivableType;
    document_id: string;
    user_id: string;
    archive_deletion_date: string;
  }>(
    env,
    `SELECT document_type, document_id, user_id, archive_deletion_date FROM document_archive
     WHERE unarchived_at IS NULL AND archive_deletion_date IS NOT NULL AND archive_deletion_date <= ?
     ORDER BY archive_deletion_date ASC LIMIT ?`,
    [now, limit]
  );
}
