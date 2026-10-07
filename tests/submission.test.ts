import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import mongoose from 'mongoose';
import type { Connection } from 'mongoose';
import { newId } from '../src/contracts/discovery.ts';
import { publicRunSchema } from '../src/contracts/run.ts';
import { bootstrapReviewedCapability } from '../src/discovery/bootstrap.ts';
import { CapabilityCatalog } from '../src/discovery/catalog.ts';
import { buildActionEvidence } from '../src/discovery/evidence.ts';
import { eventInput, RunTelemetry } from '../src/discovery/telemetry.ts';

test('reviewed capability bootstraps an empty catalog and preserves existing versions', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'submission-catalog-'));
  const database = mongoose.createConnection();
  try {
    const source = path.resolve('evidence/capability.json');
    assert.equal(
      await new CapabilityCatalog(database, directory).resolve('view-transaction-history'),
      null,
    );
    assert.equal((await bootstrapReviewedCapability(source, directory)).status, 'installed');
    const resolved = await new CapabilityCatalog(database, directory).resolve(
      'view-transaction-history',
    );
    assert.equal(resolved?.status, 'validated');
    const destination = path.join(directory, 'view-transaction-history.json');
    const newer = JSON.stringify({ ...resolved, artifactVersion: 2 });
    await writeFile(destination, newer);
    assert.equal(
      (await bootstrapReviewedCapability(source, directory)).status,
      'preserved_existing',
    );
    assert.equal(await readFile(destination, 'utf8'), newer);
    const draftSource = path.join(directory, 'draft-source.json');
    await writeFile(draftSource, JSON.stringify({ ...resolved, status: 'draft' }));
    await assert.rejects(
      bootstrapReviewedCapability(draftSource, directory),
      /BOOTSTRAP_REQUIRES_VALIDATED_ARTIFACT/,
    );
    await writeFile(destination, '{}');
    await assert.rejects(bootstrapReviewedCapability(source, directory));
    assert.equal(await readFile(destination, 'utf8'), '{}');
  } finally {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('model purpose canaries are sanitized before memory, files, evidence, and Mongo writes', async () => {
  const original = JSON.parse(await readFile('evidence/runs/discovery-live/run.json', 'utf8'));
  const run = publicRunSchema.parse({ ...original, runId: newId(), events: [] });
  const writes: unknown[] = [];
  const database = {
    readyState: 1,
    collection() {
      return {
        async updateOne(_filter: unknown, update: unknown) {
          writes.push(update);
        },
      };
    },
  } as unknown as Connection;
  const previousToken = process.env.OPERATOR_ACCESS_TOKEN;
  process.env.OPERATOR_ACCESS_TOKEN = 'synthetic-secret-canary';
  const canaries = [
    'synthetic-secret-canary',
    'canary@example.invalid',
    '2468',
    'sk-syntheticSecretCanaryabcdefgh',
    'mongodb://demo:password@localhost/demo',
  ];
  const purpose = `Inspect history ${canaries.join(' ')} ${'safe '.repeat(100)}`;
  const telemetry = new RunTelemetry(run, database);
  try {
    for (const type of ['model_response', 'validation', 'policy', 'action'] as const) {
      await telemetry.record(eventInput(type, 'INJECTED_PRIVACY_CHECK', 1, { purpose }));
    }
    const evidence = buildActionEvidence({
      runId: run.runId,
      step: 1,
      before: {
        revision: 'observation-test',
        route: '/',
        title: '',
        headings: [],
        visibleText: '',
        controls: [],
        stateHash: 'a'.repeat(64),
      },
      after: null,
      action: {
        observationRevision: 'observation-test',
        kind: 'scroll',
        targetRef: null,
        value: null,
        direction: 'down',
        purpose,
        completionEvidence: [],
      },
      executionStatus: 'not_executed',
      executionCode: 'INJECTED_PRIVACY_CHECK',
      durationMs: 0,
      completionCheck: null,
    });
    await telemetry.recordEvidence(evidence);
    const directory = path.resolve('.local/runs', run.runId);
    const contents = [
      JSON.stringify(run.events),
      JSON.stringify(writes),
      await readFile(path.join(directory, 'run.json'), 'utf8'),
      await readFile(path.join(directory, 'events.jsonl'), 'utf8'),
      await readFile(path.join(directory, 'action-evidence.jsonl'), 'utf8'),
    ];
    for (const content of contents)
      for (const canary of canaries)
        assert.equal(
          content.includes(canary),
          false,
          'Sensitive canary must not cross persistence boundary',
        );
    assert.ok(
      run.events.every(
        (event) => event.purpose?.startsWith('Inspect history') && event.purpose.length <= 300,
      ),
    );
    assert.ok(run.events.every((event) => event.purpose?.includes('[redacted')));
  } finally {
    if (previousToken === undefined) delete process.env.OPERATOR_ACCESS_TOKEN;
    else process.env.OPERATOR_ACCESS_TOKEN = previousToken;
    await rm(path.resolve('.local/runs', run.runId), { recursive: true, force: true });
  }
});
