import { Hono } from 'hono';
import { tursoExecute } from '../utils/turso';
import { userAuthMiddleware } from '../middleware/user-auth';
import type { Bindings } from '../types';

const onboarding = new Hono<{ Bindings: Bindings }>();
onboarding.use('*', userAuthMiddleware);

onboarding.patch('/step-1', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const b = await c.req.json();
  if (!b.account_type || !['freelancer', 'agency'].includes(b.account_type)) {
    return c.json({ error: 'invalid_payload' }, 400);
  }
  await tursoExecute(c.env, `UPDATE users SET account_type = ?, onboarding_step = 2, updated_at = ? WHERE id = ?`, [b.account_type, new Date().toISOString(), uid]);
  return c.json({ success: true, onboarding_step: 2 });
});

onboarding.patch('/step-2', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const b = await c.req.json();
  if (!b.name || String(b.name).trim().length === 0) {
    return c.json({ error: 'invalid_payload', message: 'Name is required.' }, 400);
  }
  await tursoExecute(
    c.env,
    `UPDATE users SET name = ?, business_name = ?, services = ?, volume_per_month = ?, website = ?, fiverr_profile = ?, agency_name = ?, agency_size = ?, brand_primary = ?, brand_secondary = ?, onboarding_step = 3, updated_at = ? WHERE id = ?`,
    [
      b.name ?? null,
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
      uid,
    ]
  );
  return c.json({ success: true, onboarding_step: 3 });
});

onboarding.post('/website-help', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const b = await c.req.json();
  if (!b.website_type || !b.timeline) return c.json({ error: 'invalid_payload' }, 400);
  const { generateId } = await import('../utils/ids');
  await tursoExecute(
    c.env,
    `INSERT INTO website_help_requests (id, user_id, name, email, website_type, business, timeline, notes, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)`,
    [generateId('wh'), uid, b.name ?? null, b.email ?? null, b.website_type, b.business ?? null, b.timeline, b.notes ?? null, new Date().toISOString()]
  );
  return c.json({ success: true }, 201);
});

onboarding.patch('/step-4', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const b = await c.req.json();
  await tursoExecute(c.env, `UPDATE users SET newsletter_opt_in = ?, newsletter_opt_in_date = ?, onboarding_step = 5, updated_at = ? WHERE id = ?`, [b.newsletter_opt_in ? 1 : 0, b.newsletter_opt_in ? new Date().toISOString() : null, new Date().toISOString(), uid]);
  return c.json({ success: true, onboarding_step: 5 });
});

onboarding.patch('/step-5', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const b = await c.req.json();
  if (b.plan === 'waitlist') {
    const { generateId } = await import('../utils/ids');
    const user = await tursoExecute(c.env, `SELECT email FROM users WHERE id = ?`, [uid]);
    await tursoExecute(
      c.env,
      `INSERT INTO waitlist (id, email, plan_requested, source, status, created_at) VALUES (?, ?, ?, 'onboarding', 'pending', ?)`,
      [generateId('wl'), (user as any)?.email ?? '', b.plan_requested ?? 'starter', new Date().toISOString()]
    );
  }
  await tursoExecute(c.env, `UPDATE users SET onboarding_step = 6, updated_at = ? WHERE id = ?`, [new Date().toISOString(), uid]);
  return c.json({ success: true, onboarding_step: 6 });
});

onboarding.patch('/tutorial', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const b = await c.req.json();
  const col = b.completed ? 'tutorial_completed' : 'tutorial_skipped';
  await tursoExecute(c.env, `UPDATE users SET ${col} = 1, updated_at = ? WHERE id = ?`, [new Date().toISOString(), uid]);
  return c.json({ success: true });
});

export default onboarding;
