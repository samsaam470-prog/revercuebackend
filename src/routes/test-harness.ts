import { Hono } from 'hono';
import type { Bindings } from '../types';
import {
  ACTIVE_DOCUMENT_LIMIT,
  ADAPTIVE_FORM_LIMIT,
  ARCHIVE_COUNT_LIMIT,
  ARCHIVE_RETENTION_DAYS,
  CUSTOM_TEMPLATE_LIMIT,
  DRAFT_RETENTION_DAYS,
  DOCUMENT_RETENTION_MONTHS,
  EMAIL_NOTIFICATIONS,
  ADVANCED_TRACKING,
  CUSTOM_THANK_YOU,
  WHAT_REVERCUE_KNOWS,
  REVENUE_TRACKER,
  EXPENSE_ENTRY,
  PATTERN_LEARNING,
  PRICE_SUGGESTION,
  NOTES_PER_CLIENT,
  PASSWORD_PROTECTED_LIMIT,
  SAVED_FAQ_LIMIT,
  SAVED_PACKAGE_LIMIT,
  STORAGE_MB,
} from '../config/constants';

const router = new Hono<{ Bindings: Bindings }>();
const PLAN_NAMES = ['free', 'starter', 'growth', 'scale'] as const;
type TestPlan = (typeof PLAN_NAMES)[number];
const TOKEN_TTL_SECONDS = 20 * 60;

function base64url(value: string | Uint8Array): string {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('=', '').replaceAll('+', '-').replaceAll('/', '_');
}

function fromBase64url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized + '='.repeat((4 - (normalized.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function sign(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return base64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value))));
}

async function issueToken(plan: TestPlan, secret: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    sub: 'isolated-revercue-test-account',
    plan,
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,
    scope: 'test-harness',
  }));
  const unsigned = header + '.' + payload;
  return unsigned + '.' + await sign(unsigned, secret);
}

async function readToken(token: string, secret: string): Promise<{ plan: TestPlan } | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const expected = await sign(parts[0] + '.' + parts[1], secret);
  if (expected.length !== parts[2].length) return null;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) mismatch |= expected.charCodeAt(i) ^ parts[2].charCodeAt(i);
  if (mismatch !== 0) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(fromBase64url(parts[1])));
    if (payload.scope !== 'test-harness' || payload.sub !== 'isolated-revercue-test-account') return null;
    if (typeof payload.exp !== 'number' || payload.exp <= Math.floor(Date.now() / 1000)) return null;
    if (!PLAN_NAMES.includes(payload.plan)) return null;
    return { plan: payload.plan as TestPlan };
  } catch {
    return null;
  }
}

function enabled(c: { env: Bindings }): boolean {
  return c.env.ENVIRONMENT !== 'production'
    && c.env.TEST_HARNESS_ENABLED === 'true'
    && Boolean(c.env.test_account_name && c.env.test_account_pass)
    && Boolean(c.env.test_harness_key && c.env.test_harness_key.length >= 32);
}

async function requireSession(c: any): Promise<{ plan: TestPlan } | null> {
  const authorization = c.req.header('Authorization') || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  return token && c.env.test_harness_key ? readToken(token, c.env.test_harness_key) : null;
}

function planSnapshot(plan: TestPlan) {
  return {
    plan,
    active_documents: ACTIVE_DOCUMENT_LIMIT[plan],
    storage_mb: STORAGE_MB[plan],
    document_retention_months: DOCUMENT_RETENTION_MONTHS[plan],
    draft_retention_days: DRAFT_RETENTION_DAYS[plan],
    archive_count: ARCHIVE_COUNT_LIMIT[plan],
    archive_retention_days: ARCHIVE_RETENTION_DAYS[plan],
    notes_per_client: NOTES_PER_CLIENT[plan],
    custom_templates: CUSTOM_TEMPLATE_LIMIT[plan],
    saved_faqs: SAVED_FAQ_LIMIT[plan],
    saved_packages: SAVED_PACKAGE_LIMIT[plan],
    password_protected_documents: PASSWORD_PROTECTED_LIMIT[plan],
    adaptive_forms: ADAPTIVE_FORM_LIMIT[plan],
    email_notifications: EMAIL_NOTIFICATIONS[plan],
    advanced_tracking: ADVANCED_TRACKING[plan],
    custom_thank_you: CUSTOM_THANK_YOU[plan],
    what_revercue_knows: WHAT_REVERCUE_KNOWS[plan],
    revenue_tracker: REVENUE_TRACKER[plan],
    expense_entry: EXPENSE_ENTRY[plan],
    pattern_learning: PATTERN_LEARNING[plan],
    price_suggestion: PRICE_SUGGESTION[plan],
  };
}

