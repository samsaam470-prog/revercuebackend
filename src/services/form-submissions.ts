import { dbFirst, dbQuery, dbRun, dbRunResult } from '../utils/db';
import { tursoQuery } from '../utils/turso';
import { generateId } from '../utils/ids';
import { generatePrompt } from './prompt-creator';
import { runLayer1 } from './pipeline';
import { fetchVisualAssets } from './pipeline';
import { createNotification } from './notifications';
import {
  FORM_PROCESSING_BATCH_SIZE,
  FORM_PROCESSING_MAX_ATTEMPTS,
  FORM_PROCESSING_TIMEOUT_MS,
  MAX_SUBMISSION_ANSWERS_BYTES,
} from '../config/constants';
import type { Bindings } from '../types';

/**
 * Form submission intake and enrichment.
 *
 * Ordering is the important part: the original answers are persisted *before*
 * any external research starts, and an enrichment failure can never delete or
 * overwrite the submission. Enrichment is retried by the hourly cron.
 */

export interface FormQuestionDefinition {
  id?: string;
  key?: string;
  label?: string;
  question?: string;
  type?: string;
  required?: boolean;
  options?: unknown[];
}

export interface AnswerValidationResult {
  ok: boolean;
  errors: string[];
  answers: Record<string, unknown>;
}

const MAX_ANSWERS = 200;
const MAX_ANSWER_LENGTH = 5000;

function parseJson(value: unknown): any {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return {};
  }
}

/** Pure, testable answer validation. */
export function validateAnswers(
  questions: FormQuestionDefinition[],
  rawAnswers: unknown
): AnswerValidationResult {
  const errors: string[] = [];
  if (!rawAnswers || typeof rawAnswers !== 'object' || Array.isArray(rawAnswers)) {
    return { ok: false, errors: ['answers must be an object'], answers: {} };
  }
  const answers = rawAnswers as Record<string, unknown>;
  const keys = Object.keys(answers);
  if (keys.length > MAX_ANSWERS) errors.push(`too many answers (max ${MAX_ANSWERS})`);

  const serialized = JSON.stringify(answers);
  if (serialized.length > MAX_SUBMISSION_ANSWERS_BYTES) errors.push('answers are too large');

  const cleaned: Record<string, unknown> = {};
  for (const key of keys) {
    const value = answers[key];
    if (value === null || value === undefined) {
      cleaned[key] = '';
      continue;
    }
    if (typeof value === 'string') {
      if (value.length > MAX_ANSWER_LENGTH) {
        errors.push(`answer "${key}" is too long`);
        continue;
      }
      cleaned[key] = value;
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      cleaned[key] = value;
    } else if (Array.isArray(value)) {
      cleaned[key] = value.slice(0, 50).map((item) =>
        typeof item === 'string' ? item.slice(0, MAX_ANSWER_LENGTH) : String(item).slice(0, MAX_ANSWER_LENGTH)
      );
    } else if (typeof value === 'object') {
      const nested = JSON.stringify(value);
      if (nested.length > MAX_ANSWER_LENGTH) {
        errors.push(`answer "${key}" is too large`);
        continue;
      }
      cleaned[key] = value;
    } else {
      cleaned[key] = String(value).slice(0, MAX_ANSWER_LENGTH);
    }
  }

  for (const question of questions) {
    if (!question?.required) continue;
    const id = String(question.id ?? question.key ?? question.label ?? question.question ?? '');
    if (!id) continue;
    const value = cleaned[id];
    const empty =
      value === undefined ||
      value === null ||
      value === '' ||
      (Array.isArray(value) && value.length === 0);
    if (empty) errors.push(`"${String(question.label ?? question.question ?? id)}" is required`);
  }

  return { ok: errors.length === 0, errors, answers: cleaned };
}

export type SubmitResult =
  | {
      ok: true;
      submissionId: string;
      status: string;
      generatedPrompt: string | null;
      thankYouConfig: unknown;
      enriched: boolean;
    }
  | { ok: false; status: 400 | 404 | 409 | 410; error: string; message: string };

/** Question text plus the client's answer, so the prompt reads as a brief. */
function labelledBrief(questions: unknown, answers: Record<string, any>): string {
  if (!Array.isArray(questions)) return '';
  const lines: string[] = [];
  for (const question of questions) {
    const id = String(question?.id ?? '');
    if (!id) continue;
    const value = answers[id];
    const answer = Array.isArray(value)
      ? value.map((item) => String(item).trim()).filter(Boolean).join(', ')
      : value === null || value === undefined
        ? ''
        : String(value).trim();
    if (!answer) continue;
    const label = String(question?.text ?? 'Answer').trim().replace(/[?:]+\s*$/, '');
    lines.push(`${label}: ${answer}`);
  }
  return lines.join('; ');
}

