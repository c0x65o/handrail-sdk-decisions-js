import { randomUUID } from 'node:crypto';
import { parseNormalizedUsageReceipt, type NormalizedUsageReceipt } from '@handrail/ai-assistant';
import { createAIRuntimeUsageClient, createAIRuntimeUsageReceiptSink,
  type AIRuntimeUsageOutbox, type AIRuntimeUsageReceiptSink } from '@handrail/ai-assistant/server/usage-control';

export { PostgresAIRuntimeUsageOutbox, PostgresAiPersistence } from '@handrail/ai-assistant/persistence/postgres';
export type { AIRuntimeUsageOutbox, NormalizedUsageReceipt };
export const DECISIONS_MODEL = 'gpt-6-luna';
// Separate endpoint identity prevents Responses pricing for the same model.
export const DECISIONS_PROVIDER = 'openai.decisions';
export type ContentPart = { type: 'input_text'; text: string } | { type: 'input_image'; image_url: string; detail?: 'low' | 'high' | 'auto' | 'original' } | { type: 'input_json'; data: Record<string, unknown> | Record<string, unknown>[] };
type QuestionBase = { name: string; instructions: string | ContentPart[] };
export type Question = QuestionBase & (
  { type: 'predicate' } |
  { type: 'choice'; choices: { value: string | boolean; description?: string }[] } |
  { type: 'score'; levels: { label: string; description?: string }[] }
);
export interface DecisionRequest {
  input: string | Record<string, unknown>[];
  questions: Question[];
  prompt_cache_key?: string;
  prompt_cache_options?: { mode?: 'implicit' | 'explicit'; ttl?: '30m' };
  safety_identifier?: string;
}
export type Answer = { name: string | null } & (
  { type: 'refusal' } | { type: 'predicate'; probability: number } |
  { type: 'choice'; choice: string | boolean; confidence: number; probabilities: { value: string | boolean; probability: number }[] } |
  { type: 'score'; score: number; confidence: number; probabilities: { value: number; label: string; probability: number }[] }
);
export interface Decision { model: string; answers: Answer[]; usage: {
  input_tokens: number; output_tokens: number; total_tokens: number;
  input_tokens_details: { cached_tokens: number; cache_write_tokens: number };
  output_tokens_details: { reasoning_tokens: number };
}; }
export interface DecisionContext { logicalRequestId: string; conversationId?: string; traceId?: string; attemptIndex?: number; }
export class DecisionError extends Error {
  constructor(message: string, readonly code: string, readonly receipt: NormalizedUsageReceipt,
    readonly status?: number) { super(message); this.name = 'DecisionError'; }
}
export interface DecisionsOptions {
  /** Durable host-owned outbox; PostgreSQL implementation is re-exported above. */
  outbox: AIRuntimeUsageOutbox;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
}
function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim(); if (!value) throw new TypeError(`${key} is required`); return value;
}
function member(id: string | null) { return { id, source: 'server_derived', trust: 'authoritative' }; }
function quantity(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? { status: 'reported', value } : { status: 'unavailable' };
}
function validateRequest(request: DecisionRequest, context: DecisionContext) {
  if (!context.logicalRequestId?.trim()) throw new TypeError('logicalRequestId is required');
  if (context.attemptIndex !== undefined && (!Number.isSafeInteger(context.attemptIndex) || context.attemptIndex < 0)) throw new TypeError('Invalid attemptIndex');
  if (!request || !(typeof request.input === 'string' || Array.isArray(request.input))) throw new TypeError('Decision input is required');
  if (!Array.isArray(request.questions) || request.questions.length < 1 || request.questions.length > 400) throw new TypeError('Expected 1–400 questions');
  const names = new Set<string>();
  for (const q of request.questions) {
    if (!q.name?.trim() || names.has(q.name)) throw new TypeError('Question names must be nonempty and unique');
    names.add(q.name);
    if (!['predicate', 'choice', 'score'].includes(q.type)) throw new TypeError('Invalid question type');
    if (!(typeof q.instructions === 'string' || Array.isArray(q.instructions) && q.instructions.length)) throw new TypeError('Question instructions are required');
    if (q.type === 'choice' && (!Array.isArray(q.choices) || q.choices.length < 2 || q.choices.length > 255 || new Set(q.choices.map(c => c.value)).size !== q.choices.length)) throw new TypeError('Expected 2–255 unique choices');
    if (q.type === 'score' && (!Array.isArray(q.levels) || q.levels.length < 2 || q.levels.length > 10)) throw new TypeError('Expected 2–10 score levels');
  }
}
function validAnswers(value: unknown, questions: Question[]): value is Answer[] {
  if (!Array.isArray(value) || value.length !== questions.length) return false;
  const probability = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
  return value.every((a, i) => {
    const q = questions[i];
    if (!a || a.name !== q.name) return false;
    if (a.type === 'refusal') return true;
    if (a.type !== q.type) return false;
    if (a.type === 'predicate') return probability(a.probability);
    if (!probability(a.confidence) || !Array.isArray(a.probabilities) || !a.probabilities.every((p: { probability: unknown }) => probability(p.probability))) return false;
    if (q.type === 'choice') return q.choices.some(c => c.value === a.choice);
    return q.type === 'score' && typeof a.score === 'number' && Number.isFinite(a.score) && a.score >= 0 && a.score <= q.levels.length - 1;
  });
}
/** Uses generated capability credentials. No provider retries: each invocation is metered separately. */
export function createDecisionsClient(options: DecisionsOptions) {
  const env = options.env ?? process.env;
  const apiKey = required(env, 'OPENAI_API_KEY');
  const serviceEnvId = required(env, 'HANDRAIL_AI_RUNTIME_SERVICE_ENV_ID');
  const attribution = {
    organization: member(required(env, 'HANDRAIL_AI_RUNTIME_ORG_ID')),
    project: member(required(env, 'HANDRAIL_AI_RUNTIME_PROJECT_ID')),
    service_environment: member(serviceEnvId), known_user: member(null), session: member(null), automation: member(null),
  };
  const fetcher = options.fetch ?? globalThis.fetch;
  const telemetry = createAIRuntimeUsageClient({ apiUrl: required(env, 'HANDRAIL_AI_RUNTIME_TELEMETRY_URL'),
    token: required(env, 'HANDRAIL_AI_RUNTIME_TOKEN'), serviceEnvId, fetch: fetcher });
  const sink: AIRuntimeUsageReceiptSink = createAIRuntimeUsageReceiptSink(telemetry, options.outbox);
  return {
    flushUsage: sink.flush,
    async decide(request: DecisionRequest, context: DecisionContext): Promise<{ decision: Decision; receipt: NormalizedUsageReceipt }> {
      validateRequest(request, context);
      const id = randomUUID(), occurredAt = new Date().toISOString();
      let body: Partial<Decision> | undefined, status: number | undefined, failed = false;
      try {
        const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
        if (env.OPENAI_ORG_ID) headers['OpenAI-Organization'] = env.OPENAI_ORG_ID;
        if (env.OPENAI_PROJECT_ID) headers['OpenAI-Project'] = env.OPENAI_PROJECT_ID;
        const response = await fetcher('https://api.openai.com/v1/decisions', { method: 'POST', headers,
          body: JSON.stringify({ ...request, model: DECISIONS_MODEL }), signal: AbortSignal.timeout(60_000) });
        status = response.status;
        if (!response.ok) failed = true;
        else { body = await response.json() as Decision; failed = body.model !== DECISIONS_MODEL || !validAnswers(body.answers, request.questions); }
      } catch { failed = true; }
      const usage = body?.usage;
      const raw = {
        version: 1, occurred_at: occurredAt, usage_receipt_id: id, conversation_id: context.conversationId ?? context.logicalRequestId,
        turn_id: context.logicalRequestId, logical_request_id: context.logicalRequestId, trace_id: context.traceId ?? context.logicalRequestId,
        attempt: { id, index: context.attemptIndex ?? 0 }, continuation: { id, index: 0 },
        provider_id: DECISIONS_PROVIDER, model_id: DECISIONS_MODEL, attribution, source: usage ? 'provider' : 'runtime',
        terminal_status: failed ? 'failed' : 'completed',
        tokens: { input_tokens: quantity(usage?.input_tokens), cached_input_tokens: quantity(usage?.input_tokens_details?.cached_tokens),
          cache_write_input_tokens: quantity(usage?.input_tokens_details?.cache_write_tokens), output_tokens: quantity(usage?.output_tokens),
          reasoning_tokens: quantity(usage?.output_tokens_details?.reasoning_tokens), total_tokens: quantity(usage?.total_tokens) },
        provider_cost: { status: 'unavailable' },
      };
      let receipt: NormalizedUsageReceipt;
      try { receipt = parseNormalizedUsageReceipt(raw); }
      catch {
        // Preserve a failed invocation without inventing zero usage when provider metadata is invalid.
        raw.terminal_status = 'failed'; raw.source = 'runtime';
        for (const key of Object.keys(raw.tokens) as (keyof typeof raw.tokens)[]) raw.tokens[key] = { status: 'unavailable' };
        receipt = parseNormalizedUsageReceipt(raw); failed = true;
      }
      try { await sink.capture(receipt); }
      catch { throw new DecisionError('Usage persistence failed; retain this receipt and recover delivery before retrying the decision', 'usage_persistence_failed', receipt, status); }
      if (failed) throw new DecisionError('Decision provider request failed or returned an invalid response', 'decision_failed', receipt, status);
      return { decision: body as Decision, receipt };
    },
  };
}
