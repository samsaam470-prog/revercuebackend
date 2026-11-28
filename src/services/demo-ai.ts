import type { Bindings } from '../types';

/**
 * AI client for the public proposal demo.
 *
 * NaraRouter is the primary provider: the key lives in the Worker secret
 * `OPENROUTER_API_KEY` (the name is historical; the value is a NaraRouter key)
 * and the base URL in `BYNARA_API_ENDPOINT`. Neither is ever sent to the browser.
 *
 * When that secret is absent the demo falls back to this account's own
 * Cloudflare Workers AI binding (`AI`), which needs no external key at all. The
 * fallback exists so the public Space keeps working between NaraRouter keys;
 * setting the secret switches every request back to NaraRouter with no code
 * change. A quota, rate-limit or availability problem is returned to the caller
 * as a typed error so the demo can ask the visitor to retry.
 */

export type DemoAiErrorCode =
  | 'ai_not_configured'
  | 'ai_auth_failed'
  | 'ai_rate_limited'
  | 'ai_quota_exhausted'
  | 'ai_model_unavailable'
  | 'ai_unavailable'
  | 'ai_timeout'
  | 'ai_bad_response';

export class DemoAiError extends Error {
  readonly code: DemoAiErrorCode;
  readonly status: number;
  readonly retryAfter?: number;

