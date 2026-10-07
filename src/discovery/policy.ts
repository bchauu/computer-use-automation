import type { ModelAction } from '../contracts/discovery.ts';
import type { CapabilityArtifact } from '../contracts/capability.ts';
import type { Observation } from './types.ts';
import type { Locator, Page } from 'playwright';

export const EXECUTION_POLICY_VERSION = 'read-only-bank-v2';

export interface ActionPolicyConfig {
  allowedActionKinds: ReadonlySet<ModelAction['kind']>;
  blockedTargetPatterns: readonly RegExp[];
}

export interface PolicyDecision {
  ok: boolean;
  code: 'POLICY_ALLOWED' | 'ACTION_KIND_DENIED' | 'TARGET_EFFECT_DENIED';
  message: string;
}

export const readOnlyDiscoveryPolicy: ActionPolicyConfig = {
  allowedActionKinds: new Set(['click', 'select', 'back', 'scroll', 'complete', 'request_human']),
  blockedTargetPatterns: [
    /\b(create|open new|delete|remove|transfer|pay|submit|approve|confirm|send|upload|download)\b/i,
  ],
};

export function evaluateActionPolicy(
  action: ModelAction,
  observation: Observation,
  policy: ActionPolicyConfig,
): PolicyDecision {
  if (!policy.allowedActionKinds.has(action.kind)) {
    return {
      ok: false,
      code: 'ACTION_KIND_DENIED',
      message: 'The action kind is not allowed by the active policy.',
    };
  }
  if (!action.targetRef)
    return { ok: true, code: 'POLICY_ALLOWED', message: 'The action passed the active policy.' };
  const control = observation.controls.find((item) => item.ref === action.targetRef);
  if (!control)
    return {
      ok: true,
      code: 'POLICY_ALLOWED',
      message: 'Target existence is handled by runtime validation.',
    };
  const targetDescription = `${control.name} ${control.contextText ?? ''}`;
  if (policy.blockedTargetPatterns.some((pattern) => pattern.test(targetDescription))) {
    return {
      ok: false,
      code: 'TARGET_EFFECT_DENIED',
      message: 'The target appears to have an effect denied by the active policy.',
    };
  }
  return { ok: true, code: 'POLICY_ALLOWED', message: 'The action passed the active policy.' };
}

type ArtifactStep = CapabilityArtifact['steps'][number];

// Inspect live DOM properties, including controls associated with a form outside
// their ancestor tree. Labels alone cannot establish what a click will do.
async function inspectTarget(locator: Locator) {
  return locator
    .evaluate((element) => {
      const html = element as HTMLElement;
      const control = element as HTMLInputElement;
      const anchor = element instanceof HTMLAnchorElement ? element : null;
      const dialog = element.closest('[role="dialog"]');
      return {
        tag: element.tagName.toLowerCase(),
        href: anchor?.href ?? null,
        inForm: Boolean(control.form || element.closest('form')),
        download: anchor?.hasAttribute('download') ?? false,
        target: anchor?.target ?? '',
        label: (
          element.getAttribute('aria-label') ||
          control.labels?.[0]?.innerText ||
          html.innerText ||
          ''
        )
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 180),
        knownNotice: Boolean(
          dialog?.querySelector('h2')?.textContent?.trim() === 'Scheduled maintenance notice',
        ),
      };
    })
    .catch(() => null);
}

export interface ReplayPolicyDecision {
  ok: boolean;
  code:
    | 'POLICY_ALLOWED'
    | 'ROUTE_DENIED'
    | 'TARGET_EFFECT_DENIED'
    | 'DESTINATION_DENIED'
    | 'SURFACE_SCOPE_DENIED';
  message: string;
  version: string;
}

export async function evaluateReplayPolicy(
  page: Page,
  locator: Locator | null,
  step: ArtifactStep,
  allowedOrigin: string,
  surface: CapabilityArtifact['surface'],
): Promise<ReplayPolicyDecision> {
  if (surface.kind !== 'browser' || surface.frame.kind !== 'top') {
    return {
      ok: false,
      code: 'SURFACE_SCOPE_DENIED',
      message: 'Only the declared top-level browser surface is supported.',
      version: EXECUTION_POLICY_VERSION,
    };
  }
  return evaluateExecutionPolicy(page, locator, step.action.kind, allowedOrigin);
}

