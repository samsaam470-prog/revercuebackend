import { Hono } from 'hono';
import { z } from 'zod';
import type { Bindings } from '../types';
import { checkRateLimit } from '../services/rate-limit';
import { DemoAiError, demoProvider, workersAiModel } from '../services/demo-ai';
import {
  generateDemoProposal,
  generateDemoVisual,
  refineDemoText,
  type DemoBrief,
} from '../services/demo-proposal';

/**
 * Public, anonymous endpoints for the Hugging Face proposal generator.
 *
 * These are the only unauthenticated AI routes. They are deliberately narrow:
 * no document persistence, no client records, no account data, and hard caps on
 * body size, section count, prompt length and AI spend. The AI key stays in the
 * Worker; the Space only ever sees this API.
 */

const MAX_BODY_BYTES = 32 * 1024;
const GENERATIONS_PER_HOUR = 4;
const EDITS_PER_HOUR = 25;

const demo = new Hono<{ Bindings: Bindings }>();

const packageSchema = z.object({
  name: z.string().trim().min(1).max(80),
  price: z.number().finite().min(0).max(10_000_000).optional(),
  deliverables: z.string().trim().max(400).default(''),
});

const briefSchema = z.object({
  businessName: z.string().trim().max(120).default(''),
  clientName: z.string().trim().min(1, 'Client name is required.').max(120),
  title: z.string().trim().max(160).default(''),
  industry: z.string().trim().max(120).default(''),
  service: z.string().trim().max(160).default(''),
  problem: z.string().trim().min(10, 'Describe the client problem in at least 10 characters.').max(2500),
  requirements: z.string().trim().max(2500).default(''),
  scope: z.string().trim().max(2500).default(''),
  deliverables: z.string().trim().max(2500).default(''),
  timeline: z.string().trim().max(1200).default(''),
  budget: z.string().trim().max(400).default(''),
  paymentTerms: z.string().trim().max(400).default(''),
  tone: z.enum(['Formal', 'Friendly', 'Direct', 'Consultative']).default('Formal'),
  sections: z.array(z.string().trim().min(1).max(80)).min(1).max(10).default(['Executive Summary', 'Scope of Work', 'Timeline', 'Investment', 'Next Steps']),
  packages: z.array(packageSchema).max(6).default([]),
  clientWebsite: z.string().trim().max(300).optional(),
  businessWebsite: z.string().trim().max(300).optional(),
  targetAudience: z.string().trim().max(400).optional(),
  additional: z.string().trim().max(2500).optional(),
});

const refineSchema = z.object({
  text: z.string().trim().min(20, 'Select a longer passage to improve.').max(4000),
  action: z.enum(['improve', 'professional', 'persuasive', 'simplify', 'expand', 'shorten', 'summary', 'scope', 'value', 'pricing']),
  instruction: z.string().trim().max(300).optional(),
  tone: z.string().trim().max(40).optional(),
  context: z.string().trim().max(1200).optional(),
});

/** Small per-isolate backstop used when the shared rate-limit table is unavailable. */
const memoryLimits = new Map<string, { count: number; resetAt: number }>();
function memoryLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const current = memoryLimits.get(key);
  if (!current || current.resetAt <= now) {
    memoryLimits.set(key, { count: 1, resetAt: now + windowMs });
    if (memoryLimits.size > 5000) {
      for (const [entry, value] of memoryLimits) if (value.resetAt <= now) memoryLimits.delete(entry);
    }
    return true;
  }
  if (current.count >= max) return false;
  current.count += 1;
  return true;
}

function clientIp(headers: Headers): string {
  return headers.get('cf-connecting-ip') || headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
}

async function allow(env: Bindings, key: string, max: number, windowSeconds: number): Promise<boolean> {
  try {
    const result = await checkRateLimit(env, key, max, windowSeconds);
    return result.allowed;
  } catch (error) {
    console.error('DEMO_RATE_LIMIT_TABLE_UNAVAILABLE', (error as Error)?.message ?? error);
    return memoryLimit(key, max, windowSeconds * 1000);
  }
}

function errorResponse(error: unknown) {
  if (error instanceof DemoAiError) {
    return {
      status: error.status,
      body: {
        error: error.code,
        message: error.message,
        retry_after: error.retryAfter,
        retryable: error.code !== 'ai_not_configured' && error.code !== 'ai_auth_failed',
      },
    };
  }
  return { status: 500, body: { error: 'demo_failed', message: 'The proposal could not be generated. Please retry.', retryable: true } };
}

/** Bounded read: refuses an oversized body before parsing it. */
async function readJson(env: Bindings, request: Request): Promise<unknown> {
  const limit = Number(env.DEMO_MAX_BODY_BYTES ?? MAX_BODY_BYTES) || MAX_BODY_BYTES;
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > limit) {
    throw Object.assign(new Error('payload_too_large'), { status: 413 });
  }
  const text = await request.text();
  if (text.length > limit) {
    throw Object.assign(new Error('payload_too_large'), { status: 413 });
  }
  try {
    return JSON.parse(text || '{}');
  } catch {
    throw Object.assign(new Error('invalid_json'), { status: 400 });
  }
}

