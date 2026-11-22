import { Hono } from 'hono';
import { tursoExecute, tursoQuery } from '../utils/turso';
import { userAuthMiddleware, getAuth } from '../middleware/user-auth';
import { createNotification } from '../services/notifications';
import { generateId } from '../utils/ids';
import {
  onboardingStep1Schema,
  onboardingStep2Schema,
  onboardingStep4Schema,
  onboardingStep5Schema,
  tutorialSchema,
} from '../utils/validate';
import { jsonError } from '../utils/api-errors';
import { contactEmail, PLACEHOLDER_EMAIL_LIKE } from '../utils/contact-email';
import type { Bindings } from '../types';

const onboarding = new Hono<{ Bindings: Bindings }>();
onboarding.use('*', userAuthMiddleware);

function firstIssue(result: { success: false; error: any }): string {
  return String(result.error?.issues?.[0]?.message ?? 'Check the submitted values.');
}

onboarding.patch('/step-1', async (c) => {
  const auth = getAuth(c);
  const parsed = onboardingStep1Schema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return jsonError(c, 400, 'invalid_payload', firstIssue(parsed));
  }

  // AuthAction does not always release an email address. Step 1 is where the
  // user supplies one, and it is stored exactly as given: Revercue does not
  // send an email code and does not mark the address verified. An existing
  // AuthAction email is never overwritten from onboarding.
  const suppliedEmail = parsed.data.email?.trim().toLowerCase();
  if (suppliedEmail) {
    const current = await tursoQuery(
      c.env,
      `SELECT email FROM users WHERE id = ? LIMIT 1`,
      [auth.userId]
    );
    // A placeholder address means AuthAction sent no email, so step 1 fills it
    // in exactly like an empty value.
    const storedEmail = contactEmail(current.rows[0]?.email);
    if (!storedEmail) {
      const taken = await tursoQuery(
        c.env,
        `SELECT id FROM users WHERE lower(email) = ? AND id <> ? LIMIT 1`,
        [suppliedEmail, auth.userId]
      );
      if (taken.rows.length > 0) {
        return jsonError(c, 409, 'email_in_use', 'Another Revercue account already uses that email address.');
      }
      await tursoExecute(
        c.env,
        `UPDATE users SET email = ?, updated_at = ? WHERE id = ? AND (email IS NULL OR trim(email) = '' OR email LIKE ?)`,
        [suppliedEmail, new Date().toISOString(), auth.userId, PLACEHOLDER_EMAIL_LIKE]
      );
    }
  }

  await tursoExecute(
    c.env,
    `UPDATE users SET account_type = ?, onboarding_step = 2, updated_at = ? WHERE id = ?`,
    [parsed.data.account_type, new Date().toISOString(), auth.userId]
  );
  return c.json({ success: true, onboarding_step: 2 });
});

onboarding.patch('/step-2', async (c) => {
  const auth = getAuth(c);
  const parsed = onboardingStep2Schema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return jsonError(c, 400, 'invalid_payload', firstIssue(parsed));
  }
  const b = parsed.data;
  await tursoExecute(
    c.env,
    `UPDATE users SET name = ?, business_name = ?, services = ?, volume_per_month = ?, website = ?, fiverr_profile = ?, agency_name = ?, agency_size = ?, brand_primary = ?, brand_secondary = ?, onboarding_step = 3, updated_at = ? WHERE id = ?`,
    [
      b.name.trim(),
      b.business_name ?? null,
      JSON.stringify(b.services ?? []),
      b.volume_per_month ?? null,
      b.website ?? null,
      b.fiverr_profile ?? null,
      b.agency_name ?? null,
      b.agency_size ?? null,
      b.brand_primary ?? null,
      b.brand_secondary ?? null,
      new Date().toISOString(),
      auth.userId,
    ]
  );
  return c.json({ success: true, onboarding_step: 3 });
});

