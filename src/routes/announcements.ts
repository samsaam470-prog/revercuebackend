import { Hono } from 'hono';
import { tursoQuery, tursoExecute } from '../utils/turso';
import { userAuthMiddleware, getAuth } from '../middleware/user-auth';
import type { Bindings } from '../types';

const announcements = new Hono<{ Bindings: Bindings }>();
announcements.use('*', userAuthMiddleware);

// Returns announcements that are published and active for this user.
announcements.get('/', async (c) => {
  const auth = getAuth(c);
  const now = new Date().toISOString();
  // Fetch published announcements whose window is active.
  const rows = await tursoQuery(
    c.env,
    `SELECT * FROM announcements
     WHERE status = 'published'
       AND (starts_at IS NULL OR starts_at <= ?)
       AND (expires_at IS NULL OR expires_at >= ?)
     ORDER BY published_at DESC, created_at DESC`,
    [now, now]
  );

  // Filter by target audience / plans.
  const userRow = await tursoQuery(c.env, `SELECT plan FROM users WHERE id = ? LIMIT 1`, [auth.userId]);
  const plan = userRow.rows.length > 0 ? String(userRow.rows[0].plan ?? 'free') : 'free';

  const result: any[] = [];
  for (const ann of rows.rows) {
    const audience = ann.target_audience ?? 'all';
    let include = false;
    if (audience === 'all') include = true;
    else if (audience === 'free' && plan === 'free') include = true;
    else if (audience === 'paid' && plan !== 'free') include = true;
    else if (audience === 'active_subscribers' && plan !== 'free') include = true;
    else if (audience === 'plans' && ann.target_plans) {
      try {
        const plans = JSON.parse(ann.target_plans);
        if (Array.isArray(plans) && plans.includes(plan)) include = true;
      } catch {}
    }
    if (!include) continue;

    // Check if already seen/dismissed.
    const view = await tursoQuery(
      c.env,
      `SELECT seen_at, dismissed FROM announcement_views WHERE user_id = ? AND announcement_id = ? LIMIT 1`,
      [auth.userId, ann.id]
    );
    const seen = view.rows.length > 0;
    const dismissed = seen && Number(view.rows[0].dismissed) === 1;
    if (dismissed) continue;

    result.push({ ...ann, seen });
  }
  return c.json({ data: result });
});

// Mark an announcement as seen.
announcements.post('/:id/seen', async (c) => {
  const auth = getAuth(c);
  const id = c.req.param('id');
  const now = new Date().toISOString();
  await tursoExecute(
    c.env,
    `INSERT INTO announcement_views (user_id, announcement_id, seen_at, dismissed) VALUES (?, ?, ?, 0)
     ON CONFLICT(user_id, announcement_id) DO UPDATE SET seen_at = excluded.seen_at`,
    [auth.userId, id, now]
  );
  return c.json({ success: true });
});

// Dismiss an announcement.
announcements.post('/:id/dismiss', async (c) => {
  const auth = getAuth(c);
  const id = c.req.param('id');
  const now = new Date().toISOString();
  await tursoExecute(
    c.env,
    `INSERT INTO announcement_views (user_id, announcement_id, seen_at, dismissed) VALUES (?, ?, ?, 1)
     ON CONFLICT(user_id, announcement_id) DO UPDATE SET dismissed = 1`,
    [auth.userId, id, now]
  );
  return c.json({ success: true });
});

export default announcements;