import { actionEvidenceSchema } from '../contracts/capability.ts';
import type { ActionEvidence } from '../contracts/capability.ts';
import type { ModelAction } from '../contracts/discovery.ts';
import type { Observation, ObservedControl } from './types.ts';
import { sanitizePersistedText as sanitizeText } from './sanitization.ts';

export function observationEvidence(observation: Observation) {
  return {
    revision: observation.revision,
    stateHash: observation.stateHash,
    route: observation.route.replace(/\?.*?(?=#|$)/, ''),
    headings: observation.headings.map((heading) => sanitizeText(heading) ?? '').filter(Boolean),
    controlCount: observation.controls.length,
    selectedControls: observation.controls
      .filter((control) => control.tag === 'select' && control.value !== null)
      .map((control) => ({
        label: sanitizeText(control.name) ?? '',
        value: sanitizeText(control.value) ?? '',
      }))
      .filter((control) => control.label && control.value),
  };
}

export function selectedTargetEvidence(control: ObservedControl | null) {
  if (!control) return null;
  return {
    fingerprint: control.fingerprint,
    tag: control.tag,
    role: control.role,
    accessibleName: sanitizeText(control.name) ?? '',
    type: control.type,
    disabled: control.disabled,
    contextRole: sanitizeText(control.contextRole),
    contextText: sanitizeText(control.contextText),
    optionLabels: control.options.map((option) => sanitizeText(option) ?? '').filter(Boolean),
  };
}

export function buildActionEvidence(input: {
  runId: string;
  step: number;
  before: Observation;
  after: Observation | null;
  action: ModelAction;
  executionStatus: 'executed' | 'not_executed' | 'failed_unknown_effect';
  executionCode: string;
  durationMs: number;
  completionCheck: { ok: boolean; code: string } | null;
}): ActionEvidence {
  const control = input.action.targetRef
    ? (input.before.controls.find((candidate) => candidate.ref === input.action.targetRef) ?? null)
    : null;
  return actionEvidenceSchema.parse({
    schemaVersion: 1,
    runId: input.runId,
    step: input.step,
    before: observationEvidence(input.before),
    target: selectedTargetEvidence(control),
    action: {
      kind: input.action.kind,
      purpose: sanitizeText(input.action.purpose)?.slice(0, 240) || 'Purpose omitted',
      safeSelectedValue: input.action.kind === 'select' ? sanitizeText(input.action.value) : null,
      direction: input.action.kind === 'scroll' ? input.action.direction : null,
    },
    execution: {
      status: input.executionStatus,
      code: input.executionCode,
      durationMs: input.durationMs,
    },
    after: input.after ? observationEvidence(input.after) : null,
    completionCheck: input.completionCheck,
  });
}