onboarding.post('/website-help', async (c) => {
  const auth = getAuth(c);
  const b = await c.req.json().catch(() => ({}));
  const websiteType = String(b.website_type ?? '').trim();
  const timeline = String(b.timeline ?? '').trim();
  if (!websiteType || !timeline) {
    return jsonError(c, 400, 'invalid_payload', 'website_type and timeline are required.');
  }
  await tursoExecute(
    c.env,
    `INSERT INTO website_help_requests (id, user_id, name, email, website_type, business, timeline, notes, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)`,
    [
      generateId('wh'),
      auth.userId,
      b.name ? String(b.name).slice(0, 200) : null,
      auth.email,
      websiteType.slice(0, 100),
      b.business ? String(b.business).slice(0, 200) : null,
      timeline.slice(0, 100),
      b.notes ? String(b.notes).slice(0, 4000) : null,
      new Date().toISOString(),
    ]
  );
  return c.json({ success: true }, 201);
});

onboarding.patch('/step-4', async (c) => {
  const auth = getAuth(c);
  const parsed = onboardingStep4Schema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return jsonError(c, 400, 'invalid_payload', firstIssue(parsed));
  }
  const newsletter = parsed.data.newsletter_opt_in;
  await tursoExecute(
    c.env,
    `UPDATE users SET newsletter_opt_in = ?, newsletter_opt_in_date = ?, onboarding_step = 5, updated_at = ? WHERE id = ?`,
    [
      newsletter ? 1 : 0,
      newsletter ? new Date().toISOString() : null,
      new Date().toISOString(),
      auth.userId,
    ]
  );
  return c.json({ success: true, onboarding_step: 5 });
});

onboarding.patch('/step-5', async (c) => {
  const auth = getAuth(c);
  const parsed = onboardingStep5Schema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return jsonError(c, 400, 'invalid_payload', firstIssue(parsed));
  }
  if (parsed.data.plan === 'waitlist') {
    // The waitlist is keyed on the authenticated email, so it must exist by
    // now (step 1 collects it when AuthAction did not provide one).
    if (!auth.email.trim()) {
      return jsonError(
        c,
        400,
        'email_required',
        'Add your email address in step 1 before joining the waitlist.'
      );
    }
    const existing = await tursoQuery(
      c.env,
      `SELECT id FROM waitlist WHERE lower(email) = ? AND status = 'pending' LIMIT 1`,
      [auth.email.trim().toLowerCase()]
    );
    if (existing.rows.length === 0) {
      await tursoExecute(
        c.env,
        `INSERT INTO waitlist (id, email, plan_requested, source, status, created_at) VALUES (?, ?, ?, 'onboarding', 'pending', ?)`,
        [
          generateId('wl'),
          auth.email,
          parsed.data.plan_requested ?? 'starter',
          new Date().toISOString(),
        ]
      );
    }
  }
  await tursoExecute(
    c.env,
    `UPDATE users SET onboarding_step = 6, updated_at = ? WHERE id = ?`,
    [new Date().toISOString(), auth.userId]
  );
  createNotification(c.env, { userId: auth.userId, eventType: 'onboarding_completed', title: 'Onboarding complete', body: 'Your account setup is complete. Welcome to Revercue!' }).catch(() => undefined);
  return c.json({ success: true, onboarding_step: 6 });
});

onboarding.patch('/tutorial', async (c) => {
  const auth = getAuth(c);
  const parsed = tutorialSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success || (parsed.data.completed === undefined && parsed.data.skipped === undefined)) {
    return jsonError(c, 400, 'invalid_payload', 'completed or skipped must be a boolean.');
  }
  const column = parsed.data.completed ? 'tutorial_completed' : 'tutorial_skipped';
  await tursoExecute(
    c.env,
    `UPDATE users SET ${column} = 1, updated_at = ? WHERE id = ?`,
    [new Date().toISOString(), auth.userId]
  );
  return c.json({ success: true });
});

export default onboarding;