router.use('*', async (c, next) => {
  if (!enabled(c)) return c.json({ error: 'not_found', message: 'Test harness is unavailable.' }, 404);
  await next();
});

router.post('/session', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const name = String(body.name ?? '');
  const password = String(body.password ?? '');
  if (name !== c.env.test_account_name || password !== c.env.test_account_pass) {
    return c.json({ error: 'invalid_credentials', message: 'The test account credentials were not accepted.' }, 401);
  }
  const token = await issueToken('free', c.env.test_harness_key!);
  return c.json({
    success: true,
    token,
    expires_in: TOKEN_TTL_SECONDS,
    account: { name: 'Isolated test account', email: 'test-account@invalid.revercue', plan: 'free' },
    persistence: 'none',
    notice: 'This is a synthetic test session. It does not create a Revercue user or write to D1 or Turso.',
  });
});

router.post('/plan', async (c) => {
  const session = await requireSession(c);
  if (!session) return c.json({ error: 'unauthorized', message: 'Sign in to the isolated test harness again.' }, 401);
  const body = await c.req.json().catch(() => ({}));
  const plan = String(body.plan ?? '') as TestPlan;
  if (!PLAN_NAMES.includes(plan)) return c.json({ error: 'invalid_plan', message: 'Choose Free, Starter, Growth or Scale.' }, 400);
  return c.json({ success: true, token: await issueToken(plan, c.env.test_harness_key!), plan: planSnapshot(plan) });
});

router.get('/workspace', async (c) => {
  const session = await requireSession(c);
  if (!session) return c.json({ error: 'unauthorized', message: 'Sign in to the isolated test harness again.' }, 401);
  return c.json({
    plan: planSnapshot(session.plan),
    dashboard: {
      active_documents: 3,
      clients: 2,
      follow_ups_due: 1,
      revenue_this_month: 2400,
      pending_total: 850,
      pending_count: 1,
      unread_notifications: 2,
    },
    clients: [
      { id: 'fixture-client-1', name: 'Alex Morgan', company: 'Northstar Studio', email: 'alex@example.invalid' },
      { id: 'fixture-client-2', name: 'Jamie Patel', company: 'Fieldwork Co', email: 'jamie@example.invalid' },
    ],
    documents: [
      { id: 'fixture-proposal-1', type: 'proposal', title: 'Brand identity proposal', status: 'published' },
      { id: 'fixture-contract-1', type: 'contract', title: 'Website services agreement', status: 'draft' },
      { id: 'fixture-invoice-1', type: 'invoice', title: 'INV-TEST-001', status: 'overdue' },
      { id: 'fixture-form-1', type: 'form', title: 'Project requirements', status: 'published' },
    ],
    synthetic: true,
  });
});

router.get('/checks', async (c) => {
  const session = await requireSession(c);
  if (!session) return c.json({ error: 'unauthorized', message: 'Sign in to the isolated test harness again.' }, 401);
  const plan = planSnapshot(session.plan);
  const checks = [
    { id: 'dashboard-fixture', label: 'Dashboard data fixture', status: 'simulated', detail: 'Synthetic dashboard metrics are available.' },
    { id: 'client-fixture', label: 'Client records fixture', status: 'simulated', detail: 'Two synthetic client records are available.' },
    { id: 'proposal-fixture', label: 'Proposal record fixture', status: 'simulated', detail: 'A synthetic published proposal is available.' },
    { id: 'contract-fixture', label: 'Contract record fixture', status: 'simulated', detail: 'A synthetic draft contract is available.' },
    { id: 'form-fixture', label: 'Requirement form fixture', status: 'simulated', detail: 'A synthetic published form is available.' },
    { id: 'invoice-fixture', label: 'Invoice record fixture', status: 'simulated', detail: 'A synthetic overdue invoice is available.' },
    { id: 'plan-limits', label: 'Plan limits loaded from backend constants', status: 'passed', detail: 'Plan entitlement snapshot generated from the current backend plan constants.' },
    { id: 'teams-excluded', label: 'Teams plan excluded', status: PLAN_NAMES.includes(session.plan), detail: 'Only Free, Starter, Growth and Scale can be selected.' },
    { id: 'database-isolation', label: 'No D1 or Turso writes', status: 'passed', detail: 'This test harness route does not call either database.' },
  ];
  return c.json({ plan, checks, note: 'Simulated fixtures are not end-to-end tests of the production dashboard or CRUD routes.' });
});

export default router;
