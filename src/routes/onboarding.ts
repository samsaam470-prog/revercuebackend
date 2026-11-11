import { Hono } from 'hono';
import { tursoQuery, tursoExecute } from '../utils/turso';
import { userAuthMiddleware } from '../middleware/user-auth';
import type { Bindings } from '../types';

const onboarding = new Hono<{ Bindings: Bindings }>();
onboarding.use('*', userAuthMiddleware);

onboarding.patch('/step-1', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const b = await c.req.json();
  await tursoExecute(c.env, `UPDATE users SET account_type = ?, onboarding_step = 2, updated_at = ? WHERE id = ?`, [b.account_type, new Date().toISOString(), uid]);
  return c.json({ success: true, onboarding_step: 2 });
});

onboarding.patch('/step-2', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const b = await c.req.json();
  await tursoExecute(c.env, `UPDATE users SET name = ?, business_name = ?, services = ?, volume_per_month = ?, website = ?, fiverr_profile = ?, agency_name = ?, agency_size = ?, brand_primary = ?, brand_secondary = ?, onboarding_step = 3, updated_at = ? WHERE id = ?`, [b.name ?? null, b.business_name ?? null, JSON.stringify(b.services ?? []), b.volume_per_month ?? null, b.website ?? null, b.fiverr_profile ?? null, b.agency_name ?? null, b.agency_size ?? null, b.brand_primary ?? null, b.brand_secondary ?? null, new Date().toISOString(), uid]);
  return c.json({ success: true, onboarding_step: 3 });
});

onboarding.patch('/step-4', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const b = await c.req.json();
  await tursoExecute(c.env, `UPDATE users SET newsletter_opt_in = ?, onboarding_step = 5, updated_at = ? WHERE id = ?`, [b.newsletter_opt_in ? 1 : 0, new Date().toISOString(), uid]);
  return c.json({ success: true, onboarding_step: 5 });
});

onboarding.patch('/step-5', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
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
