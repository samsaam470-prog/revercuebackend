import { Hono } from 'hono';
import { tursoQuery, tursoExecute } from '../utils/turso';
import { generateId } from '../utils/ids';
import { insertDynamic } from '../utils/dynamic-insert';
import { hashIp, clientIp, clientUserAgent } from '../utils/http';
import { jsonError } from '../utils/api-errors';
import { checkRateLimit } from '../services/rate-limit';
import { isValidEmail, normalizeEmail, sendEmail } from '../services/email';
import { adminLeadEmail, newsletterConfirmEmail } from '../services/email-templates';
import { createNewsletterToken, nextStatus, verifyNewsletterToken, type SubscriberStatus } from '../services/newsletter';
import { MARKETING_MESSAGE_MAX } from '../config/constants';
import type { Bindings } from '../types';

/**
 * Public marketing endpoints: newsletter, contact, waitlist and beta.
 * All of them are rate limited, validate input, persist before attempting any
 * email, and never expose stored data.
 */
const marketing = new Hono<{ Bindings: Bindings }>();

function adminEmail(env: Bindings): string | null {
  return env.ADMIN_NOTIFICATION_EMAIL?.trim() || null;
}

function appUrl(env: Bindings): string {
  return (env.APP_URL || env.FRONTEND_ORIGIN || 'https://revercue.pages.dev').replace(/\/$/, '');
}

async function notifyAdmin(
  env: Bindings,
  kind: 'contact' | 'beta' | 'waitlist' | 'newsletter',
  email: string,
  summary: string
): Promise<void> {
  const to = adminEmail(env);
  if (!to) {
    console.warn('ADMIN_NOTIFICATION_EMAIL_MISSING', kind);
    return;
  }
  const rendered = adminLeadEmail({
    kind,
    email,
    summary,
    adminUrl: `${appUrl(env)}/admin`,
  });
  await sendEmail(env, {
    to,
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
    kind: 'admin_lead',
  }).catch((error) => console.error('ADMIN_LEAD_EMAIL_FAILED', kind, error));
}

// ---------------------------------------------------------------------------
// Newsletter
// ---------------------------------------------------------------------------

marketing.post('/newsletter', async (c) => {
  const ip = clientIp(c);
  const limit = await checkRateLimit(c.env, `newsletter:${ip}`, 5, 3600);
  if (!limit.allowed) return jsonError(c, 429, 'rate_limited', 'Too many attempts.', { retry_after: limit.retryAfter });

  const body = await c.req.json().catch(() => ({}));
  const rawEmail = String(body.email ?? '');
  if (!isValidEmail(rawEmail)) return jsonError(c, 400, 'invalid_email', 'Enter a valid email address.');
  const email = normalizeEmail(rawEmail);

  const existing = await tursoQuery(
    c.env,
    `SELECT id, status FROM newsletter_subscribers WHERE email = ? LIMIT 1`,
    [email]
  );
  const current = (existing.rows[0]?.status as SubscriberStatus | undefined) ?? null;
  if (current === 'active') {
    return c.json({ success: true, status: 'active', already_subscribed: true, email_sent: false });
  }

  const now = new Date().toISOString();
  const ipHash = await hashIp(ip, c.env.USER_JWT_KEY);
  const status = nextStatus(current, 'subscribe');

  if (existing.rows.length > 0) {
    await tursoExecute(
      c.env,
      `UPDATE newsletter_subscribers SET status = ?, consent_source = COALESCE(consent_source, ?), consent_at = COALESCE(consent_at, ?), unsubscribed_at = NULL, updated_at = ? WHERE email = ?`,
      [status, 'website', now, now, email]
    );
  } else {
    await tursoExecute(
      c.env,
      `INSERT INTO newsletter_subscribers (id, email, status, consent_source, consent_at, confirmed_at, unsubscribed_at, user_id, ip_hash, created_at, updated_at)
       VALUES (?, ?, ?, 'website', ?, NULL, NULL, NULL, ?, ?, ?)`,
      [generateId('nl'), email, status, now, ipHash, now, now]
    );
  }

  const confirmToken = await createNewsletterToken(c.env, email, 'confirm');
  const unsubscribeToken = await createNewsletterToken(c.env, email, 'unsubscribe');
  const rendered = newsletterConfirmEmail({
    confirmUrl: `${appUrl(c.env)}/api/newsletter/confirm?token=${encodeURIComponent(confirmToken)}`,
    unsubscribeUrl: `${appUrl(c.env)}/api/newsletter/unsubscribe?token=${encodeURIComponent(unsubscribeToken)}`,
  });
  const sent = await sendEmail(c.env, {
    to: email,
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
    kind: 'newsletter_confirm',
    idempotencyKey: `newsletter-confirm:${email}:${now.slice(0, 10)}`,
  });

  return c.json({ success: true, status, email_sent: sent.ok }, 201);
});

