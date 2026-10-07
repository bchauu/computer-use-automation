import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { actionEvidenceSchema, capabilityArtifactSchema } from '../src/contracts/capability.ts';
import { publicRunSchema } from '../src/contracts/run.ts';
import { stabilitySummarySchema } from '../src/contracts/stability.ts';

const selections = [
  { name: 'discovery-live', runId: process.env.EVIDENCE_DISCOVERY_RUN || 'e71e20d0-2211-4f43-a7a7-c57ecad02938', provenance: 'genuine_openai' },
  { name: 'validation-replay', runId: process.env.EVIDENCE_VALIDATION_RUN || '2dc1c084-6c3a-410b-b196-8d3e76956741', provenance: 'live_model_free_replay' },
  { name: 'cross-member-replay', runId: process.env.EVIDENCE_REPLAY_RUN || 'b4094048-60b7-4f7c-b201-088ab0ae395b', provenance: 'live_model_free_replay' },
  { name: 'full-pagination-replay', runId: process.env.EVIDENCE_PAGINATION_RUN || '0c9e1962-cc19-49d7-bc10-7205d5f971c2', provenance: 'live_model_free_replay' },
  { name: 'session-expiry-handoff', runId: process.env.EVIDENCE_HANDOFF_RUN || '26c148d7-78b5-4e22-bda8-a2617d5d6cb9', provenance: 'injected_runtime_condition' },
  { name: 'unknown-dialog-handoff', runId: process.env.EVIDENCE_DECISION_HANDOFF_RUN || '9e32589a-7477-4749-a888-0449d2665951', provenance: 'injected_runtime_condition' },
  { name: 'slow-load-recovery', runId: process.env.EVIDENCE_SLOW_RUN || '54a51922-027c-403a-a5f3-ba5451f6dbbb', provenance: 'injected_runtime_condition' },
  { name: 'known-notice-recovery', runId: process.env.EVIDENCE_NOTICE_RUN || '1a7a5ff5-43ac-4bd1-a960-3e78c97eba60', provenance: 'injected_runtime_condition' },
  { name: 'permission-intervention', runId: process.env.EVIDENCE_PERMISSION_RUN || '8b4cd0f5-b4a9-4ea9-ac02-cef7ebe429db', provenance: 'injected_runtime_condition' },
  { name: 'application-failure', runId: process.env.EVIDENCE_APP_ERROR_RUN || '9420a99a-78ec-4ca0-8f9e-bb2f495d7605', provenance: 'injected_runtime_condition' },
  { name: 'account-not-found', runId: process.env.EVIDENCE_ACCOUNT_MISSING_RUN || '58d9657e-e0a1-44f6-8237-c50c8ced12df', provenance: 'synthetic_business_outcome' },
  { name: 'no-transactions', runId: process.env.EVIDENCE_NO_TRANSACTIONS_RUN || 'a912ad07-8556-4196-9468-c9516a7239b8', provenance: 'synthetic_business_outcome' },
] as const;

const root = path.resolve('evidence');
const runsRoot = path.join(root, 'runs');
await rm(runsRoot, { recursive: true, force: true });
await mkdir(runsRoot, { recursive: true });
const manifestRuns: Array<Record<string, unknown>> = [];
const written: string[] = [];

async function safeWrite(file: string, content: string) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, { encoding: 'utf8', mode: 0o600 });
  written.push(file);
}

for (const selection of selections) {
  const source = path.resolve('.local', 'runs', selection.runId);
  const run = publicRunSchema.parse(JSON.parse(await readFile(path.join(source, 'run.json'), 'utf8')));
  if (!['succeeded', 'awaiting_human', 'failed', 'cancelled'].includes(run.status)) throw new Error(`UNFINISHED_EVIDENCE_RUN:${selection.runId}`);
  if (selection.provenance === 'genuine_openai' && !run.events.some(event => event.type === 'model_request')) throw new Error('DISCOVERY_MODEL_EVIDENCE_MISSING');
  if (selection.provenance !== 'genuine_openai' && run.events.some(event => event.type === 'model_request')) throw new Error(`MODEL_EVENT_IN_NON_DISCOVERY_EVIDENCE:${selection.runId}`);
  const destination = path.join(runsRoot, selection.name);
  await safeWrite(path.join(destination, 'run.json'), `${JSON.stringify(run, null, 2)}\n`);
  await safeWrite(path.join(destination, 'events.jsonl'), run.events.map(event => JSON.stringify(event)).join('\n') + '\n');
  if (selection.provenance === 'genuine_openai') {
    const artifact = capabilityArtifactSchema.parse(JSON.parse(await readFile(path.join(source, 'artifact.draft.json'), 'utf8')));
    await safeWrite(path.join(destination, 'artifact.draft.json'), `${JSON.stringify(artifact, null, 2)}\n`);
    const evidenceLines = (await readFile(path.join(source, 'action-evidence.jsonl'), 'utf8')).trim().split('\n').filter(Boolean);
    const actions = evidenceLines.map(line => actionEvidenceSchema.parse(JSON.parse(line)));
    await safeWrite(path.join(destination, 'action-evidence.jsonl'), actions.map(item => JSON.stringify(item)).join('\n') + '\n');
  }
  manifestRuns.push({
    name: selection.name, runId: run.runId, provenance: selection.provenance, mode: run.mode, status: run.status,
    resultCode: run.result?.code ?? null, modelRequestCount: run.events.filter(event => event.type === 'model_request').length,
    startedAt: run.startedAt, finishedAt: run.finishedAt,
  });
}

const capability = capabilityArtifactSchema.parse(JSON.parse(await readFile(path.resolve('.local', 'capabilities', 'view-transaction-history.json'), 'utf8')));
await safeWrite(path.join(root, 'capability.json'), `${JSON.stringify(capability, null, 2)}\n`);
const stability = stabilitySummarySchema.parse(JSON.parse(await readFile(path.resolve('.local', 'stability', 'latest.json'), 'utf8')));
if (stability.modelRequestCount !== 0 || stability.successfulRuns !== stability.totalRuns || stability.expectedOutcomeRate !== 1) {
  throw new Error('STABILITY_EVIDENCE_DID_NOT_PASS');
}
await safeWrite(path.join(root, 'stability-summary.json'), `${JSON.stringify(stability, null, 2)}\n`);

const key = process.env.OPENAI_API_KEY?.trim();
const forbidden = [/sk-[A-Za-z0-9_-]{12,}/, /"value"\s*:\s*"2468"/];
if (key) forbidden.push(new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
for (const file of written) {
  const content = await readFile(file, 'utf8');
  if (forbidden.some(pattern => pattern.test(content))) throw new Error(`SENSITIVE_CANARY_FOUND:${path.relative(root, file)}`);
}

const hashes: Record<string, string> = {};
for (const file of written.sort()) hashes[path.relative(root, file)] = createHash('sha256').update(await readFile(file)).digest('hex');
const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  model: capability.source.testedModel,
  capability: { artifactId: capability.artifactId, artifactVersion: capability.artifactVersion, status: capability.status },
  runs: manifestRuns,
  files: hashes,
  review: { rawHtmlExported: false, screenshotsExported: false, configuredApiKeyMatchFound: false, syntheticPinValueExported: false },
};
await writeFile(path.join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
console.log(JSON.stringify({ exportedRuns: manifestRuns.length, exportedFiles: written.length + 1, review: manifest.review }, null, 2));