demo.get('/health', (c) => {
  const provider = demoProvider(c.env);
  return c.json({
    ok: true,
    configured: provider !== 'none',
    provider,
    endpoint:
      provider === 'nararouter'
        ? (c.env.BYNARA_API_ENDPOINT ?? '').trim() || 'https://router.bynara.id/v1'
        : 'workers-ai',
    model: provider === 'nararouter' ? (c.env.DEMO_AI_MODEL ?? '').trim() || 'deepseek-v4-flash' : workersAiModel(c.env),
    limits: {
      generations_per_hour: Number(c.env.DEMO_GENERATIONS_PER_HOUR ?? GENERATIONS_PER_HOUR) || GENERATIONS_PER_HOUR,
      edits_per_hour: Number(c.env.DEMO_EDITS_PER_HOUR ?? EDITS_PER_HOUR) || EDITS_PER_HOUR,
      max_sections: 10,
      max_body_bytes: Number(c.env.DEMO_MAX_BODY_BYTES ?? MAX_BODY_BYTES) || MAX_BODY_BYTES,
    },
  });
});

demo.post('/proposal', async (c) => {
  const ip = clientIp(c.req.raw.headers);
  const allowance = Number(c.env.DEMO_GENERATIONS_PER_HOUR ?? GENERATIONS_PER_HOUR) || GENERATIONS_PER_HOUR;
  if (!(await allow(c.env, `demo:proposal:${ip}`, allowance, 3600))) {
    return c.json(
      { error: 'rate_limited', message: `This demo allows ${allowance} proposals per hour. Please try again later, or create a free Revercue account.`, retry_after: 900 },
      429
    );
  }

  let body: unknown;
  try {
    body = await readJson(c.env, c.req.raw);
  } catch (error) {
    const status = (error as { status?: number }).status ?? 400;
    return c.json({ error: status === 413 ? 'payload_too_large' : 'invalid_json', message: status === 413 ? 'That request is too large. Shorten the brief and retry.' : 'The request body was not valid JSON.' }, status as 400 | 413);
  }

  const parsed = briefSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        error: 'invalid_payload',
        message: parsed.error.issues[0]?.message ?? 'Some proposal details are missing.',
        fields: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      },
      400
    );
  }

  const brief: DemoBrief = parsed.data;
  try {
    const result = await generateDemoProposal(c.env, brief);
    // Operational log only: no brief, no proposal text.
    console.log('DEMO_PROPOSAL_GENERATED', brief.sections.length, result.document.blocks.length, result.document.meta.visuals);
    return c.json({
      success: true,
      document: result.document,
      warnings: result.document.meta.warnings,
      provider: 'nararouter',
    });
  } catch (error) {
    console.error('DEMO_PROPOSAL_FAILED', error instanceof DemoAiError ? error.code : 'unexpected');
    const mapped = errorResponse(error);
    return c.json(mapped.body, mapped.status as 400);
  }
});

demo.post('/refine', async (c) => {
  const ip = clientIp(c.req.raw.headers);
  const allowance = Number(c.env.DEMO_EDITS_PER_HOUR ?? EDITS_PER_HOUR) || EDITS_PER_HOUR;
  if (!(await allow(c.env, `demo:refine:${ip}`, allowance, 3600))) {
    return c.json({ error: 'rate_limited', message: 'Too many AI edits from this connection. Please try again later.', retry_after: 600 }, 429);
  }

  let body: unknown;
  try {
    body = await readJson(c.env, c.req.raw);
  } catch (error) {
    const status = (error as { status?: number }).status ?? 400;
    return c.json({ error: status === 413 ? 'payload_too_large' : 'invalid_json', message: 'The edit request could not be read.' }, status as 400 | 413);
  }

  const parsed = refineSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_payload', message: parsed.error.issues[0]?.message ?? 'The edit request is incomplete.' }, 400);
  }

  try {
    const result = await refineDemoText(c.env, parsed.data);
    return c.json({ success: true, text: result.text, model: result.model, provider: 'nararouter' });
  } catch (error) {
    const mapped = errorResponse(error);
    return c.json(mapped.body, mapped.status as 400);
  }
});

const visualSchema = z.object({
  type: z.enum(['image', 'icon', 'chart', 'diagram']),
  query: z.string().trim().min(1).max(200),
  data: z.unknown().optional(),
});

demo.post('/visual', async (c) => {
  const ip = clientIp(c.req.raw.headers);
  const allowance = Number(c.env.DEMO_EDITS_PER_HOUR ?? EDITS_PER_HOUR) || EDITS_PER_HOUR;
  if (!(await allow(c.env, `demo:visual:${ip}`, allowance, 3600))) {
    return c.json({ error: 'rate_limited', message: 'Too many visual requests from this connection. Please try again later.' }, 429);
  }
  let body: unknown;
  try {
    body = await readJson(c.env, c.req.raw);
  } catch (error) {
    const status = (error as { status?: number }).status ?? 400;
    return c.json({ error: status === 413 ? 'payload_too_large' : 'invalid_json', message: 'The visual request could not be read.' }, status as 400 | 413);
  }
  const parsed = visualSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_payload', message: 'Choose a visual type and describe what it should show.' }, 400);
  }
  try {
    const result = await generateDemoVisual(c.env, parsed.data);
    return c.json({ success: Boolean(result.block), block: result.block, reason: result.reason ?? null });
  } catch (error) {
    console.error('DEMO_VISUAL_FAILED', (error as Error)?.message ?? error);
    return c.json({ success: false, block: null, reason: 'visual_service_unavailable', message: 'The visual service could not be reached.' }, 502);
  }
});

export default demo;
