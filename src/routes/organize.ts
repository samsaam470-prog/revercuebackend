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
  const industry = body.industry ? String(body.industry).trim().slice(0, 160) : '';
  const service = body.service ? String(body.service).trim().slice(0, 160) : '';
  const research = body.research ?? body.layer2 ?? {};
  const rawNotes = Array.isArray(research.notes)
    ? research.notes
    : Array.isArray(body.notes)
      ? body.notes
      : [];
  const notes = rawNotes.slice(0, 40).map((note: any) => ({
    title: String(note?.title ?? '').slice(0, 200),
    body: String(note?.body ?? '').slice(0, 1200),
    source: String(note?.source ?? '').slice(0, 200),
    kind: ['client', 'web', 'background'].includes(String(note?.kind)) ? note.kind : undefined,
  })).filter((note: any) => note.title || note.body);
  const rawFacts = research.facts ?? body.facts ?? {};
  const facts = {
    business_name: String(rawFacts?.business_name ?? '').slice(0, 200) || undefined,
    value_prop: String(rawFacts?.value_prop ?? '').slice(0, 600) || undefined,
    key_points: Array.isArray(rawFacts?.key_points) ? rawFacts.key_points.slice(0, 8).map((item: unknown) => String(item).slice(0, 240)) : [],
    location: String(rawFacts?.location ?? '').slice(0, 200) || undefined,
  };
  const brief = body.brief && typeof body.brief === 'object' ? body.brief : {};
  const packages = (Array.isArray(brief.packages) ? brief.packages : Array.isArray(body.packages) ? body.packages : [])
    .slice(0, 20)
    .map((item: any) => ({
      name: String(item?.name ?? '').slice(0, 120),
      price: item?.price === undefined || item?.price === null || item?.price === '' ? undefined : Number.isFinite(Number(item.price)) ? Number(item.price) : undefined,
      deliverables: String(item?.deliverables ?? item?.description ?? '').slice(0, 1200),
    }));
  const requested: string[] = Array.isArray(body.sections)
    ? body.sections.slice(0, 24).map((section: unknown) => String(section).trim().slice(0, 100)).filter(Boolean)
    : [];

  try {
    // Patterns are optional context. If the learner fails, the section copy
    // below is still returned instead of failing the whole draft.
    let fixed: any = {};
    try {
      fixed = await fixWithPatterns(
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
    } catch (error) {
      console.error('ORGANIZE_PATTERNS_FAILED', (error as Error)?.message ?? error);
      fixed = { tone: String(body.tone ?? 'formal') };
    }

    const sections = organizeSections({
      client_name: body.client_name ? String(body.client_name).slice(0, 200) : undefined,
      business_name: body.business_name ? String(body.business_name).slice(0, 200) : undefined,
      business_website: body.business_website ? String(body.business_website).slice(0, 500) : undefined,
      business_description: body.business_description ? String(body.business_description).slice(0, 600) : undefined,
      industry,
      service,
      tone: String(body.tone ?? 'formal'),
      sections: requested,
      notes,
      facts,
      problem: brief.problem ?? body.problem,
      target_audience: brief.target_audience ?? body.target_audience,
      timeline: brief.timeline ?? body.timeline,
      cta: brief.cta ?? body.cta,
      scope: brief.scope ?? body.scope,
      packages,
    });

    // Keep the organised copy on the result as well, so a caller that only
    // reads `result` still gets the writing and not just the pattern fixes.
    const clientSpecificNotes = notes.filter((note: any) => note.kind === 'client' || (!note.kind && !['wikipedia', 'duckduckgo'].includes(String(note.source ?? '').toLowerCase())));
    const backgroundNotes = notes.filter((note: any) => note.kind === 'background' || note.kind === 'web' || ['wikipedia', 'duckduckgo'].includes(String(note.source ?? '').toLowerCase()));
    const includesSection = (key: string) => requested.some((section) => normaliseSection(section) === key);
    const missingInformation = [
      !body.client_name ? 'client name' : null,
      includesSection('introduction') && !body.service ? 'service description' : null,
      includesSection('introduction') && !brief.problem ? 'client problem or goal' : null,
      includesSection('timeline') && !brief.timeline ? 'agreed timeline' : null,
      includesSection('scope') && !brief.scope && !packages.some((item: any) => String(item.deliverables ?? '').trim()) ? 'confirmed scope' : null,
      includesSection('pricing') && packages.length === 0 ? 'confirmed packages or pricing' : null,
    ].filter(Boolean);
    const warnings = [
      clientSpecificNotes.length === 0 ? 'No client-specific research was available; generated copy relies on the supplied brief and deterministic patterns.' : null,
      backgroundNotes.length > 0 ? 'Industry/background research is treated as context and is not presented as a verified fact about the client.' : null,
    ].filter(Boolean);

    return c.json({
      success: true,
      result: { ...fixed, organized_sections: sections },
      sections,
      notes_used: notes.length,
      tone: String(body.tone ?? fixed?.tone ?? 'formal'),
      provenance: {
        source: 'deterministic_patterns',
        client_specific_notes: clientSpecificNotes.length,
        background_notes: backgroundNotes.length,
        warnings,
        missing_information: missingInformation,
      },
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
