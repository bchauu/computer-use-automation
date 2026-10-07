import type { Connection } from 'mongoose';
import type { ModelAction, SuccessCriteria } from '../contracts/discovery.ts';
import type { ActionEvidence } from '../contracts/capability.ts';
import { inputsFromCriteria, newId } from '../contracts/discovery.ts';
import { CapabilityCatalog } from './catalog.ts';
import { compileTransactionHistoryArtifact } from './compiler.ts';
import { verifyCompletion } from './completion.ts';
import { buildActionEvidence } from './evidence.ts';
import { executeAction, validateAction } from './executor.ts';
import type { DecisionClient } from './model.ts';
import { observe } from './observer.ts';
import { evaluateActionPolicy, evaluateKnownNoticePolicy } from './policy.ts';
import type { ActionPolicyConfig } from './policy.ts';
import type { LiveSession } from './sessions.ts';
import { eventInput, RunTelemetry } from './telemetry.ts';
import type { PublicRun } from './types.ts';
import type { RunResultCategory } from './types.ts';
import { classifyRuntime, failureDiagnostic } from './runtime.ts';
import { Deadline } from '../shared/deadline.ts';
import { requestDecision } from './model-request.ts';
import type { ModelRequestConfig, ModelUsage } from './model-request.ts';

export interface DiscoveryConfig extends ModelRequestConfig {
  maxSteps: number;
  runTimeoutMs: number;
  actionTimeoutMs: number;
  repeatedDecisionLimit: number;
  noProgressLimit: number;
  actionPolicy: ActionPolicyConfig;
}

async function observeAfterRender(page: LiveSession['page'], sequence: string) {
  await page.waitForTimeout(500);
  return observe(page, sequence);
}

export class DiscoveryController {
  readonly runs = new Map<string, PublicRun>();
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly cancelRequested = new Set<string>();
  private readonly database: Connection;
  private readonly modelClient: DecisionClient;
  private readonly config: DiscoveryConfig;
  private readonly catalog: CapabilityCatalog;
  constructor(
    database: Connection,
    modelClient: DecisionClient,
    config: DiscoveryConfig,
    catalog: CapabilityCatalog,
  ) {
    this.database = database;
    this.modelClient = modelClient;
    this.config = config;
    this.catalog = catalog;
  }

  start(session: LiveSession, goal: string, criteria: SuccessCriteria) {
    if (session.activeRunId) throw new Error('SESSION_BUSY');
    const run: PublicRun = {
      runId: newId(),
      sessionId: session.sessionId,
      mode: 'discovery',
      status: 'created',
      goalSummary: `${criteria.accountType} transaction history · ${criteria.period === 'latest' ? 'latest posted' : `last ${criteria.period} days`}`,
      inputs: inputsFromCriteria(criteria),
      criteria,
      step: 0,
      maxSteps: this.config.maxSteps,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      result: null,
      artifact: null,
      events: [],
    };
    this.runs.set(run.runId, run);
    this.abortControllers.set(run.runId, new AbortController());
    session.activeRunId = run.runId;
    session.owner = 'automation';
    session.epoch += 1;
    void this.execute(run, session, goal).finally(() => {
      this.abortControllers.delete(run.runId);
      this.cancelRequested.delete(run.runId);
      session.activeRunId = null;
      if (session.owner === 'automation') {
        session.owner = 'human';
        session.epoch += 1;
      }
    });
    return run;
  }

  cancel(runId: string, session: LiveSession) {
    const run = this.runs.get(runId);
    if (!run || run.sessionId !== session.sessionId) return 'not_found' as const;
    if (!['created', 'running'].includes(run.status)) return 'not_running' as const;
    this.cancelRequested.add(runId);
    this.abortControllers.get(runId)?.abort();
    return 'accepted' as const;
  }

