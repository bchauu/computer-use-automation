import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Deadline } from '../src/shared/deadline.ts';
import { requestDecision } from '../src/discovery/model-request.ts';
import type { ModelRequestConfig, ModelUsage } from '../src/discovery/model-request.ts';
import type { DecisionClient, DecisionInput, ModelDecision } from '../src/discovery/model.ts';
import type { RunTelemetry } from '../src/discovery/telemetry.ts';

const input: DecisionInput = {
  goal: 'Show checking transactions for the last 7 days.',
  criteria: {
    memberId: '12345',
    memberName: 'Synthetic Member',
    accountType: 'Checking',
    view: 'transaction_history',
    period: '7',
  },
  observation: {
    revision: 'observation-test',
    route: '/',
    title: 'Synthetic',
    headings: [],
    visibleText: '',
    controls: [],
    stateHash: 'synthetic',
  },
  recent: [],
  step: 1,
  maxSteps: 8,
};
const decision: ModelDecision = {
  action: {
    observationRevision: 'observation-test',
    kind: 'request_human',
    targetRef: null,
    value: null,
    direction: null,
    purpose: 'Synthetic review',
    completionEvidence: [],
  },
  requestId: null,
  inputTokens: 10,
  outputTokens: 5,
  latencyMs: 1,
};
const config: ModelRequestConfig = {
  modelAttempts: 3,
  retryBaseMs: 1,
  maxModelCalls: 10,
  maxTotalTokens: 100,
};

function recorder() {
  const events: Array<Parameters<RunTelemetry['record']>[0]> = [];
  return {
    events,
    async record(event: Parameters<RunTelemetry['record']>[0]) {
      events.push(event);
      return {
        ...event,
        eventId: randomUUID(),
        runId: randomUUID(),
        sessionId: randomUUID(),
        sequence: events.length,
        timestamp: new Date().toISOString(),
      };
    },
  };
}

test('transient provider failure retries only the decision request and records shared usage', async () => {
  const telemetry = recorder();
  const usage: ModelUsage = { calls: 0, tokens: 0 };
  let calls = 0;
  const client: DecisionClient = {
    model: 'injected-test',
    async decide(received) {
      assert.equal(received.observation, input.observation);
      assert.ok(received.signal);
      calls += 1;
      if (calls === 1) throw { status: 503 };
      return decision;
    },
  };
  const options = {
    client,
    input,
    config: { ...config, maxModelCalls: 2 },
    usage,
    deadline: new Deadline(5000),
    telemetry,
    isCancelled: () => false,
  };
  assert.equal((await requestDecision(options)).kind, 'decision');
  assert.deepEqual(usage, { calls: 2, tokens: 15 });
  assert.deepEqual(
    telemetry.events.map((event) => event.code),
    [
      'MODEL_REQUEST_STARTED',
      'MODEL_TRANSIENT_RETRY',
      'MODEL_REQUEST_STARTED',
      'MODEL_RESPONSE_VALID',
    ],
  );
  const exhausted = await requestDecision(options);
  assert.equal(exhausted.kind, 'stopped');
  if (exhausted.kind === 'stopped') assert.equal(exhausted.code, 'MODEL_CALL_BUDGET_EXCEEDED');
  assert.equal(calls, 2, 'The same run budget must carry across controller steps.');
});

test('authentication, invalid requests, and unparseable responses are not retried', async () => {
  for (const failure of [{ status: 401 }, { status: 400 }, new Error('MODEL_OUTPUT_UNPARSEABLE')]) {
    let calls = 0;
    const telemetry = recorder();
    await assert.rejects(
      requestDecision({
        client: {
          model: 'injected-test',
          async decide() {
            calls += 1;
            throw failure;
          },
        },
        input,
        config,
        usage: { calls: 0, tokens: 0 },
        deadline: new Deadline(5000),
        telemetry,
        isCancelled: () => false,
      }),
      (error) => error === failure,
    );
    assert.equal(calls, 1);
    assert.equal(telemetry.events.at(-1)?.code, 'MODEL_REQUEST_FAILED');
  }
});