marketing.get('/newsletter/confirm', async (c) => {
  const token = c.req.query('token') ?? '';
  const verified = await verifyNewsletterToken(c.env, token, 'confirm');
  if (!verified.ok) return jsonError(c, 400, 'invalid_token', 'This confirmation link is not valid or has expired.');
  await tursoExecute(
    c.env,
    `UPDATE newsletter_subscribers SET status = 'active', confirmed_at = COALESCE(confirmed_at, ?), unsubscribed_at = NULL, updated_at = ? WHERE email = ?`,
    [new Date().toISOString(), new Date().toISOString(), verified.email]
  );
  return c.json({ success: true, status: 'active', email: verified.email });
});

marketing.get('/newsletter/unsubscribe', async (c) => {
  const token = c.req.query('token') ?? '';
  const verified = await verifyNewsletterToken(c.env, token, 'unsubscribe');
  if (!verified.ok) return jsonError(c, 400, 'invalid_token', 'This unsubscribe link is not valid or has expired.');
  await tursoExecute(
    c.env,
    `UPDATE newsletter_subscribers SET status = 'unsubscribed', unsubscribed_at = ?, updated_at = ? WHERE email = ?`,
    [new Date().toISOString(), new Date().toISOString(), verified.email]
  );
  return c.json({ success: true, status: 'unsubscribed', email: verified.email });
});

marketing.post('/newsletter/unsubscribe', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const token = String(body.token ?? '');
  const verified = await verifyNewsletterToken(c.env, token, 'unsubscribe');
  if (!verified.ok) return jsonError(c, 400, 'invalid_token', 'A valid unsubscribe token is required.');
  await tursoExecute(
    c.env,
    `UPDATE newsletter_subscribers SET status = 'unsubscribed', unsubscribed_at = ?, updated_at = ? WHERE email = ?`,
    [new Date().toISOString(), new Date().toISOString(), verified.email]
  );
  return c.json({ success: true, status: 'unsubscribed' });
});

// ---------------------------------------------------------------------------
// Contact
// ---------------------------------------------------------------------------

marketing.post('/contact', async (c) => {
  const ip = clientIp(c);
  const limit = await checkRateLimit(c.env, `contact:${ip}`, 3, 3600);
  if (!limit.allowed) return jsonError(c, 429, 'rate_limited', 'Too many messages. Try again later.', { retry_after: limit.retryAfter });

  const body = await c.req.json().catch(() => ({}));
  const name = String(body.name ?? '').trim();
  const rawEmail = String(body.email ?? '');
  const topic = String(body.topic ?? body.subject ?? 'General').trim().slice(0, 120);
  const message = String(body.message ?? '').trim();

  if (name.length < 1 || name.length > 200) return jsonError(c, 400, 'invalid_payload', 'Enter your name.');
  if (!isValidEmail(rawEmail)) return jsonError(c, 400, 'invalid_email', 'Enter a valid email address.');
  if (message.length < 5) return jsonError(c, 400, 'invalid_payload', 'Tell us a little more.');
  if (message.length > MARKETING_MESSAGE_MAX) return jsonError(c, 413, 'message_too_long', 'The message is too long.');
  if (String(body.website ?? '').trim()) {
    // Honeypot field filled: silently accept without storing (bot).
    return c.json({ success: true }, 201);
  }

  const email = normalizeEmail(rawEmail);
  const now = new Date().toISOString();
  try {
    await insertDynamic(c.env, 'contact_messages', {
      id: generateId('ct'),
      name,
      email,
      subject: topic,
      topic,
      message,
      status: 'new',
      ip_hash: await hashIp(ip, c.env.USER_JWT_KEY),
      user_agent: clientUserAgent(c).slice(0, 200),
      created_at: now,
    });
  } catch (error) {
    console.error('CONTACT_PERSIST_FAILED', error);
    return jsonError(c, 500, 'save_failed', 'Your message could not be saved. Please try again.');
  }

  await notifyAdmin(c.env, 'contact', email, `${name} — ${topic}\n\n${message}`);
  return c.json({ success: true }, 201);
});