export async function submitPublicForm(
  env: Bindings,
  input: {
    publicId: string;
    answers: unknown;
    serviceType?: unknown;
    clientSubmissionId?: unknown;
    ip: string;
    userAgent: string;
  }
): Promise<SubmitResult> {
  const form = await dbFirst<any>(env, `SELECT * FROM forms WHERE public_id = ? LIMIT 1`, [input.publicId]);
  if (!form) return { ok: false, status: 404, error: 'not_found', message: 'Form not found.' };
  if (form.status === 'archived' || form.status === 'closed') {
    return { ok: false, status: 410, error: 'gone', message: 'This form is no longer accepting responses.' };
  }
  if (form.status !== 'published') {
    return { ok: false, status: 409, error: 'not_published', message: 'This form is not accepting responses yet.' };
  }
  const settings = await dbFirst<any>(
    env,
    `SELECT thank_you_config, expiry_date FROM form_settings WHERE form_id = ? LIMIT 1`,
    [form.id]
  ).catch(() => null);
  const thankYouConfig = settings?.thank_you_config ? parseJson(settings.thank_you_config) : null;
  if (settings?.expiry_date && new Date(String(settings.expiry_date)).getTime() < Date.now()) {
    return { ok: false, status: 410, error: 'expired', message: 'This form has expired.' };
  }

  const questions = parseJson(form.questions);
  const validation = validateAnswers(Array.isArray(questions) ? questions : [], input.answers);
  if (!validation.ok) {
    return { ok: false, status: 400, error: 'invalid_payload', message: validation.errors.slice(0, 5).join('; ') };
  }

  const clientSubmissionId =
    typeof input.clientSubmissionId === 'string' && input.clientSubmissionId.length <= 100
      ? input.clientSubmissionId
      : null;

  if (clientSubmissionId) {
    const existing = await dbFirst<any>(
      env,
      `SELECT * FROM form_submissions WHERE form_id = ? AND client_submission_id = ? LIMIT 1`,
      [form.id, clientSubmissionId]
    );
    if (existing) {
      return {
        ok: true,
        submissionId: existing.id,
        status: existing.status,
        generatedPrompt: existing.generated_prompt,
        thankYouConfig,
        enriched: existing.status === 'enriched',
      };
    }
  }

  const serviceType = String(input.serviceType ?? validation.answers.service_type ?? 'project').slice(0, 100);
  const prompt = generatePrompt(serviceType, {
    ...(validation.answers as Record<string, any>),
    requirements: labelledBrief(questions, validation.answers) || validation.answers.requirements,
  });
  const id = generateId('sub');
  const now = new Date().toISOString();

  await dbRun(
    env,
    `INSERT INTO form_submissions
       (id, form_id, user_id, client_id, client_submission_id, service_type, answers, generated_prompt, status, attempts, last_error, research, assets, submitter_ip_hash, created_at, updated_at, processed_at, next_attempt_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'received', 0, NULL, NULL, NULL, NULL, ?, ?, NULL, ?)`,
    [
      id,
      form.id,
      form.user_id,
      form.client_id ?? null,
      clientSubmissionId,
      serviceType,
      JSON.stringify(validation.answers),
      prompt,
      now,
      now,
      now,
    ]
  );

  // Keep the legacy column populated so existing dashboards keep working.
  await dbRun(env, `UPDATE forms SET generated_prompt = ?, updated_at = ? WHERE id = ?`, [prompt, now, form.id]).catch(
    (error) => console.error('FORM_PROMPT_UPDATE_FAILED', error)
  );

  await createNotification(env, {
    userId: form.user_id,
    eventType: 'form_submitted',
    clientId: form.client_id ?? null,
    documentId: form.id,
    title: `New submission: ${form.title}`,
    documentTitle: String(form.title ?? ''),
    clientName: String((validation.answers as any).client_name ?? (validation.answers as any).name ?? 'Client'),
  }).catch((error) => console.error('FORM_NOTIFICATION_FAILED', error));

  // Bounded inline enrichment. Failure leaves the submission intact.
  const processed = await withTimeout(processSubmission(env, id), FORM_PROCESSING_TIMEOUT_MS).catch((error) => {
    console.error('FORM_ENRICHMENT_INLINE_FAILED', id, error);
    return null;
  });

  const stored = await dbFirst<any>(env, `SELECT status FROM form_submissions WHERE id = ? LIMIT 1`, [id]);
  return {
    ok: true,
    submissionId: id,
    status: String(stored?.status ?? (processed ? 'enriched' : 'received')),
    generatedPrompt: prompt,
    thankYouConfig,
    enriched: String(stored?.status) === 'enriched',
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

export interface EnrichmentResult {
  ok: boolean;
  status: string;
  error?: string;
}

/**
 * Enriches a submission with Extract API research + Visual Assets.
 * Concurrency-safe: the status transition is conditional, so two workers cannot
 * process the same submission twice.
 */
export async function processSubmission(env: Bindings, submissionId: string): Promise<EnrichmentResult> {
  const submission = await dbFirst<any>(env, `SELECT * FROM form_submissions WHERE id = ? LIMIT 1`, [submissionId]);
  if (!submission) return { ok: false, status: 'missing', error: 'submission_not_found' };
  if (submission.status === 'enriched') return { ok: true, status: 'enriched' };

  const claim = await dbRunResult(
    env,
    `UPDATE form_submissions SET status = 'processing', updated_at = ? WHERE id = ? AND status IN ('received','failed')`,
    [new Date().toISOString(), submissionId]
  );
  if (claim.changes === 0) {
    const current = await dbFirst<any>(env, `SELECT status FROM form_submissions WHERE id = ?`, [submissionId]);
    return { ok: true, status: String(current?.status ?? 'processing') };
  }

  const form = await dbFirst<any>(env, `SELECT * FROM forms WHERE id = ? LIMIT 1`, [submission.form_id]);
  const answers = parseJson(submission.answers);

  try {
    const research = await runLayer1(env, {
      client_name: String(answers.client_name ?? answers.name ?? 'Client'),
      client_email: typeof answers.email === 'string' ? answers.email : undefined,
      industry: String(answers.industry ?? answers.business_type ?? 'business'),
      service: String(answers.service ?? submission.service_type ?? 'project'),
      client_website: typeof answers.website === 'string' ? answers.website : undefined,
      location: typeof answers.location === 'string' ? answers.location : undefined,
    });

    const requests: { type: string; query: string }[] = [];
    if (research.image_url) requests.push({ type: 'image', query: `${research.industry} ${research.service}` });
    for (const point of research.key_points.slice(0, 2)) {
      requests.push({ type: 'icon', query: point.slice(0, 40) });
    }
    const assets = requests.length > 0 ? await fetchVisualAssets(env, requests).catch(() => []) : [];

    const now = new Date().toISOString();
    await dbRun(
      env,
      `UPDATE form_submissions SET status = 'enriched', research = ?, assets = ?, processed_at = ?, updated_at = ?, attempts = attempts + 1, last_error = NULL, next_attempt_at = NULL WHERE id = ?`,
      [JSON.stringify(research), JSON.stringify(assets), now, now, submissionId]
    );

    // Link the researched business back to the CRM record when there is one.
    if (form?.client_id && research.business_name) {
      await dbRun(env, `UPDATE clients SET industry = COALESCE(industry, ?), updated_at = ? WHERE id = ?`, [
        research.industry ?? null,
        now,
        form.client_id,
      ]).catch(() => undefined);
    }

    return { ok: true, status: 'enriched' };
  } catch (error: any) {
    const attempts = Number(submission.attempts ?? 0) + 1;
    const canRetry = attempts < FORM_PROCESSING_MAX_ATTEMPTS;
    const nextAttempt = new Date(Date.now() + Math.min(attempts, 5) * 15 * 60 * 1000).toISOString();
    await dbRun(
      env,
      `UPDATE form_submissions SET status = 'failed', attempts = ?, last_error = ?, updated_at = ?, next_attempt_at = ? WHERE id = ?`,
      [attempts, String(error?.message ?? 'unknown').slice(0, 500), new Date().toISOString(), canRetry ? nextAttempt : null, submissionId]
    );
    // A previously enriched version is never overwritten; only the status moves
    // to failed so the owner can retry.
    return { ok: false, status: 'failed', error: String(error?.message ?? 'unknown') };
  }
}

export async function processDueSubmissions(
  env: Bindings
): Promise<{ processed: number; enriched: number; failed: number }> {
  const due = await dbQuery<any>(
    env,
    `SELECT id FROM form_submissions
     WHERE status IN ('received','failed') AND attempts < ?
       AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
     ORDER BY created_at ASC LIMIT ?`,
    [FORM_PROCESSING_MAX_ATTEMPTS, new Date().toISOString(), FORM_PROCESSING_BATCH_SIZE]
  );
  let enriched = 0;
  let failed = 0;
  for (const row of due) {
    const result = await processSubmission(env, row.id);
    if (result.ok) enriched += 1;
    else failed += 1;
  }
  return { processed: due.length, enriched, failed };
}

export async function listSubmissions(
  env: Bindings,
  formId: string,
  userId: string,
  limit: number,
  offset: number
) {
  return dbQuery<any>(
    env,
    `SELECT id, form_id, client_id, status, service_type, attempts, last_error, created_at, processed_at
     FROM form_submissions WHERE form_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [formId, userId, limit, offset]
  );
}

export async function getSubmission(
  env: Bindings,
  formId: string,
  submissionId: string,
  userId: string
) {
  return dbFirst<any>(
    env,
    `SELECT * FROM form_submissions WHERE id = ? AND form_id = ? AND user_id = ? LIMIT 1`,
    [submissionId, formId, userId]
  );
}

export async function getFormOwnerPlan(env: Bindings, userId: string): Promise<string> {
  const result = await tursoQuery(env, `SELECT plan FROM users WHERE id = ? LIMIT 1`, [userId]);
  return String(result.rows[0]?.plan ?? 'free');
}
