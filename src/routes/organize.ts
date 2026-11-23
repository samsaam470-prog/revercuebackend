import { Hono } from 'hono';
import { fixWithPatterns } from '../services/patterns';
import { organizeSections, normaliseSection } from '../services/organizer';
import { resolveVisuals } from '../services/visuals';
import { userAuthMiddleware } from '../middleware/user-auth';
import type { Bindings } from '../types';

const organize = new Hono<{ Bindings: Bindings }>();
organize.use('*', userAuthMiddleware);

organize.post('/', async (c) => {
  const uid = (c.get('user' as never) as any).sub;
  const body = await c.req.json().catch(() => ({}));
  const industry = body.industry ? String(body.industry) : 'general';
  const service = body.service ? String(body.service) : 'freelance services';
  const research = body.research ?? body.layer2 ?? {};
  const notes = Array.isArray(research.notes)
    ? research.notes
    : Array.isArray(body.notes)
      ? body.notes
      : [];
  const facts = research.facts ?? body.facts ?? {};
  const requested: string[] = Array.isArray(body.sections)
    ? body.sections.map((section: unknown) => String(section))
    : [];

  try {
    const fixed = await fixWithPatterns(
      c.env,
      {
        user_id: uid,
        client_id: body.client_id ?? null,
        industry,
        service,
        tone: String(body.tone ?? 'formal'),
        sections: requested,
      },
      {
        ...research,
        notes,
        sections: requested.map((section) => ({ id: normaliseSection(section) })),
      }
    );

    const sections = organizeSections({
      client_name: body.client_name ? String(body.client_name) : undefined,
      industry,
      service,
      tone: String(body.tone ?? 'formal'),
      sections: requested,
      notes,
      facts,
    });

    // Keep the organised copy on the result as well, so a caller that only
    // reads `result` still gets the writing and not just the pattern fixes.
    return c.json({
      success: true,
      result: { ...fixed, organized_sections: sections },
      sections,
      notes_used: notes.length,
      tone: String(body.tone ?? fixed.tone ?? 'formal'),
    });
  } catch (err: any) {
    return c.json({ error: 'organize_failed', message: err.message ?? 'Unknown' }, 500);
  }
});

organize.post('/visuals', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!Array.isArray(body.requests)) return c.json({ error: 'invalid_payload' }, 400);
  try {
    const { assets, rejected } = await resolveVisuals(c.env, body.requests);
    return c.json({ success: true, assets, rejected });
  } catch (err: any) {
    return c.json({ error: 'visuals_failed', message: err.message ?? 'Unknown' }, 500);
  }
});

export default organize;
