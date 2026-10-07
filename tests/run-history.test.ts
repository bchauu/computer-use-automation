import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { publicRunSchema, runSummarySchema } from '../src/contracts/run.ts';
import { summarizeRun } from '../src/discovery/run-history.ts';

test('persisted run summaries derive operational metrics from validated telemetry', async () => {
  const run = publicRunSchema.parse(JSON.parse(await readFile('evidence/runs/discovery-live/run.json', 'utf8')));
  const summary = runSummarySchema.parse(summarizeRun(run));
  assert.equal(summary.runId, run.runId);
  assert.equal(summary.mode, 'discovery');
  assert.equal(summary.status, 'succeeded');
  assert.equal(summary.modelRequestCount, 3);
  assert.equal(summary.inputTokens, 3636);
  assert.equal(summary.outputTokens, 162);
  assert.equal(summary.eventCount, run.events.length);
  assert.ok(summary.durationMs && summary.durationMs > 0);
  assert.equal(summary.artifact?.artifactId, 'view-transaction-history');
});
