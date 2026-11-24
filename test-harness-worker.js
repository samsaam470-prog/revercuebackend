const PLAN = {
  free: { active_documents: 5, storage_mb: 50, document_retention_months: 1, draft_retention_days: 10, archive_count: 5, archive_retention_days: 15, notes_per_client: 3, custom_templates: 0, saved_faqs: 0, saved_packages: 0, password_protected_documents: 0, adaptive_forms: 0, email_notifications: false, advanced_tracking: false, custom_thank_you: false, what_revercue_knows: false, revenue_tracker: false, expense_entry: false, pattern_learning: false, price_suggestion: false },
  starter: { active_documents: 20, storage_mb: 100, document_retention_months: 3, draft_retention_days: 30, archive_count: 15, archive_retention_days: 30, notes_per_client: 10, custom_templates: 3, saved_faqs: 0, saved_packages: 0, password_protected_documents: 0, adaptive_forms: 0, email_notifications: false, advanced_tracking: false, custom_thank_you: false, what_revercue_knows: false, revenue_tracker: false, expense_entry: false, pattern_learning: false, price_suggestion: false },
  growth: { active_documents: 100, storage_mb: 1024, document_retention_months: 12, draft_retention_days: 50, archive_count: 30, archive_retention_days: 30, notes_per_client: 'Unlimited', custom_templates: 10, saved_faqs: 10, saved_packages: 10, password_protected_documents: 15, adaptive_forms: 3, email_notifications: true, advanced_tracking: false, custom_thank_you: false, what_revercue_knows: false, revenue_tracker: false, expense_entry: false, pattern_learning: false, price_suggestion: false },
  scale: { active_documents: 300, storage_mb: 5120, document_retention_months: 24, draft_retention_days: 80, archive_count: 30, archive_retention_days: 30, notes_per_client: 'Unlimited', custom_templates: 15, saved_faqs: 30, saved_packages: 15, password_protected_documents: 50, adaptive_forms: 15, email_notifications: true, advanced_tracking: true, custom_thank_you: true, what_revercue_knows: true, revenue_tracker: true, expense_entry: true, pattern_learning: true, price_suggestion: true }
};
const allowedOrigin = 'https://test-isolated-plan-harness.revercue.pages.dev';
const plans = Object.keys(PLAN);
const ttl = 1200;
const b64 = (value) => { const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value; let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary).replaceAll('=', '').replaceAll('+', '-').replaceAll('/', '_'); };
const unb64 = (value) => new TextDecoder().decode(Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4)), c => c.charCodeAt(0)));
async function signature(value, secret) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value))));
}
async function issue(plan, secret) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64(JSON.stringify({ sub: 'isolated-revercue-test-account', scope: 'test-harness', plan, iat: now, exp: now + ttl }));
  const input = head + '.' + body;
  return input + '.' + await signature(input, secret);
}
async function verify(token, secret) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const expected = await signature(parts[0] + '.' + parts[1], secret);
  if (expected.length !== parts[2].length) return null;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) mismatch |= expected.charCodeAt(i) ^ parts[2].charCodeAt(i);
  if (mismatch) return null;
  try {
    const payload = JSON.parse(unb64(parts[1]));
    if (payload.sub !== 'isolated-revercue-test-account' || payload.scope !== 'test-harness' || payload.exp <= Date.now() / 1000 || !plans.includes(payload.plan)) return null;
    return payload;
  } catch { return null; }
}
function json(data, status = 200, origin = allowedOrigin) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' } });
}
function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
async function session(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  return verify(auth.slice(7), env.test_harness_key);
}
export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    if (origin !== allowedOrigin) return new Response('Forbidden origin', { status: 403 });
    const cors = { 'Access-Control-Allow-Origin': allowedOrigin, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '600', 'Vary': 'Origin' };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/test-harness/')) return json({ error: 'not_found' }, 404);
    if (!env.test_account_name || !env.test_account_pass || !env.test_harness_key || env.test_harness_key.length < 32) return json({ error: 'test_harness_not_configured' }, 503);
    try {
      if (url.pathname === '/api/test-harness/session' && request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        if (!constantTimeEqual(String(body.name || ''), env.test_account_name) || !constantTimeEqual(String(body.password || ''), env.test_account_pass)) return json({ error: 'invalid_credentials', message: 'The test account credentials were not accepted.' }, 401);
        return json({ success: true, token: await issue('free', env.test_harness_key), expires_in: ttl, persistence: 'none', notice: 'Synthetic session only. No Revercue account is created and no D1 or Turso data is read or written.' });
      }
      if (url.pathname === '/api/test-harness/plan' && request.method === 'POST') {
        const current = await session(request, env);
        if (!current) return json({ error: 'unauthorized', message: 'Start a new test session.' }, 401);
        const body = await request.json().catch(() => ({}));
        if (!plans.includes(body.plan)) return json({ error: 'invalid_plan', message: 'Choose Free, Starter, Growth or Scale.' }, 400);
        return json({ success: true, token: await issue(body.plan, env.test_harness_key), plan: { plan: body.plan, ...PLAN[body.plan] } });
      }
      if (url.pathname === '/api/test-harness/workspace' && request.method === 'GET') {
        const current = await session(request, env);
        if (!current) return json({ error: 'unauthorized', message: 'Start a new test session.' }, 401);
        return json({
          plan: { plan: current.plan, ...PLAN[current.plan] },
          dashboard: { active_documents: 3, clients: 2, follow_ups_due: 1, revenue_this_month: 2400, pending_total: 850, pending_count: 1, unread_notifications: 2 },
          clients: [
            { id: 'fixture-client-1', name: 'Alex Morgan', company: 'Northstar Studio', email: 'alex@example.invalid' },
            { id: 'fixture-client-2', name: 'Jamie Patel', company: 'Fieldwork Co', email: 'jamie@example.invalid' }
          ],
          documents: [
            { id: 'fixture-proposal-1', type: 'proposal', title: 'Brand identity proposal', status: 'published' },
            { id: 'fixture-contract-1', type: 'contract', title: 'Website services agreement', status: 'draft' },
            { id: 'fixture-invoice-1', type: 'invoice', title: 'INV-TEST-001', status: 'overdue' },
            { id: 'fixture-form-1', type: 'form', title: 'Project requirements', status: 'published' }
          ],
          synthetic: true
        });
      }
      if (url.pathname === '/api/test-harness/checks' && request.method === 'GET') {
        const current = await session(request, env);
        if (!current) return json({ error: 'unauthorized', message: 'Start a new test session.' }, 401);
        return json({
          plan: current.plan,
          checks: [
            { id: 'dashboard-fixture', label: 'Dashboard fixture', status: 'simulated', detail: 'Synthetic dashboard data is served.' },
            { id: 'client-fixture', label: 'Client fixture', status: 'simulated', detail: 'Two sample clients are available.' },
            { id: 'proposal-fixture', label: 'Proposal fixture', status: 'simulated', detail: 'A sample published proposal is available.' },
            { id: 'contract-fixture', label: 'Contract fixture', status: 'simulated', detail: 'A sample draft contract is available.' },
            { id: 'form-fixture', label: 'Requirement form fixture', status: 'simulated', detail: 'A sample form is available.' },
            { id: 'invoice-fixture', label: 'Invoice fixture', status: 'simulated', detail: 'A sample overdue invoice is available.' },
            { id: 'plan-limits', label: 'Plan limits loaded', status: 'passed', detail: 'Plan values are from the backend plan constants snapshot.' },
            { id: 'teams-excluded', label: 'Teams excluded', status: 'passed', detail: 'Only Free, Starter, Growth and Scale can be selected.' },
            { id: 'database-isolation', label: 'No database access', status: 'passed', detail: 'The test Worker has no D1, Turso, R2 or KV bindings.' }
          ],
          note: 'These fixtures do not exercise production CRUD routes or the live dashboard.'
        });
      }
      return json({ error: 'not_found' }, 404);
    } catch {
      return json({ error: 'test_harness_error', message: 'The isolated test request failed.' }, 500);
    }
  }
};
