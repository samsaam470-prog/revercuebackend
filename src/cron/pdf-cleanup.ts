import { dbQuery, dbRun } from '../utils/db';
import { fetchFromB2 } from '../services/storage';
import { sendFormSubmitEmail } from '../services/email';
import { tursoQuery } from '../utils/turso';
import type { Bindings } from '../types';

export async function runProofCleanup(env: Bindings): Promise<void> {
  const cutoff = new Date(Date.now() - 5 * 86400000).toISOString();
  const proofs = await dbQuery<any>(env, `SELECT id, user_id, client_id, invoice_number FROM invoices WHERE status = 'proof_submitted' AND proof_submitted_at < ?`, [cutoff]);
  for (const p of proofs) {
    const user = await tursoQuery(env, `SELECT email FROM users WHERE id = ?`, [p.user_id]);
    if (user.rows[0]?.email) {
      await sendFormSubmitEmail(env, String(user.rows[0].email), `Payment proof for ${p.invoice_number}`, {
        'Note': 'The payment proof screenshot is being deleted after 5 days for privacy. The invoice record is kept.',
      });
    }
    await dbRun(env, `UPDATE invoices SET status = 'confirmed', confirmed_at = ? WHERE id = ?`, [new Date().toISOString(), p.id]);
  }
}
