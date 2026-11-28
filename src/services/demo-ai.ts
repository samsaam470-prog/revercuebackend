import type { Bindings } from '../types';

/**
 * NaraRouter client for the public proposal demo.
 *
 * NaraRouter is the ONLY provider used here. There is no fallback provider and
 * no model switching: a quota, rate-limit or availability problem is returned
 * to the caller as a typed error so the demo can ask the visitor to retry.
 *
 * The key lives in the existing Worker secret `OPENROUTER_API_KEY` (the name is
 * historical; the value is a NaraRouter key) and the base URL in
 * `BYNARA_API_ENDPOINT`. Neither is ever sent to the browser.
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