  private async execute(run: PublicRun, session: LiveSession, goal: string) {
    const telemetry = new RunTelemetry(run, this.database);
    const deadline = new Deadline(this.config.runTimeoutMs);
    const recent: Array<{ action: string; result: string }> = [];
    const evidence: ActionEvidence[] = [];
    const repetitions = new Map<string, number>();
    const abortSignal = this.abortControllers.get(run.runId)?.signal;
    const modelUsage: ModelUsage = { calls: 0, tokens: 0 };
    let consecutiveNoProgress = 0;
    run.status = 'running';
    await telemetry.record(eventInput('run_started', 'DISCOVERY_STARTED', 0));
    try {
      for (let step = 1; step <= this.config.maxSteps; step += 1) {
        run.step = step;
        if (this.cancelRequested.has(run.runId))
          return await this.finish(
            run,
            telemetry,
            evidence,
            'cancelled',
            'RUN_CANCELLED',
            'Discovery was cancelled.',
          );
        if (deadline.expired)
          return await this.finish(
            run,
            telemetry,
            evidence,
            'failed',
            'RUN_TIMEOUT',
            'Discovery exceeded its configured overall timeout.',
          );
        if (session.owner !== 'automation' || session.activeRunId !== run.runId)
          return await this.finish(
            run,
            telemetry,
            evidence,
            'failed',
            'OWNERSHIP_LOST',
            'Automation no longer owns this session.',
          );
        if (new URL(session.page.url()).origin !== session.allowedOrigin)
          return await this.finish(
            run,
            telemetry,
            evidence,
            'failed',
            'ORIGIN_BLOCKED',
            'The browser left the allowed target origin.',
          );

        let runtime = await classifyRuntime(session.page);
        if (runtime.kind === 'loading') {
          const waitDeadline = Date.now() + Math.min(this.config.actionTimeoutMs, 5000);
          await telemetry.record(eventInput('retry', 'WAITING_FOR_LOADING_STATE', step));
          while (runtime.kind === 'loading' && Date.now() < waitDeadline) {
            await session.page.waitForTimeout(100);
            runtime = await classifyRuntime(session.page);
          }
        }
        if (runtime.kind === 'recoverable' && runtime.code === 'KNOWN_NOTICE') {
          const dismiss = session.page.getByRole('button', { name: 'Dismiss notice', exact: true });
          if ((await dismiss.count()) === 1) {
            const policy = await evaluateKnownNoticePolicy(
              session.page,
              dismiss,
              session.allowedOrigin,
            );
            if (!policy.ok) {
              await telemetry.record(eventInput('policy', policy.code, step));
              return await this.finish(
                run,
                telemetry,
                evidence,
                'failed',
                'RECOVERY_TARGET_INVALID',
                policy.message,
              );
            }
            await telemetry.record(
              eventInput('policy', 'AUTHORED_RECOVERY_ALLOWED', step, {
                actionKind: 'click',
                targetRef: 'button:Dismiss notice',
              }),
            );
            await dismiss.click({ timeout: this.config.actionTimeoutMs });
            await telemetry.record(
              eventInput('action', 'AUTHORED_RECOVERY_EXECUTED', step, {
                actionKind: 'click',
                targetRef: 'button:Dismiss notice',
              }),
            );
            runtime = await classifyRuntime(session.page);
          }
        }
        if (runtime.kind === 'intervention') {
          const diagnostic = await failureDiagnostic({
            run,
            page: session.page,
            phase: 'pre_action',
            stepId: null,
            effectState: 'not_attempted',
            routeTemplate: null,
            expectedHeadings: [],
            recoveryReason: runtime.resumable
              ? 'Human intervention is required.'
              : 'No safe automated recovery is declared.',
          });
          return await this.finish(
            run,
            telemetry,
            evidence,
            'failed',
            runtime.code,
            'Discovery encountered a state requiring operator review.',
            'intervention',
            diagnostic,
          );
        }
        if (runtime.kind === 'hard_failure' || runtime.kind === 'loading') {
          const diagnostic = await failureDiagnostic({
            run,
            page: session.page,
            phase: 'pre_action',
            stepId: null,
            effectState: 'not_attempted',
            routeTemplate: null,
            expectedHeadings: [],
            recoveryAttempted: runtime.kind === 'loading',
            recoveryReason:
              runtime.kind === 'loading'
                ? 'The bounded loading wait expired.'
                : 'The application reported a terminal error.',
          });
          return await this.finish(
            run,
            telemetry,
            evidence,
            'failed',
            runtime.kind === 'loading' ? 'LOADING_TIMEOUT' : runtime.code,
            'Discovery could not safely continue.',
            'hard_failure',
            diagnostic,
          );
        }

        const observationStarted = performance.now();
        const observation = await observe(session.page, `${step}-before`);
        await telemetry.record(
          eventInput('observation', 'OBSERVATION_CAPTURED', step, {
            durationMs: Math.round(performance.now() - observationStarted),
            observationRevision: observation.revision,
            stateHash: observation.stateHash,
          }),
        );

        const alreadyComplete = await verifyCompletion(session.page, run.criteria);
        if (alreadyComplete.ok)
          return await this.finish(
            run,
            telemetry,
            evidence,
            'succeeded',
            alreadyComplete.code,
            alreadyComplete.message,
          );

        const decisionEpoch = session.epoch;
        const requested = await requestDecision({
          client: this.modelClient,
          input: {
            goal,
            criteria: run.criteria,
            observation,
            recent: recent.slice(-8),
            step,
            maxSteps: this.config.maxSteps,
            ...(abortSignal ? { signal: abortSignal } : {}),
          },
          config: this.config,
          usage: modelUsage,
          deadline,
          telemetry,
          isCancelled: () => this.cancelRequested.has(run.runId),
        });
        if (requested.kind === 'stopped') {
          return await this.finish(
            run,
            telemetry,
            evidence,
            requested.status,
            requested.code,
            requested.message,
          );
        }
        const { decision } = requested;
        if (deadline.expired)
          return await this.finish(
            run,
            telemetry,
            evidence,
            'failed',
            'RUN_TIMEOUT',
            'Discovery exceeded its configured overall timeout.',
          );
        if (this.cancelRequested.has(run.runId))
          return await this.finish(
            run,
            telemetry,
            evidence,
            'cancelled',
            'RUN_CANCELLED',
            'Discovery was cancelled while a model response was pending.',
          );
        if (
          session.owner !== 'automation' ||
          session.epoch !== decisionEpoch ||
          session.activeRunId !== run.runId
        ) {
          return await this.finish(
            run,
            telemetry,
            evidence,
            'failed',
            'STALE_MODEL_RESPONSE',
            'A model response arrived after session ownership changed.',
          );
        }
        const action: ModelAction = decision.action;
        const validation = validateAction(action, observation);
        await telemetry.record(
          eventInput('validation', validation.code, step, {
            actionKind: action.kind,
            targetRef: action.targetRef,
            purpose: action.purpose,
            observationRevision: observation.revision,
            stateHash: observation.stateHash,
          }),
        );
        if (!validation.ok) {
          recent.push({ action: action.kind, result: validation.code });
          continue;
        }
        const policy = evaluateActionPolicy(action, observation, this.config.actionPolicy);
        await telemetry.record(
          eventInput('policy', policy.code, step, {
            actionKind: action.kind,
            targetRef: action.targetRef,
            purpose: action.purpose,
            observationRevision: observation.revision,
            stateHash: observation.stateHash,
          }),
        );
        if (!policy.ok) {
          recent.push({ action: action.kind, result: policy.code });
          continue;
        }
        if (action.kind === 'request_human') {
          return await this.finish(
            run,
            telemetry,
            evidence,
            'failed',
            'HUMAN_REQUESTED',
            action.purpose,
            'intervention',
          );
        }
        if (action.kind === 'complete') {
          const completion = await verifyCompletion(session.page, run.criteria);
          await telemetry.record(
            eventInput('validation', completion.code, step, {
              actionKind: action.kind,
              purpose: action.purpose,
            }),
          );
          if (completion.ok)
            return await this.finish(
              run,
              telemetry,
              evidence,
              'succeeded',
              completion.code,
              completion.message,
            );
          recent.push({ action: 'complete', result: completion.code });
          continue;
        }

        const repetitionKey = `${observation.stateHash}:${action.kind}:${action.targetRef ?? action.direction ?? ''}`;
        const repeated = (repetitions.get(repetitionKey) ?? 0) + 1;
        repetitions.set(repetitionKey, repeated);
        if (repeated > this.config.repeatedDecisionLimit) {
          return await this.finish(
            run,
            telemetry,
            evidence,
            'failed',
            'REPEATED_NO_PROGRESS',
            'The same state and action repeated without progress.',
          );
        }
        const actionStarted = performance.now();
        if (deadline.expired)
          return await this.finish(
            run,
            telemetry,
            evidence,
            'failed',
            'RUN_TIMEOUT',
            'Discovery exceeded its configured overall timeout.',
          );
        let result: Awaited<ReturnType<typeof executeAction>>;
        try {
          result = await executeAction(
            session.page,
            action,
            observation,
            this.config.actionTimeoutMs,
            session.allowedOrigin,
          );
        } catch {
          const durationMs = Math.round(performance.now() - actionStarted);
          await telemetry.record(
            eventInput('action', 'ACTION_FAILED_UNKNOWN_EFFECT', step, {
              durationMs,
              actionKind: action.kind,
              targetRef: action.targetRef,
              purpose: action.purpose,
              observationRevision: observation.revision,
            }),
          );
          const after = await observeAfterRender(session.page, `${step}-after-failure`).catch(
            () => null,
          );
          const item = buildActionEvidence({
            runId: run.runId,
            step,
            before: observation,
            after,
            action,
            executionStatus: 'failed_unknown_effect',
            executionCode: 'ACTION_FAILED_UNKNOWN_EFFECT',
            durationMs,
            completionCheck: null,
          });
          evidence.push(item);
          await telemetry.recordEvidence(item);
          await telemetry.record(
            eventInput('evidence', 'ACTION_FAILURE_EVIDENCE_RECORDED', step, {
              actionKind: action.kind,
              observationRevision: observation.revision,
              stateHash: after?.stateHash ?? observation.stateHash,
            }),
          );
          return await this.finish(
            run,
            telemetry,
            evidence,
            'failed',
            'ACTION_EFFECT_UNKNOWN',
            'Discovery stopped because the attempted action may already have taken effect.',
            'hard_failure',
            await failureDiagnostic({
              run,
              page: session.page,
              phase: 'action',
              stepId: null,
              effectState: 'attempted_effect_unknown',
              routeTemplate: null,
              expectedHeadings: [],
              recoveryReason:
                'The action threw after dispatch; discovery will not speculate or issue another action.',
            }),
          );
        }
        const durationMs = Math.round(performance.now() - actionStarted);
        await telemetry.record(
          eventInput('action', result.code, step, {
            durationMs,
            actionKind: action.kind,
            targetRef: action.targetRef,
            purpose: action.purpose,
            observationRevision: observation.revision,
          }),
        );
        const after = await observeAfterRender(session.page, `${step}-after`).catch(() => null);
        const completion = after ? await verifyCompletion(session.page, run.criteria) : null;
        if (!result.ok) {
          const item = buildActionEvidence({
            runId: run.runId,
            step,
            before: observation,
            after,
            action,
            executionStatus: 'not_executed',
            executionCode: result.code,
            durationMs,
            completionCheck: completion ? { ok: completion.ok, code: completion.code } : null,
          });
          evidence.push(item);
          await telemetry.recordEvidence(item);
          await telemetry.record(
            eventInput('evidence', 'BLOCKED_ACTION_EVIDENCE_RECORDED', step, {
              actionKind: action.kind,
              observationRevision: observation.revision,
              stateHash: after?.stateHash ?? observation.stateHash,
            }),
          );
          recent.push({
            action: `${action.kind}:${action.targetRef ?? action.direction ?? ''}`,
            result: result.code,
          });
          continue;
        }
        const item = buildActionEvidence({
          runId: run.runId,
          step,
          before: observation,
          after,
          action,
          executionStatus: 'executed',
          executionCode: result.code,
          durationMs,
          completionCheck: completion ? { ok: completion.ok, code: completion.code } : null,
        });
        evidence.push(item);
        await telemetry.recordEvidence(item);
        await telemetry.record(
          eventInput('evidence', 'ACTION_EVIDENCE_RECORDED', step, {
            actionKind: action.kind,
            observationRevision: observation.revision,
            stateHash: after?.stateHash ?? observation.stateHash,
          }),
        );
        const changed = after !== null && after.stateHash !== observation.stateHash;
        if (!changed && action.kind !== 'scroll') {
          consecutiveNoProgress += 1;
          await telemetry.record(
            eventInput('validation', 'NO_STATE_CHANGE', step, {
              actionKind: action.kind,
              targetRef: action.targetRef,
              observationRevision: observation.revision,
              stateHash: observation.stateHash,
            }),
          );
        } else {
          consecutiveNoProgress = 0;
        }
        const actionOutcome = changed || action.kind === 'scroll' ? result.code : 'NO_STATE_CHANGE';
        recent.push({
          action: `${action.kind}:${action.targetRef ?? action.direction ?? ''}`,
          result: actionOutcome,
        });
        if (this.cancelRequested.has(run.runId)) {
          return await this.finish(
            run,
            telemetry,
            evidence,
            'cancelled',
            'RUN_CANCELLED',
            'Discovery was cancelled after the current action settled.',
          );
        }
        if (consecutiveNoProgress > this.config.noProgressLimit) {
          return await this.finish(
            run,
            telemetry,
            evidence,
            'failed',
            'NO_PROGRESS_LIMIT',
            'Actions completed without producing an observable state change.',
          );
        }
        if (completion?.ok) {
          return await this.finish(
            run,
            telemetry,
            evidence,
            'succeeded',
            completion.code,
            completion.message,
          );
        }
      }
      await this.finish(
        run,
        telemetry,
        evidence,
        'failed',
        'STEP_LIMIT',
        'Discovery reached its configured step limit.',
      );
    } catch (error) {
      if (this.cancelRequested.has(run.runId)) {
        await this.finish(
          run,
          telemetry,
          evidence,
          'cancelled',
          'RUN_CANCELLED',
          'Discovery was cancelled.',
        );
        return;
      }
      const message = error instanceof Error ? error.message : '';
      const code =
        message === 'MODEL_OUTPUT_UNPARSEABLE'
          ? 'MODEL_OUTPUT_UNPARSEABLE'
          : /target page|browser.*closed|context.*closed/i.test(message)
            ? 'SESSION_LOST'
            : 'DISCOVERY_FAILED';
      const resultMessage =
        code === 'SESSION_LOST'
          ? 'The managed browser session closed or became unavailable.'
          : 'Discovery stopped after a non-retryable error.';
      await this.finish(run, telemetry, evidence, 'failed', code, resultMessage);
    }
  }

