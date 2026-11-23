import { Hono } from 'hono';
import { dbFirst, dbQuery, dbRun } from '../utils/db';
import { generateId, generatePublicId } from '../utils/ids';
import { userAuthMiddleware, getAuth } from '../middleware/user-auth';
import { createNotification } from '../services/notifications';
import { parsePagination, paginated, statusFilter } from '../utils/pagination';
import { jsonError } from '../utils/api-errors';
import { resolveClientId } from '../services/clients';
import { archiveDocument, unarchiveDocument } from '../services/archive';
import {
  activeDocumentLimitBody,
  branchingIsSet,
  checkActiveDocumentLimit,
  checkAdaptiveFormLimit,
} from '../services/plan-limits';
import { ADAPTIVE_FORM_LIMIT } from '../config/constants';
import { getTrackingSummary } from '../services/tracking';
import {
  getSubmission,
  listSubmissions,
  processSubmission,
} from '../services/form-submissions';
import { buildDocumentPdf } from '../services/pdf';
import { pdfResponse } from '../services/pdf-binary';
import type { Bindings } from '../types';

const forms = new Hono<{ Bindings: Bindings }>();
forms.use('*', userAuthMiddleware);

const LIST_STATUSES = ['draft', 'published', 'closed', 'archived'] as const;

function parseJson(value: unknown): any {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return {};
  }
}

/** Editor settings live in an additive table so old form rows are untouched. */
async function getFormSettings(env: Bindings, formId: string) {
  const row = await dbFirst<any>(
    env,
    `SELECT thank_you_config, page_mode, expiry_date, password_protected FROM form_settings WHERE form_id = ? LIMIT 1`,
    [formId]
  );
  return {
    thank_you_config: row?.thank_you_config ? parseJson(row.thank_you_config) : null,
    page_mode: row?.page_mode ?? 'single',
    expiry_date: row?.expiry_date ?? null,
  };
}

async function upsertFormSettings(env: Bindings, formId: string, body: any): Promise<void> {
  const now = new Date().toISOString();
  const thankYou = body.thank_you_config !== undefined ? JSON.stringify(body.thank_you_config) : null;
  const pageMode = body.page_mode === 'multi' ? 'multi' : body.page_mode === 'single' ? 'single' : null;
  const expiry = body.expiry_date === undefined ? null : body.expiry_date ? String(body.expiry_date) : null;

  await dbRun(
    env,
    `INSERT INTO form_settings (form_id, thank_you_config, page_mode, expiry_date, password_protected, created_at, updated_at)
     VALUES (?, ?, COALESCE(?, 'single'), ?, 0, ?, ?)
     ON CONFLICT(form_id) DO UPDATE SET
       thank_you_config = COALESCE(excluded.thank_you_config, form_settings.thank_you_config),
       page_mode = COALESCE(?, form_settings.page_mode),
       expiry_date = CASE WHEN ? = 1 THEN excluded.expiry_date ELSE form_settings.expiry_date END,
       updated_at = excluded.updated_at`,
    [
      formId,
      thankYou,
      pageMode,
      expiry,
      now,
      now,
      pageMode,
      body.expiry_date === undefined ? 0 : 1,
    ]
  );
}

