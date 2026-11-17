import { dbQuery, dbRun } from '../utils/db';
import { deleteObject } from '../services/storage';
import { createNotification } from '../services/notifications';
import type { Bindings } from '../types';

const PROOF_RETENTION_DAYS = 5;

/**
 * Payment proof screenshots are private client data. After the review window the
 * object is removed from storage, the invoice moves to `confirmed`, and the
 * owner is told. The row in `document_uploads` is removed with the object.
 */
export async function runProofCleanup(env: Bindings): Promise<void> {
  const cutoff = new Date(Date.now() - PROOF_RETENTION_DAYS * 86400000).toISOString();
  const invoices = await dbQuery<any>(
    env,
    `SELECT id, user_id, client_id, invoice_number, proof_submitted_at FROM invoices
     WHERE status = 'proof_submitted' AND proof_submitted_at IS NOT NULL AND proof_submitted_at < ?`,
    [cutoff]
  );

  for (const invoice of invoices) {
    try {
      const uploads = await dbQuery<{ id: string; key: string }>(
        env,
        `SELECT id, key FROM document_uploads WHERE document_type = 'invoice' AND document_id = ?`,
        [invoice.id]
      );
      for (const upload of uploads) {
        const removed = await deleteObject(env, upload.key);
        if (removed) {
          await dbRun(env, `DELETE FROM document_uploads WHERE id = ?`, [upload.id]);
        } else {
          console.error('PROOF_OBJECT_DELETE_FAILED', upload.key);
        }
      }
      await dbRun(env, `UPDATE invoices SET status = 'confirmed', confirmed_at = ?, updated_at = ? WHERE id = ?`, [
        new Date().toISOString(),
        new Date().toISOString(),
        invoice.id,
      ]);
      await createNotification(env, {
        userId: invoice.user_id,
        eventType: 'invoice_paid',
        clientId: invoice.client_id,
        documentId: invoice.id,
        title: `Payment proof removed for ${invoice.invoice_number}`,
        body: 'The proof screenshot was deleted after the 5 day review window. The invoice record is kept.',
        documentTitle: invoice.invoice_number,
      }).catch((error) => console.error('PROOF_NOTIFICATION_FAILED', error));
    } catch (error) {
      console.error('PROOF_CLEANUP_FAILED', invoice.id, error);
    }
  }
}