  private async finish(
    run: PublicRun,
    telemetry: RunTelemetry,
    evidence: ActionEvidence[],
    status: 'succeeded' | 'failed' | 'cancelled',
    code: string,
    message: string,
    category?: RunResultCategory,
    diagnostic: NonNullable<PublicRun['result']>['diagnostic'] = null,
  ) {
    const result: NonNullable<PublicRun['result']> = {
      category:
        category ??
        (status === 'succeeded'
          ? 'success'
          : status === 'cancelled'
            ? 'cancelled'
            : 'hard_failure'),
      code,
      message,
      output: null,
      diagnostic,
    };
    if (status === 'succeeded' && result.category === 'success') {
      try {
        const artifact = compileTransactionHistoryArtifact(
          { ...run, status, result },
          evidence,
          this.modelClient.model,
        );
        const artifactPath = await telemetry.saveDraftArtifact(artifact);
        await this.catalog.register(artifact);
        run.artifact = {
          artifactId: artifact.artifactId,
          artifactVersion: artifact.artifactVersion,
          status: artifact.status,
          path: artifactPath,
        };
        await telemetry.record(eventInput('artifact', 'DRAFT_ARTIFACT_COMPILED', run.step));
      } catch {
        await telemetry.record(eventInput('artifact', 'ARTIFACT_COMPILATION_FAILED', run.step));
      }
    }
    run.status = status;
    run.finishedAt = new Date().toISOString();
    run.result = result;
    await telemetry.record(eventInput('run_finished', result.code, run.step));
  }
}
