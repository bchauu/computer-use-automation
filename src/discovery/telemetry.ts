import { mkdir, appendFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Connection } from 'mongoose';
import type { ActionEvidence, CapabilityArtifact } from '../contracts/capability.ts';
import { newId } from '../contracts/discovery.ts';
import { publicRunSchema } from '../contracts/run.ts';
import type { PublicRun, TelemetryEvent } from './types.ts';
import { sanitizePersistedText } from './sanitization.ts';

type EventInput = Omit<
  TelemetryEvent,
  'eventId' | 'sequence' | 'timestamp' | 'runId' | 'sessionId'
>;

export class RunTelemetry {
  private sequence = 0;
  private readonly run: PublicRun;
  private readonly database: Connection;
  constructor(run: PublicRun, database: Connection) {
    this.run = run;
    this.database = database;
  }

  async record(input: EventInput) {
    const event: TelemetryEvent = {
      ...input,
      purpose: sanitizePersistedText(input.purpose, [
        this.run.criteria.memberName,
        this.run.criteria.memberId,
      ]),
      eventId: newId(),
      runId: this.run.runId,
      sessionId: this.run.sessionId,
      sequence: ++this.sequence,
      timestamp: new Date().toISOString(),
    };
    this.run.events.push(event);
    const directory = path.resolve('.local', 'runs', this.run.runId);
    await mkdir(directory, { recursive: true });
    const runSnapshot = publicRunSchema.parse(this.run);
    await appendFile(path.join(directory, 'events.jsonl'), `${JSON.stringify(event)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await writeFile(path.join(directory, 'run.json'), `${JSON.stringify(runSnapshot, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    if (this.database.readyState === 1) {
      await this.database
        .collection<{ runId: string; events: TelemetryEvent[] }>('discoveryRuns')
        .updateOne(
          { runId: this.run.runId },
          {
            $set: {
              runId: this.run.runId,
              sessionId: this.run.sessionId,
              mode: this.run.mode,
              status: this.run.status,
              goalSummary: this.run.goalSummary,
              inputs: this.run.inputs,
              criteria: this.run.criteria,
              step: this.run.step,
              maxSteps: this.run.maxSteps,
              startedAt: this.run.startedAt,
              finishedAt: this.run.finishedAt,
              result: this.run.result,
              artifact: this.run.artifact,
              updatedAt: event.timestamp,
            },
            $push: { events: event },
            $setOnInsert: { createdAt: event.timestamp },
          },
          { upsert: true },
        )
        .catch(() =>
          console.error(
            JSON.stringify({
              service: 'automation',
              event: 'telemetry_mongo_write_failed',
              runId: this.run.runId,
            }),
          ),
        );
    }
    return event;
  }

  async recordEvidence(evidence: ActionEvidence) {
    const directory = path.resolve('.local', 'runs', this.run.runId);
    await mkdir(directory, { recursive: true });
    await appendFile(
      path.join(directory, 'action-evidence.jsonl'),
      `${JSON.stringify(evidence)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    if (this.database.readyState === 1) {
      await this.database
        .collection<{ runId: string; evidence: ActionEvidence[] }>('discoveryRuns')
        .updateOne({ runId: this.run.runId }, { $push: { evidence } }, { upsert: true })
        .catch(() =>
          console.error(
            JSON.stringify({
              service: 'automation',
              event: 'evidence_mongo_write_failed',
              runId: this.run.runId,
            }),
          ),
        );
    }
  }

  async saveDraftArtifact(artifact: CapabilityArtifact) {
    const directory = path.resolve('.local', 'runs', this.run.runId);
    await mkdir(directory, { recursive: true });
    const relativePath = path.join('.local', 'runs', this.run.runId, 'artifact.draft.json');
    await writeFile(path.resolve(relativePath), `${JSON.stringify(artifact, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    if (this.database.readyState === 1) {
      await this.database
        .collection('capabilityArtifacts')
        .updateOne(
          {
            artifactId: artifact.artifactId,
            artifactVersion: artifact.artifactVersion,
            'source.runId': artifact.source.runId,
          },
          { $set: artifact },
          { upsert: true },
        )
        .catch(() =>
          console.error(
            JSON.stringify({
              service: 'automation',
              event: 'artifact_mongo_write_failed',
              runId: this.run.runId,
            }),
          ),
        );
    }
    return relativePath;
  }
}

export function eventInput(
  type: TelemetryEvent['type'],
  code: string,
  step: number,
  overrides: Partial<EventInput> = {},
): EventInput {
  return {
    type,
    code,
    step,
    attempt: 1,
    durationMs: null,
    actionKind: null,
    targetRef: null,
    purpose: null,
    observationRevision: null,
    stateHash: null,
    model: null,
    providerRequestId: null,
    inputTokens: null,
    outputTokens: null,
    ...overrides,
  };
}
