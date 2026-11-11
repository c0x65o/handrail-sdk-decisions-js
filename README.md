# @handrail/decisions

Server-side OpenAI Decisions calls with durable Handrail Telemetry usage delivery.
The platform supplies `OPENAI_API_KEY` and the service-scoped `HANDRAIL_AI_RUNTIME_*`
contract. No browser credentials or separate deployed Decisions service.

Install from this public HTTPS Git repository at a full committed SHA and commit
the matching package-manager lockfile. `prepare` compiles TypeScript during the
normal installation. The initial working version is not installable by consumers
until its first commit is published.

```ts
import { createDecisionsClient, PostgresAIRuntimeUsageOutbox } from '@handrail/decisions';

// Reuse the host's PostgresAiPersistence and its normal schema migration flow.
const outbox = new PostgresAIRuntimeUsageOutbox(persistence, tenantId, serviceScopeId);
const decisions = createDecisionsClient({ outbox });
await decisions.flushUsage(); // Also invoke from the host's existing retry worker.
const { decision, receipt } = await decisions.decide({
  input: ticketEvidence,
  questions: [{ name: 'category', type: 'choice', instructions: 'Select the investigation category.',
    choices: [{ value: 'network' }, { value: 'endpoint' }, { value: 'other' }] }],
}, { logicalRequestId: taskId });
```

Each call produces a distinct usage receipt; logicalRequestId correlates attempts,
not provider idempotency. The SDK never automatically repeats an OpenAI request.
Refusals are typed answers. Provider failures record unavailable usage, not invented
zeroes. Usage includes input, cached input, cache writes, output, reasoning and total
counts when supplied by the provider. Prompts, answers and credentials are not
included in telemetry. Project/service attribution comes from generated runtime
configuration; optional user/session/automation identities are not inferred.

The existing AI SDK receipt sink durably enqueues before resolving capture and
retries delivery through `/api/ai-usage/v1/receipts`, preserving receipt identity.
Hosts must supply a durable outbox and call `flushUsage` on startup and from their
retry worker. If persistence itself fails, `DecisionError.receipt` retains the usage
for recovery. Do not retry the provider merely to recover telemetry. Abrupt process
termination before receipt persistence still requires provider usage reconciliation.

The endpoint has its own accounting identity, `openai.decisions`, so ordinary
Responses pricing for `gpt-6-luna` cannot be applied accidentally. Cost is explicitly
unavailable until endpoint-specific pricing is registered in Handrail; token usage
is still reported. No customer charge or quota policy is introduced by this SDK.

Official API contract: https://developers.openai.com/api/docs/guides/decisions

Validation: `npm install --include=dev`, then `npm test`. Tests use synthetic provider
and telemetry responses; they are not proof of live provider access or settlement.