  constructor(code: DemoAiErrorCode, message: string, status = 502, retryAfter?: number) {
    super(message);
    this.name = 'DemoAiError';
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/**
 * Default model for the demo. `deepseek-v4-flash` is present in NaraRouter's
 * public catalogue (1M context, reasoning, pay-as-you-go enabled) and is one of
 * the cheapest writing models there. Operators can override it with
 * `DEMO_AI_MODEL` without touching code.
 */
export const DEFAULT_DEMO_MODEL = 'deepseek-v4-flash';

export function demoModel(env: Bindings): string {
  return (env.DEMO_AI_MODEL ?? '').trim() || DEFAULT_DEMO_MODEL;
}

/**
 * Default Workers AI model for the keyless fallback.
 * `llama-4-scout-17b-16e-instruct` is the model that returns the long,
 * strictly-shaped JSON the demo's staged pipeline asks for while still
 * answering in about 20 seconds. The 8B tier truncates the section draft, the
 * 70B tier drops sections, and GLM 4.7 Flash takes about a minute.
 */
export const DEFAULT_WORKERS_AI_MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct';

/**
 * Tried in order when the configured model is retired. Cloudflare retires
 * Workers AI models regularly, and a dead name must not take the public demo
 * down with it.
 */
const WORKERS_AI_FALLBACK_MODELS = [
  '@cf/meta/llama-4-scout-17b-16e-instruct',
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/meta/llama-3.1-8b-instruct-fp8',
];

/** Last model this isolate saw work, so a dead name costs one request, not many. */
let workingWorkersAiModel = '';

export function workersAiModel(env: Bindings): string {
  return workingWorkersAiModel || (env.DEMO_WORKERS_AI_MODEL ?? '').trim() || DEFAULT_WORKERS_AI_MODEL;
}

function workersAiCandidates(env: Bindings): string[] {
  const configured = (env.DEMO_WORKERS_AI_MODEL ?? '').trim();
  const list = [
    ...(configured ? [configured] : []),
    ...(workingWorkersAiModel ? [workingWorkersAiModel] : []),
    ...WORKERS_AI_FALLBACK_MODELS,
  ];
  return [...new Set(list)];
}

/**
 * Workers AI text generation returns `{ response }` for the Llama family and
 * `{ choices: [{ message: { content } }] }` for the OpenAI-compatible models,
 * so read both rather than assuming one shape.
 */
function workersAiText(result: unknown): string {
  if (typeof result === 'string') return result.trim();
  if (!result || typeof result !== 'object') return '';
  const record = result as Record<string, unknown>;
  if (typeof record.response === 'string' && record.response.trim()) return record.response.trim();
  const choices = record.choices;
  if (Array.isArray(choices) && choices.length) {
    const first = choices[0] as Record<string, unknown> | undefined;
    const message = (first?.message ?? {}) as Record<string, unknown>;
    if (typeof message.content === 'string' && message.content.trim()) return message.content.trim();
  }
  const nested = record.result as Record<string, unknown> | undefined;
  if (nested) {
    if (typeof nested.response === 'string' && nested.response.trim()) return nested.response.trim();
  }
  return '';
}

/** A retired or unknown model name: worth trying the next candidate. */
function isModelProblem(message: string): boolean {
  return /deprecat|not found|does not exist|no such model|unknown model|not supported/i.test(message);
}

/** Which provider a request will use. Reported by `/api/demo/health`. */
export function demoProvider(env: Bindings): 'nararouter' | 'workers-ai' | 'none' {
  if ((env.OPENROUTER_API_KEY ?? '').trim()) return 'nararouter';
  if (env.AI) return 'workers-ai';
  return 'none';
}

export function demoEndpoint(env: Bindings): string {
  return ((env.BYNARA_API_ENDPOINT ?? '').trim() || 'https://router.bynara.id/v1').replace(/\/+$/, '');
}

export interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

interface ChatOptions {
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

/**
 * One OpenAI-compatible chat completion. The response is read as text and the
 * caller parses JSON itself, so a model that ignores JSON hints still works.
 */
export async function demoChat(
  env: Bindings,
  messages: ChatMessage[],
  options: ChatOptions = {}
): Promise<string> {
  const apiKey = (env.OPENROUTER_API_KEY ?? '').trim();
  if (!apiKey) {
    if (env.AI) return workersAiChat(env, messages, options);
    throw new DemoAiError(
      'ai_not_configured',
      'The proposal service is not configured yet. Please try again later.',
      503
    );
  }

  const timeoutMs = options.timeoutMs ?? 25_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${demoEndpoint(env)}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: demoModel(env),
        messages,
        temperature: options.temperature ?? 0.4,
        max_tokens: options.maxTokens ?? 900,
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw await classify(response);
    }

    const payload = (await response.json().catch(() => null)) as
      | { choices?: { message?: { content?: unknown } }[] }
      | null;
    const raw = payload?.choices?.[0]?.message?.content;
    const content = typeof raw === 'string' ? raw.trim() : '';
    if (!content) {
      throw new DemoAiError('ai_bad_response', 'The AI service returned an empty response. Please retry.', 502);
    }
    return content;
  } catch (error) {
    if (error instanceof DemoAiError) throw error;
    if ((error as Error)?.name === 'AbortError') {
      throw new DemoAiError('ai_timeout', 'The AI service took too long to respond. Please retry.', 504);
    }
    console.error('DEMO_AI_REQUEST_FAILED', (error as Error)?.message ?? error);
    throw new DemoAiError('ai_unavailable', 'The AI service is temporarily unavailable. Please retry.', 502);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One chat completion on this account's Workers AI allowance. Used only when no
 * NaraRouter key is configured, so the public demo never depends on a secret to
 * be useful.
 */
async function workersAiChat(
  env: Bindings,
  messages: ChatMessage[],
  options: ChatOptions
): Promise<string> {
  const ai = env.AI;
  if (!ai) {
    throw new DemoAiError(
      'ai_not_configured',
      'The proposal service is not configured yet. Please try again later.',
      503
    );
  }

  for (const candidate of workersAiCandidates(env)) {
    try {
      const result = (await (ai.run as unknown as (
        name: string,
        input: Record<string, unknown>
      ) => Promise<{ response?: unknown }>)(candidate, {
        messages,
        max_tokens: options.maxTokens ?? 900,
        temperature: options.temperature ?? 0.4,
      })) as { response?: unknown } | null;

      const content = workersAiText(result);
      if (!content) {
        console.error('DEMO_WORKERS_AI_EMPTY', candidate, JSON.stringify(result)?.slice(0, 300) ?? 'null');
        continue;
      }
      workingWorkersAiModel = candidate;
      return content;
    } catch (error) {
      if (error instanceof DemoAiError) throw error;
      const message = (error as Error)?.message ?? String(error);
      console.error('DEMO_WORKERS_AI_FAILED', candidate, message);
      if (isModelProblem(message)) continue;
      break;
    }
  }

  throw new DemoAiError('ai_unavailable', 'The AI service is temporarily unavailable. Please retry.', 502);
}

async function classify(response: Response): Promise<DemoAiError> {
  const retryAfterHeader = Number(response.headers.get('retry-after') ?? '');
  const retryAfter = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0 ? retryAfterHeader : undefined;
  const body = (await response.text().catch(() => '')).slice(0, 500).toLowerCase();

  if (response.status === 401 || response.status === 403) {
    console.error('DEMO_AI_AUTH_FAILED', response.status);
    return new DemoAiError('ai_auth_failed', 'The proposal service could not authenticate with its AI provider.', 502);
  }
  if (response.status === 429) {
    if (body.includes('quota') || body.includes('credit') || body.includes('insufficient')) {
      return new DemoAiError('ai_quota_exhausted', 'The demo has used its AI quota for now. Please try again later.', 503, retryAfter);
    }
    return new DemoAiError('ai_rate_limited', 'Too many AI requests right now. Please retry in a moment.', 429, retryAfter ?? 30);
  }
  if (response.status === 404 || (response.status === 400 && /model/.test(body))) {
    console.error('DEMO_AI_MODEL_UNAVAILABLE', demoModelHint(body));
    return new DemoAiError('ai_model_unavailable', 'The configured AI model is not available. Please try again later.', 503);
  }
  console.error('DEMO_AI_UPSTREAM_ERROR', response.status);
  return new DemoAiError('ai_unavailable', 'The AI service returned an error. Please retry.', 502, retryAfter);
}

function demoModelHint(body: string): string {
  return body.slice(0, 200);
}

/**
 * Extracts the first JSON object or array from model output. Models sometimes
 * wrap JSON in prose or fences; that is not an error worth failing on.
 */
export function parseModelJson<T>(text: string): T | null {
  const trimmed = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const attempts = [trimmed];
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) attempts.push(trimmed.slice(firstBrace, lastBrace + 1));
  const firstBracket = trimmed.indexOf('[');
  const lastBracket = trimmed.lastIndexOf(']');
  if (firstBracket >= 0 && lastBracket > firstBracket) attempts.push(trimmed.slice(firstBracket, lastBracket + 1));

  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt) as T;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}