test('transient retries stop on the attempt limit', async () => {
  const failure = { status: 429 };
  let calls = 0;
  await assert.rejects(
    requestDecision({
      client: {
        model: 'injected-test',
        async decide() {
          calls += 1;
          throw failure;
        },
      },
      input,
      config: { ...config, modelAttempts: 2 },
      usage: { calls: 0, tokens: 0 },
      deadline: new Deadline(5000),
      telemetry: recorder(),
      isCancelled: () => false,
    }),
    (error) => error === failure,
  );
  assert.equal(calls, 2);
});

test('expired discovery does not request a model decision', async () => {
  let calls = 0;
  const result = await requestDecision({
    client: {
      model: 'injected-test',
      async decide() {
        calls += 1;
        return decision;
      },
    },
    input,
    config,
    usage: { calls: 0, tokens: 0 },
    deadline: new Deadline(0),
    telemetry: recorder(),
    isCancelled: () => false,
  });
  assert.equal(result.kind, 'stopped');
  if (result.kind === 'stopped') assert.equal(result.code, 'RUN_TIMEOUT');
  assert.equal(calls, 0);
});

test('late successful response is recorded for usage but cannot become an action', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const telemetry = recorder();
  const usage = { calls: 0, tokens: 0 };
  const result = await requestDecision({
    client: {
      model: 'injected-test',
      async decide() {
        t.mock.timers.tick(5001);
        return decision;
      },
    },
    input,
    config,
    usage,
    deadline: new Deadline(5000),
    telemetry,
    isCancelled: () => false,
  });
  assert.equal(result.kind, 'stopped');
  if (result.kind === 'stopped') assert.equal(result.code, 'RUN_TIMEOUT');
  assert.deepEqual(usage, { calls: 1, tokens: 15 });
  assert.equal(telemetry.events.at(-1)?.code, 'MODEL_RESPONSE_AFTER_DEADLINE');
});

test('retry backoff cannot start another request after the deadline', async () => {
  let calls = 0;
  const deadline = new Deadline(5000);
  const result = await requestDecision({
    client: {
      model: 'injected-test',
      async decide() {
        calls += 1;
        throw { status: 503 };
      },
    },
    input,
    config,
    usage: { calls: 0, tokens: 0 },
    deadline,
    telemetry: {
      async record(event) {
        if (event.code === 'MODEL_TRANSIENT_RETRY')
          Object.defineProperty(deadline, 'expired', { get: () => true });
        return recorder().record(event);
      },
    },
    isCancelled: () => false,
  });
  assert.equal(result.kind, 'stopped');
  if (result.kind === 'stopped') assert.equal(result.code, 'RUN_TIMEOUT');
  assert.equal(calls, 1);
});

test('cancellation is passed to the client and prevents retry after request failure', async () => {
  const controller = new AbortController();
  const telemetry = recorder();
  let calls = 0;
  const result = await requestDecision({
    client: {
      model: 'injected-test',
      async decide(received) {
        assert.ok(received.signal);
        assert.equal(received.signal.aborted, false);
        calls += 1;
        controller.abort();
        assert.equal(received.signal.aborted, true);
        throw { status: 503 };
      },
    },
    input: { ...input, signal: controller.signal },
    config,
    usage: { calls: 0, tokens: 0 },
    deadline: new Deadline(5000),
    telemetry,
    isCancelled: () => controller.signal.aborted,
  });
  assert.equal(result.kind, 'stopped');
  if (result.kind === 'stopped') assert.equal(result.status, 'cancelled');
  assert.equal(calls, 1);
  assert.equal(
    telemetry.events.some((event) => event.type === 'retry'),
    false,
  );
});

test('token usage accumulates across decisions and blocks an over-budget action from being returned', async () => {
  const usage: ModelUsage = { calls: 0, tokens: 0 };
  const options = {
    client: {
      model: 'injected-test',
      async decide() {
        return decision;
      },
    },
    input,
    config: { ...config, maxTotalTokens: 20 },
    usage,
    deadline: new Deadline(5000),
    telemetry: recorder(),
    isCancelled: () => false,
  };
  assert.equal((await requestDecision(options)).kind, 'decision');
  const exceeded = await requestDecision(options);
  assert.equal(exceeded.kind, 'stopped');
  if (exceeded.kind === 'stopped') assert.equal(exceeded.code, 'TOKEN_BUDGET_EXCEEDED');
  assert.deepEqual(usage, { calls: 2, tokens: 30 });
});