// ---------------------------------------------------------------------------
// Waitlist
// ---------------------------------------------------------------------------

marketing.post('/waitlist', async (c) => {
  const ip = clientIp(c);
  const limit = await checkRateLimit(c.env, `waitlist:${ip}`, 5, 3600);
  if (!limit.allowed) return jsonError(c, 429, 'rate_limited', 'Too many attempts.', { retry_after: limit.retryAfter });

  const body = await c.req.json().catch(() => ({}));
  const rawEmail = String(body.email ?? '');
  if (!isValidEmail(rawEmail)) return jsonError(c, 400, 'invalid_email', 'Enter a valid email address.');
  const email = normalizeEmail(rawEmail);
  const plan = ['starter', 'growth', 'scale', 'teams'].includes(String(body.plan ?? '')) ? String(body.plan) : 'starter';

  const existing = await tursoQuery(c.env, `SELECT id FROM waitlist WHERE lower(email) = ? LIMIT 1`, [email]);
  if (existing.rows.length > 0) {
    return c.json({ success: true, already_registered: true });
  }

  const now = new Date().toISOString();
  try {
    await insertDynamic(c.env, 'waitlist', {
      id: generateId('wl'),
      email,
      plan_requested: plan,
      source: String(body.source ?? 'website').slice(0, 60),
      status: 'pending',
      created_at: now,
    });
  } catch (error) {
    console.error('WAITLIST_PERSIST_FAILED', error);
    return jsonError(c, 500, 'save_failed', 'You could not be added to the waitlist. Please try again.');
  }

  await notifyAdmin(c.env, 'waitlist', email, `Requested plan: ${plan}`);
  return c.json({ success: true }, 201);
});

// ---------------------------------------------------------------------------
// Beta
// ---------------------------------------------------------------------------

marketing.post('/beta', async (c) => {
  const ip = clientIp(c);
  const limit = await checkRateLimit(c.env, `beta:${ip}`, 3, 3600);
  if (!limit.allowed) return jsonError(c, 429, 'rate_limited', 'Too many applications.', { retry_after: limit.retryAfter });

  const body = await c.req.json().catch(() => ({}));
  const name = String(body.name ?? '').trim();
  const rawEmail = String(body.email ?? '');
  const accountType = String(body.account_type ?? '').trim();
  const services = Array.isArray(body.services) ? body.services.map((s: unknown) => String(s).slice(0, 60)).slice(0, 20) : [];
  const volume = String(body.proposals_per_month ?? '').slice(0, 40);
  const whatToTest = String(body.what_to_test ?? '').slice(0, 2000);

  if (name.length < 1 || name.length > 200) return jsonError(c, 400, 'invalid_payload', 'Enter your name.');
  if (!isValidEmail(rawEmail)) return jsonError(c, 400, 'invalid_email', 'Enter a valid email address.');
  if (!['freelancer', 'agency'].includes(accountType)) {
    return jsonError(c, 400, 'invalid_payload', 'Choose freelancer or agency.');
  }
  if (!volume) return jsonError(c, 400, 'invalid_payload', 'Tell us how many proposals you send per month.');

  const email = normalizeEmail(rawEmail);
  const existing = await tursoQuery(c.env, `SELECT id FROM beta_testers WHERE lower(email) = ? LIMIT 1`, [email]);
  if (existing.rows.length > 0) {
    return c.json({ success: true, already_applied: true });
  }

  const now = new Date().toISOString();
  try {
    await insertDynamic(c.env, 'beta_testers', {
      id: generateId('bt'),
      name,
      email,
      account_type: accountType,
      services: JSON.stringify(services),
      proposals_per_month: volume,
      what_to_test: whatToTest,
      status: 'new',
      created_at: now,
    });
  } catch (error) {
    console.error('BETA_PERSIST_FAILED', error);
    return jsonError(c, 500, 'save_failed', 'Your application could not be saved. Please try again.');
  }

  await notifyAdmin(
    c.env,
    'beta',
    email,
    `${name} (${accountType})\nServices: ${services.join(', ') || '-'}\nProposals/month: ${volume}\nWants to test: ${whatToTest || '-'}`
  );
  return c.json({ success: true }, 201);
});

export default marketing;