export async function evaluateExecutionPolicy(
  page: Page,
  locator: Locator | null,
  kind: ModelAction['kind'],
  allowedOrigin: string,
): Promise<ReplayPolicyDecision> {
  const allow = (message: string): ReplayPolicyDecision => ({
    ok: true,
    code: 'POLICY_ALLOWED',
    message,
    version: EXECUTION_POLICY_VERSION,
  });
  const deny = (
    code: Exclude<ReplayPolicyDecision['code'], 'POLICY_ALLOWED'>,
    message: string,
  ): ReplayPolicyDecision => ({ ok: false, code, message, version: EXECUTION_POLICY_VERSION });
  const current = new URL(page.url());
  if (current.origin !== allowedOrigin)
    return deny('ROUTE_DENIED', 'The current page is outside the allowed origin.');
  const route = current.hash.slice(1) || current.pathname;
  if (!/^\/(members(?:\/[^/]+)?|transactions)(?:\/|$)/.test(route))
    return deny('ROUTE_DENIED', 'The current route is outside this capability policy.');
  if (kind === 'back' || kind === 'scroll')
    return allow('The read-only browser action is allowed.');
  if (!locator) return deny('TARGET_EFFECT_DENIED', 'A target is required for this action.');
  const target = await inspectTarget(locator);
  if (!target)
    return deny('TARGET_EFFECT_DENIED', 'The target could not be inspected before execution.');
  if (
    /\b(create|open new|delete|remove|transfer|pay|submit|approve|confirm|send|upload)\b/i.test(
      target.label,
    )
  ) {
    return deny(
      'TARGET_EFFECT_DENIED',
      'The target label indicates an effect forbidden by this read-only capability.',
    );
  }
  if (kind === 'click') {
    if (
      target.tag !== 'a' ||
      !target.href ||
      target.inForm ||
      target.download ||
      !['', '_self'].includes(target.target)
    )
      return deny(
        'TARGET_EFFECT_DENIED',
        'Navigation clicks must resolve to a non-form link in the same browser surface without a download.',
      );
    const destination = new URL(target.href);
    const destinationRoute = destination.hash.slice(1) || destination.pathname;
    if (
      destination.origin !== allowedOrigin ||
      !/^\/(transactions|members\/[^/]+\/accounts\/[^/]+\/(?:overview|history|pending))$/.test(
        destinationRoute,
      )
    ) {
      return deny(
        'DESTINATION_DENIED',
        'The link destination is outside the capability route allowlist.',
      );
    }
    return allow('The same-origin read-only navigation link is allowed.');
  }
  if (
    kind === 'select' &&
    target.tag === 'select' &&
    !target.inForm &&
    ['History period', 'Account type'].includes(target.label)
  ) {
    return allow('The declared read-only filter selection is allowed.');
  }
  return deny(
    'TARGET_EFFECT_DENIED',
    'The resolved target effect is not allowed for this artifact action.',
  );
}

export async function evaluateKnownNoticePolicy(
  page: Page,
  locator: Locator,
  allowedOrigin: string,
): Promise<ReplayPolicyDecision> {
  const routePolicy = await evaluateExecutionPolicy(page, null, 'scroll', allowedOrigin);
  if (!routePolicy.ok) return routePolicy;
  const target = await inspectTarget(locator);
  if (
    !target ||
    target.tag !== 'button' ||
    target.label !== 'Dismiss notice' ||
    target.inForm ||
    !target.knownNotice
  ) {
    return {
      ok: false,
      code: 'TARGET_EFFECT_DENIED',
      message:
        'Notice recovery requires the exact non-form dismissal button inside the known notice dialog.',
      version: EXECUTION_POLICY_VERSION,
    };
  }
  return {
    ok: true,
    code: 'POLICY_ALLOWED',
    message: 'The declared known-notice dismissal is allowed.',
    version: EXECUTION_POLICY_VERSION,
  };
}

export async function evaluateExtractionPaginationPolicy(
  page: Page,
  locator: Locator,
  allowedOrigin: string,
  accessibleName: string,
): Promise<ReplayPolicyDecision> {
  const allow = (message: string): ReplayPolicyDecision => ({
    ok: true,
    code: 'POLICY_ALLOWED',
    message,
    version: EXECUTION_POLICY_VERSION,
  });
  const deny = (
    code: Exclude<ReplayPolicyDecision['code'], 'POLICY_ALLOWED'>,
    message: string,
  ): ReplayPolicyDecision => ({ ok: false, code, message, version: EXECUTION_POLICY_VERSION });
  const current = new URL(page.url());
  const route = current.hash.slice(1) || current.pathname;
  if (
    current.origin !== allowedOrigin ||
    !/^\/members\/[^/]+\/accounts\/[^/]+\/history$/.test(route)
  ) {
    return deny(
      'ROUTE_DENIED',
      'Output pagination is allowed only on the declared same-origin history route.',
    );
  }
  const target = await inspectTarget(locator);
  if (!target || target.tag !== 'button' || target.label !== accessibleName || target.inForm) {
    return deny(
      'TARGET_EFFECT_DENIED',
      'Output pagination must resolve to the exact non-form button declared by the artifact.',
    );
  }
  return allow('The declared same-origin read-only output pagination action is allowed.');
}
