import type { Deadline } from '../shared/deadline.ts';
import type { DecisionClient, DecisionInput, ModelDecision } from './model.ts';
import { eventInput } from './telemetry.ts';
import type { RunTelemetry } from './telemetry.ts';

export interface ModelRequestConfig {
  modelAttempts: number;
  retryBaseMs: number;
  maxModelCalls: number;
  maxTotalTokens: number;
}

export interface ModelUsage {
  calls: number;
  tokens: number;
}

type ModelRequestResult =
  | { kind: 'decision'; decision: ModelDecision }
  | { kind: 'stopped'; status: 'failed' | 'cancelled'; code: string; message: string };

interface ModelRequestOptions {
  client: DecisionClient;
  input: DecisionInput;
  config: ModelRequestConfig;
  usage: ModelUsage;
  deadline: Deadline;
  telemetry: Pick<RunTelemetry, 'record'>;
  isCancelled: () => boolean;
}

interface ProviderError {
  status?: number;
  code?: string;
}

/** Existing provider retry classification, separate from UI action retries. */
export function isTransientModelError(error: unknown) {
  const value = error as ProviderError;
  return (
    value?.status === 408 ||
    value?.status === 409 ||
    value?.status === 429 ||
    (typeof value?.status === 'number' && value.status >= 500) ||
    ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED'].includes(value?.code ?? '')
  );
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function requestDecision({
  client,
  input,
  config,
  usage,
  deadline,
  telemetry,
  isCancelled,
}: ModelRequestOptions): Promise<ModelRequestResult> {
  const timeout = (): ModelRequestResult => ({
    kind: 'stopped',
    status: 'failed',
    code: 'RUN_TIMEOUT',
    message: 'Discovery exceeded its configured overall timeout.',
  });
  const cancelled = (): ModelRequestResult => ({
    kind: 'stopped',
    status: 'cancelled',
    code: 'RUN_CANCELLED',
    message: 'Discovery was cancelled.',
  });
  for (let attempt = 1; attempt <= config.modelAttempts; attempt += 1) {
    if (isCancelled()) return cancelled();
    if (deadline.expired) return timeout();
    if (usage.calls >= config.maxModelCalls) {
      return {
        kind: 'stopped',
        status: 'failed',
        code: 'MODEL_CALL_BUDGET_EXCEEDED',
        message: 'Discovery reached its model-call budget.',
      };
    }
    usage.calls += 1;
    await telemetry.record(
      eventInput('model_request', 'MODEL_REQUEST_STARTED', input.step, {
        attempt,
        model: client.model,
      }),
    );

    try {
      const timeoutSignal = AbortSignal.timeout(Math.max(1, Math.ceil(deadline.remainingMs)));
      const signal = input.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal;
      const decision = await client.decide({ ...input, signal });
      usage.tokens += (decision.inputTokens ?? 0) + (decision.outputTokens ?? 0);
      await telemetry.record(
        eventInput(
          'model_response',
          deadline.expired ? 'MODEL_RESPONSE_AFTER_DEADLINE' : 'MODEL_RESPONSE_VALID',
          input.step,
          {
            attempt,
            durationMs: decision.latencyMs,
            actionKind: decision.action.kind,
            targetRef: decision.action.targetRef,
            purpose: decision.action.purpose,
            observationRevision: decision.action.observationRevision,
            model: client.model,
            providerRequestId: decision.requestId,
            inputTokens: decision.inputTokens,
            outputTokens: decision.outputTokens,
          },
        ),
      );
      if (isCancelled()) return cancelled();
      if (deadline.expired) return timeout();
      if (usage.tokens > config.maxTotalTokens) {
        return {
          kind: 'stopped',
          status: 'failed',
          code: 'TOKEN_BUDGET_EXCEEDED',
          message: 'Discovery reached its total token budget.',
        };
      }
      return { kind: 'decision', decision };
    } catch (error) {
      if (isCancelled()) {
        return {
          kind: 'stopped',
          status: 'cancelled',
          code: 'RUN_CANCELLED',
          message: 'Discovery was cancelled.',
        };
      }
      if (deadline.expired) return timeout();
      const retry =
        isTransientModelError(error) && attempt < config.modelAttempts && !deadline.expired;
      await telemetry.record(
        eventInput(
          retry ? 'retry' : 'model_response',
          retry ? 'MODEL_TRANSIENT_RETRY' : 'MODEL_REQUEST_FAILED',
          input.step,
          { attempt, model: client.model },
        ),
      );
      if (!retry) throw error;
      await delay(config.retryBaseMs * 2 ** (attempt - 1));
    }
  }
  throw new Error('MODEL_DECISION_MISSING');
}
