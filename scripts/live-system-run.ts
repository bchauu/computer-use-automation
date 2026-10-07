import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import mongoose from 'mongoose';
import { chromium } from 'playwright';
import { newId } from '../src/contracts/discovery.ts';
import { publicRunSchema } from '../src/contracts/run.ts';
import { CapabilityCatalog } from '../src/discovery/catalog.ts';
import { DiscoveryController } from '../src/discovery/controller.ts';
import { ExecutionDispatcher } from '../src/discovery/dispatcher.ts';
import { OpenAIDecisionClient } from '../src/discovery/model.ts';
import { readOnlyDiscoveryPolicy } from '../src/discovery/policy.ts';
import { ReplayController } from '../src/discovery/replay.ts';
import { ensureAutomationIndexes } from '../src/discovery/storage.ts';
import type { LiveSession } from '../src/discovery/sessions.ts';
import type { PublicRun } from '../src/discovery/types.ts';

const apiKey = process.env.OPENAI_API_KEY?.trim();
if (!apiKey) throw new Error('OPENAI_API_KEY_REQUIRED');
if ((process.env.DISCOVERY_MODEL_MODE?.trim() || 'openai') !== 'openai') throw new Error('DISCOVERY_MODEL_MODE_MUST_BE_OPENAI');
const model = process.env.OPENAI_MODEL?.trim() || 'gpt-4o-mini';
const databaseUri = process.env.AUTOMATION_MONGODB_URI?.trim();
if (!databaseUri) throw new Error('AUTOMATION_MONGODB_URI_REQUIRED');
const target = process.env.BANK_TARGET_URL || 'http://127.0.0.1:5174/#/members';
const database = mongoose.createConnection();
await database.openUri(databaseUri, { serverSelectionTimeoutMS: 10_000 });
await database.db!.admin().ping();
await ensureAutomationIndexes(database);
// Force this command to perform genuine discovery even when a validated artifact
// already exists in the persistent catalog. The run telemetry still uses MongoDB,
// and the validated artifact is promoted into the persistent catalog below.
const discoveryCatalogDatabase = mongoose.createConnection();
const browser = await chromium.launch({ headless: process.env.DISCOVERY_HEADLESS !== 'false' });
const context = await browser.newContext();
const page = await context.newPage();
const catalogDirectory = await mkdtemp(path.join(tmpdir(), 'genuine-capability-catalog-'));
let discoveryRunId: string | null = null;
let replayRunId: string | null = null;

async function waitForRun(run: PublicRun, session: LiveSession) {
  const deadline = Date.now() + 660_000;
  while ((['created', 'running'].includes(run.status) || session.activeRunId === run.runId) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

try {
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.getByLabel('Full name').fill('Alex Morgan');
  await page.getByLabel('Date of birth').fill('1988-04-12');
  await page.getByRole('button', { name: 'Search members' }).click();
  await page.getByLabel('Last four digits of SSN').fill('4829');
  await page.getByRole('button', { name: 'Verify customer' }).click();
  await page.getByRole('heading', { name: 'Member overview', exact: true }).waitFor();

  const session: LiveSession = {
    sessionId: newId(), controlToken: 'genuine-local-run', browser, context, page,
    owner: 'human', epoch: 1, activeRunId: null, createdAt: new Date().toISOString(), allowedOrigin: new URL(target).origin,
  };
  const catalog = new CapabilityCatalog(discoveryCatalogDatabase, catalogDirectory);
  const discovery = new DiscoveryController(database, new OpenAIDecisionClient(apiKey, model, 120_000), {
    maxSteps: 20, runTimeoutMs: 600_000, actionTimeoutMs: 30_000, modelAttempts: 3, retryBaseMs: 1_000,
    repeatedDecisionLimit: 3, noProgressLimit: 3, maxModelCalls: 6, maxTotalTokens: 15_000,
    actionPolicy: readOnlyDiscoveryPolicy,
  }, catalog);
  const replay = new ReplayController(database, catalog);
  const dispatcher = new ExecutionDispatcher(discovery, replay, catalog);

  const discoveryRun = await dispatcher.start(session, 'Show this member’s checking transactions for the last 7 days.');
  discoveryRunId = discoveryRun.runId;
  await waitForRun(discoveryRun, session);
  const discovered = publicRunSchema.parse(discoveryRun);
  if (discovered.status !== 'succeeded' || discovered.artifact?.status !== 'draft') {
    throw new Error(`GENUINE_DISCOVERY_FAILED:${JSON.stringify({ runId: discovered.runId, status: discovered.status, result: discovered.result, artifact: discovered.artifact })}`);
  }

  const validationRun = await dispatcher.start(session, 'Show this member’s checking transactions for the last 14 days.');
  replayRunId = validationRun.runId;
  await waitForRun(validationRun, session);
  const replayed = publicRunSchema.parse(validationRun);
  if (replayed.status !== 'succeeded' || replayed.mode !== 'validation_replay' || replayed.artifact?.status !== 'validated') {
    throw new Error(`GENUINE_VALIDATION_REPLAY_FAILED:${JSON.stringify({ runId: replayed.runId, status: replayed.status, result: replayed.result, artifact: replayed.artifact })}`);
  }
  const validatedArtifact = await catalog.resolve('view-transaction-history');
  if (!validatedArtifact || validatedArtifact.status !== 'validated') throw new Error('VALIDATED_ARTIFACT_NOT_RESOLVABLE');
  await new CapabilityCatalog(database).promote(validatedArtifact);

  console.log(JSON.stringify({
    scenario: 'genuine_openai', model,
    budget: { maxModelCalls: 6, totalTokenStopThreshold: 15_000 },
    discovery: {
      runId: discovered.runId, mode: discovered.mode, status: discovered.status, steps: discovered.step,
      resultCode: discovered.result?.code, artifactStatus: discovered.artifact?.status,
      modelCalls: discovered.events.filter(event => event.type === 'model_request').length,
      inputTokens: discovered.events.reduce((sum, event) => sum + (event.inputTokens ?? 0), 0),
      outputTokens: discovered.events.reduce((sum, event) => sum + (event.outputTokens ?? 0), 0),
    },
    validationReplay: {
      runId: replayed.runId, mode: replayed.mode, status: replayed.status, steps: replayed.step,
      resultCode: replayed.result?.code, artifactStatus: replayed.artifact?.status,
      account: replayed.result?.output?.account,
      transactionCount: replayed.result?.output?.transactions.length,
      modelRequestEvents: replayed.events.filter(event => event.type === 'model_request').length,
    },
    persistentCatalog: '.local/capabilities/view-transaction-history.json',
  }, null, 2));
} finally {
  await browser.close();
  await database.close();
  await rm(catalogDirectory, { recursive: true, force: true });
  if (discoveryRunId || replayRunId) console.log('Genuine run evidence remains under .local/runs for review.');
}