forms.get('/', async (c) => {
  const auth = getAuth(c);
  const pagination = parsePagination(c);
  const status = statusFilter(c.req.query('status'), LIST_STATUSES);

  let where = 'user_id = ?';
  const args: any[] = [auth.userId];
  if (status) {
    where += ' AND status = ?';
    args.push(status);
  }

  const totalRow = await dbFirst<{ c: number }>(c.env, `SELECT COUNT(*) as c FROM forms WHERE ${where}`, args);
  const rows = await dbQuery(
    c.env,
    `SELECT id, title, status, public_id, created_at, updated_at, published_at
     FROM forms WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...args, pagination.limit, pagination.offset]
  );
  return c.json(paginated(rows, Number(totalRow?.c ?? 0), pagination));
});

forms.post('/draft', async (c) => {
  const auth = getAuth(c);
  const body = await c.req.json().catch(() => ({}));
  if (!String(body.title ?? '').trim()) return jsonError(c, 400, 'invalid_payload', 'A form title is required.');
  const allowedQuestionTypes = new Set(['short_text', 'long_text', 'file_upload', 'single_choice', 'multiple_choice', 'combined', 'dropdown']);
  const questions = Array.isArray(body.questions) ? body.questions : [];
  if (questions.length > 100) return jsonError(c, 400, 'invalid_payload', 'A form can contain up to 100 questions.');
  const questionIds = new Set<string>();
  for (const question of questions) {
    const id = String(question?.id ?? '').trim();
    const text = String(question?.text ?? '').trim();
    const type = String(question?.type ?? 'short_text');
    if (!id || !text || !allowedQuestionTypes.has(type) || questionIds.has(id)) {
      return jsonError(c, 400, 'invalid_question', 'Every question needs a unique ID, a label, and a supported response type.');
    }
    questionIds.add(id);
    if (['single_choice', 'multiple_choice', 'dropdown'].includes(type)) {
      const optionLabels = Array.isArray(question.options)
        ? question.options.map((option: any) => String(option?.label ?? option ?? '').trim()).filter(Boolean)
        : [];
      if (optionLabels.length < 2) {
        return jsonError(c, 400, 'invalid_question_options', 'Choice questions need at least two non-empty options.');
      }
    }
  }

  if (branchingIsSet(body.branching)) {
    const adaptive = await checkAdaptiveFormLimit(c.env, auth.userId);
    if (!adaptive.allowed) {
      return c.json(
        {
          error: 'plan_limit_reached',
          message: `Your plan allows ${adaptive.limit} adaptive forms.`,
          details: { limit: adaptive.limit, used: adaptive.used },
        },
        403
      );
    }
  }

  const clientId = await resolveClientId(c.env, auth.userId, {
    client_id: body.client_id,
    client_name: body.client_name,
    client_email: body.client_email,
    source: 'auto_form',
  });

  const id = generateId('form');
  const now = new Date().toISOString();
  await dbRun(
    c.env,
    `INSERT INTO forms (id, user_id, client_id, title, description, questions, branching, status, draft_created_at, draft_retention_days, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, 30, ?, ?)`,
    [
      id,
      auth.userId,
      clientId,
      String(body.title).slice(0, 300),
      body.description ?? null,
      JSON.stringify(questions),
      JSON.stringify(body.branching ?? {}),
      now,
      now,
      now,
    ]
  );

  if (body.thank_you_config !== undefined || body.page_mode !== undefined || body.expiry_date !== undefined) {
    await upsertFormSettings(c.env, id, body);
  }

  return c.json({ success: true, id, status: 'draft', client_id: clientId ?? undefined }, 201);
});

forms.get('/:id', async (c) => {
  const auth = getAuth(c);
  const row = await dbFirst<any>(c.env, `SELECT * FROM forms WHERE id = ? AND user_id = ?`, [
    c.req.param('id'),
    auth.userId,
  ]);
  if (!row) return jsonError(c, 404, 'not_found', 'Form not found.');

  const [settings, tracking, submissionCount] = await Promise.all([
    getFormSettings(c.env, row.id),
    getTrackingSummary(c.env, 'form', row.id),
    dbFirst<{ c: number }>(c.env, `SELECT COUNT(*) as c FROM form_submissions WHERE form_id = ?`, [row.id]),
  ]);

  // `questions` and `branching` are stored as JSON text; the editor expects
  // real arrays/objects, and passing the raw strings crashed the edit page.
  const questions = parseJson(row.questions);
  const branching = parseJson(row.branching);
  return c.json({
    form: {
      ...row,
      questions: Array.isArray(questions) ? questions : [],
      branching: branching && typeof branching === 'object' && !Array.isArray(branching) ? branching : {},
      ...settings,
      tracking,
      submission_count: Number(submissionCount?.c ?? 0),
    },
  });
});

forms.patch('/:id', async (c) => {
  const auth = getAuth(c);
  const body = await c.req.json().catch(() => ({}));
  const row = await dbFirst<any>(c.env, `SELECT * FROM forms WHERE id = ? AND user_id = ?`, [
    c.req.param('id'),
    auth.userId,
  ]);
  if (!row) return jsonError(c, 404, 'not_found', 'Form not found.');
  if (row.status === 'archived') return jsonError(c, 409, 'archived', 'Unarchive the form before editing it.');

  if (body.branching !== undefined && branchingIsSet(body.branching) && !branchingIsSet(row.branching)) {
    const adaptive = await checkAdaptiveFormLimit(c.env, auth.userId, false, row.id);
    if (!adaptive.allowed) {
      return c.json(
        {
          error: 'plan_limit_reached',
          message: `Your plan allows ${adaptive.limit} adaptive forms.`,
          details: { limit: adaptive.limit, used: adaptive.used },
        },
        403
      );
    }
  }

  const now = new Date().toISOString();
  await dbRun(
    c.env,
    `UPDATE forms SET title = COALESCE(?, title), description = COALESCE(?, description),
       questions = COALESCE(?, questions), branching = COALESCE(?, branching), updated_at = ?
     WHERE id = ? AND user_id = ?`,
    [
      body.title ?? null,
      body.description ?? null,
      body.questions ? JSON.stringify(body.questions) : null,
      body.branching ? JSON.stringify(body.branching) : null,
      now,
      row.id,
      auth.userId,
    ]
  );
  if (body.thank_you_config !== undefined || body.page_mode !== undefined || body.expiry_date !== undefined) {
    await upsertFormSettings(c.env, row.id, body);
  }
  return c.json({ success: true, updated_at: now });
});

forms.post('/:id/publish', async (c) => {
  const auth = getAuth(c);
  const row = await dbFirst<any>(c.env, `SELECT * FROM forms WHERE id = ? AND user_id = ?`, [
    c.req.param('id'),
    auth.userId,
  ]);
  if (!row) return jsonError(c, 404, 'not_found', 'Form not found.');
  if (row.status === 'archived') return jsonError(c, 409, 'archived', 'Unarchive the form before publishing.');

  const active = await checkActiveDocumentLimit(c.env, auth.userId, row.status === 'published');
  if (!active.allowed) return c.json(activeDocumentLimitBody(active), 403);

  const questions = parseJson(row.questions);
  if (!Array.isArray(questions) || questions.length === 0) {
    return jsonError(c, 400, 'invalid_payload', 'Add at least one question before publishing.');
  }

  const publicId = row.public_id ?? generatePublicId();
  const now = new Date().toISOString();
  await dbRun(c.env, `UPDATE forms SET status = 'published', public_id = ?, published_at = ?, updated_at = ? WHERE id = ?`, [
    publicId,
    now,
    now,
    row.id,
  ]);
  await createNotification(c.env, {
    userId: auth.userId,
    eventType: 'document_created',
    clientId: row.client_id,
    documentId: row.id,
    title: `Form published: ${row.title}`,
  });
  const base = (c.env.APP_URL || c.env.FRONTEND_ORIGIN || 'https://revercue.co.uk').replace(/\/$/, '');
  return c.json({ success: true, public_id: publicId, url: `${base}/f/${publicId}` });
});

forms.post('/:id/duplicate', async (c) => {
  const auth = getAuth(c);
  const row = await dbFirst<any>(c.env, `SELECT * FROM forms WHERE id = ? AND user_id = ?`, [
    c.req.param('id'),
    auth.userId,
  ]);
  if (!row) return jsonError(c, 404, 'not_found', 'Form not found.');
  const body = await c.req.json().catch(() => ({}));
  const clientId = body.client_id
    ? await resolveClientId(c.env, auth.userId, { client_id: body.client_id })
    : row.client_id;
  const id = generateId('form');
  const now = new Date().toISOString();
  await dbRun(
    c.env,
    `INSERT INTO forms (id, user_id, client_id, title, description, questions, branching, status, draft_created_at, draft_retention_days, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, 30, ?, ?)`,
    [
      id,
      auth.userId,
      clientId,
      `${row.title} (copy)`,
      row.description,
      row.questions,
      row.branching,
      now,
      now,
      now,
    ]
  );
  const settings = await getFormSettings(c.env, row.id);
  await upsertFormSettings(c.env, id, {
    thank_you_config: settings.thank_you_config,
    page_mode: settings.page_mode,
    expiry_date: settings.expiry_date,
  });
  return c.json({ success: true, id, status: 'draft' }, 201);
});

forms.post('/:id/archive', async (c) => {
  const auth = getAuth(c);
  const row = await dbFirst<any>(c.env, `SELECT id, status FROM forms WHERE id = ? AND user_id = ?`, [
    c.req.param('id'),
    auth.userId,
  ]);
  if (!row) return jsonError(c, 404, 'not_found', 'Form not found.');
  try {
    const result = await archiveDocument(c.env, 'form', row.id, auth.userId, auth.plan, row.status);
    return c.json({ success: true, status: 'archived', ...result });
  } catch (error: any) {
    if (error?.message === 'archive_limit_reached') {
      return jsonError(c, 403, 'archive_limit_reached', 'You reached the archive limit for your plan.');
    }
    console.error('FORM_ARCHIVE_FAILED', error);
    return jsonError(c, 500, 'archive_failed', 'The form could not be archived.');
  }
});

forms.post('/:id/unarchive', async (c) => {
  const auth = getAuth(c);
  const row = await dbFirst<any>(c.env, `SELECT id FROM forms WHERE id = ? AND user_id = ?`, [
    c.req.param('id'),
    auth.userId,
  ]);
  if (!row) return jsonError(c, 404, 'not_found', 'Form not found.');
  const result = await unarchiveDocument(c.env, 'form', row.id, auth.userId);
  return c.json({ success: true, ...result });
});

forms.post('/:id/share', async (c) => {
  const auth = getAuth(c);
  const body = await c.req.json().catch(() => ({}));
  const row = await dbFirst<any>(c.env, `SELECT id, client_id, public_id FROM forms WHERE id = ? AND user_id = ?`, [
    c.req.param('id'),
    auth.userId,
  ]);
  if (!row) return jsonError(c, 404, 'not_found', 'Form not found.');
  if (!row.public_id) return jsonError(c, 409, 'not_published', 'Publish the form before sharing it.');
  const now = new Date().toISOString();
  await dbRun(
    c.env,
    `INSERT INTO communication_log (id, user_id, client_id, entry_type, channel, linked_document_type, linked_document_id, created_at)
     VALUES (?, ?, ?, 'document_shared', ?, 'form', ?, ?)`,
    [generateId('log'), auth.userId, row.client_id, String(body.channel ?? 'other').slice(0, 40), row.id, now]
  );
  return c.json({ success: true });
});

forms.get('/:id/submissions', async (c) => {
  const auth = getAuth(c);
  const form = await dbFirst<any>(c.env, `SELECT id FROM forms WHERE id = ? AND user_id = ?`, [
    c.req.param('id'),
    auth.userId,
  ]);
  if (!form) return jsonError(c, 404, 'not_found', 'Form not found.');
  const pagination = parsePagination(c);
  const totalRow = await dbFirst<{ c: number }>(c.env, `SELECT COUNT(*) as c FROM form_submissions WHERE form_id = ?`, [
    form.id,
  ]);
  const submissions = await listSubmissions(c.env, form.id, auth.userId, pagination.limit, pagination.offset);
  return c.json(paginated(submissions, Number(totalRow?.c ?? 0), pagination));
});

/** Markdown rendering of one answer value: strings stay as written. */
function answerToMarkdown(value: unknown): string {
  if (value === null || value === undefined || value === '') return '_Not answered._';
  if (Array.isArray(value)) return value.map((item) => answerToMarkdown(item)).join(', ');
  if (typeof value === 'object') return '`' + JSON.stringify(value) + '`';
  return String(value);
}

function submissionToMarkdown(
  title: string,
  submission: any,
  answers: Record<string, unknown>
): string {
  const lines: string[] = [`# ${title} — requirement answers`, ''];
  lines.push(`- Submitted: ${submission.created_at}`);
  if (submission.service_type) lines.push(`- Service: ${submission.service_type}`);
  lines.push(`- Status: ${submission.status}`, '', '## Answers', '');
  const entries = Object.entries(answers);
  if (entries.length === 0) {
    lines.push('_No answers were recorded._');
  } else {
    for (const [key, value] of entries) {
      lines.push(`### ${key}`, '', answerToMarkdown(value), '');
    }
  }
  if (submission.generated_prompt) {
    lines.push('## Assembled brief', '', String(submission.generated_prompt), '');
  }
  return lines.join('\n');
}

function markdownResponse(body: string, filename: string): Response {
  return new Response(body, {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}

forms.get('/:id/submissions/export.md', async (c) => {
  const auth = getAuth(c);
  const form = await dbFirst<any>(c.env, `SELECT id, title FROM forms WHERE id = ? AND user_id = ?`, [
    c.req.param('id'),
    auth.userId,
  ]);
  if (!form) return jsonError(c, 404, 'not_found', 'Form not found.');
  const rows = await dbQuery<any>(
    c.env,
    `SELECT * FROM form_submissions WHERE form_id = ? AND user_id = ? ORDER BY created_at ASC`,
    [form.id, auth.userId]
  );
  const body = rows
    .map((row, index) =>
      submissionToMarkdown(
        `${form.title || 'Form'} (${index + 1} of ${rows.length})`,
        row,
        parseJson(row.answers)
      )
    )
    .join('\n---\n\n');
  return markdownResponse(
    body || `# ${form.title || 'Form'}\n\n_No submissions yet._\n`,
    `form-${form.id}-answers.md`
  );
});

forms.get('/:id/submissions/:submissionId.md', async (c) => {
  const auth = getAuth(c);
  const form = await dbFirst<any>(c.env, `SELECT id, title FROM forms WHERE id = ? AND user_id = ?`, [
    c.req.param('id'),
    auth.userId,
  ]);
  if (!form) return jsonError(c, 404, 'not_found', 'Form not found.');
  const submission = await getSubmission(c.env, form.id, String(c.req.param('submissionId') ?? ''), auth.userId);
  if (!submission) return jsonError(c, 404, 'not_found', 'Submission not found.');
  return markdownResponse(
    submissionToMarkdown(form.title || 'Form', submission, parseJson(submission.answers)),
    `submission-${submission.id}.md`
  );
});

forms.get('/:id/submissions/:submissionId', async (c) => {
  const auth = getAuth(c);
  const submission = await getSubmission(c.env, c.req.param('id'), c.req.param('submissionId'), auth.userId);
  if (!submission) return jsonError(c, 404, 'not_found', 'Submission not found.');
  const uploads = await dbQuery(
    c.env,
    `SELECT id, key, mime, size_bytes, question_id, created_at FROM document_uploads WHERE document_type = 'form' AND document_id = ? ORDER BY created_at ASC`,
    [c.req.param('id')]
  );
  return c.json({
    submission: {
      ...submission,
      answers: parseJson(submission.answers),
      research: submission.research ? parseJson(submission.research) : null,
      assets: submission.assets ? parseJson(submission.assets) : [],
      uploads,
    },
  });
});

forms.post('/:id/submissions/:submissionId/retry', async (c) => {
  const auth = getAuth(c);
  const submission = await getSubmission(c.env, c.req.param('id'), c.req.param('submissionId'), auth.userId);
  if (!submission) return jsonError(c, 404, 'not_found', 'Submission not found.');
  if (submission.status === 'enriched') {
    return jsonError(c, 409, 'already_enriched', 'This submission is already enriched.');
  }
  await dbRun(
    c.env,
    `UPDATE form_submissions SET status = 'received', next_attempt_at = ?, updated_at = ? WHERE id = ? AND status IN ('received','failed')`,
    [new Date().toISOString(), new Date().toISOString(), submission.id]
  );
  const result = await processSubmission(c.env, submission.id);
  return c.json({ success: true, status: result.status, error: result.error ?? null });
});

forms.get('/:id/pdf', async (c) => {
  const auth = getAuth(c);
  const form = await dbFirst<any>(c.env, `SELECT id FROM forms WHERE id = ? AND user_id = ?`, [
    c.req.param('id'),
    auth.userId,
  ]);
  if (!form) return jsonError(c, 404, 'not_found', 'Form not found.');
  const generated = await buildDocumentPdf(c.env, 'form', form.id);
  if (!generated) return jsonError(c, 404, 'not_found', 'Form not found.');
  return pdfResponse(generated.bytes, `form-${form.id}.pdf`, 'attachment');
});

forms.delete('/:id', async (c) => {
  const auth = getAuth(c);
  const row = await dbFirst<any>(c.env, `SELECT id, status FROM forms WHERE id = ? AND user_id = ?`, [
    c.req.param('id'),
    auth.userId,
  ]);
  if (!row) return jsonError(c, 404, 'not_found', 'Form not found.');
  const submissions = await dbFirst<{ c: number }>(c.env, `SELECT COUNT(*) as c FROM form_submissions WHERE form_id = ?`, [
    row.id,
  ]);
  if (Number(submissions?.c ?? 0) > 0) {
    return jsonError(
      c,
      409,
      'has_submissions',
      'This form has submissions. Archive it instead so the answers and research are preserved.'
    );
  }
  await dbRun(c.env, `DELETE FROM form_settings WHERE form_id = ?`, [row.id]);
  await dbRun(c.env, `DELETE FROM forms WHERE id = ? AND user_id = ?`, [row.id, auth.userId]);
  return c.json({ success: true });
});

export default forms;
