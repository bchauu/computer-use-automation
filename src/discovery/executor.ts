import type { Page } from 'playwright';
import { stableHash } from '../contracts/discovery.ts';
import type { ModelAction } from '../contracts/discovery.ts';
import { interactiveSelector } from './observer.ts';
import type { Observation } from './types.ts';
import { evaluateExecutionPolicy } from './policy.ts';

export interface ActionResult {
  ok: boolean;
  code: string;
  message: string;
}

export function validateAction(action: ModelAction, observation: Observation): ActionResult {
  if (action.observationRevision !== observation.revision)
    return {
      ok: false,
      code: 'STALE_MODEL_RESPONSE',
      message: 'The decision references an obsolete observation.',
    };
  if (['click', 'fill', 'select'].includes(action.kind)) {
    const control = observation.controls.find((item) => item.ref === action.targetRef);
    if (!control)
      return {
        ok: false,
        code: 'UNKNOWN_TARGET',
        message: 'The requested control is not in the current observation.',
      };
    if (control.disabled)
      return { ok: false, code: 'TARGET_DISABLED', message: 'The requested control is disabled.' };
  }
  if (['fill', 'select'].includes(action.kind) && !action.value)
    return { ok: false, code: 'VALUE_REQUIRED', message: 'This action requires a value.' };
  if (action.kind === 'scroll' && !action.direction)
    return { ok: false, code: 'DIRECTION_REQUIRED', message: 'Scroll requires a direction.' };
  return {
    ok: true,
    code: 'ACTION_VALID',
    message: 'Action passed schema, revision, and target validation.',
  };
}

export async function executeAction(
  page: Page,
  action: ModelAction,
  observation: Observation,
  timeoutMs: number,
  allowedOrigin: string,
): Promise<ActionResult> {
  if (action.kind === 'back' || action.kind === 'scroll') {
    const policy = await evaluateExecutionPolicy(page, null, action.kind, allowedOrigin);
    if (!policy.ok) return policy;
  }
  if (action.kind === 'back') {
    await page.goBack({ waitUntil: 'domcontentloaded', timeout: timeoutMs });
    return { ok: true, code: 'BACK_EXECUTED', message: 'Browser history moved back.' };
  }
  if (action.kind === 'scroll') {
    await page.mouse.wheel(0, action.direction === 'down' ? 700 : -700);
    return { ok: true, code: 'SCROLL_EXECUTED', message: 'Page scrolled.' };
  }
  const control = observation.controls.find((item) => item.ref === action.targetRef);
  if (!control)
    return { ok: false, code: 'UNKNOWN_TARGET', message: 'Target disappeared before execution.' };
  const locator = page.locator(interactiveSelector).nth(control.index);
  const current = await locator
    .evaluate((element) => {
      const html = element as HTMLElement;
      const input = element as HTMLInputElement;
      const tag = element.tagName.toLowerCase();
      const label =
        element.getAttribute('aria-label') || input.labels?.[0]?.innerText?.trim() || '';
      const clone = html.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('[aria-hidden="true"]').forEach((node) => node.remove());
      const text = clone.textContent?.trim() || input.placeholder || '';
      return {
        tag,
        role:
          element.getAttribute('role') ||
          (tag === 'a' ? 'link' : tag === 'button' ? 'button' : tag),
        name: (label || text || element.getAttribute('title') || '')
          .replace(/\s+/g, ' ')
          .slice(0, 180),
        type: input.type || '',
      };
    })
    .catch(() => null);
  const fingerprint = current ? stableHash(current) : null;
  if (!current || fingerprint !== control.fingerprint)
    return {
      ok: false,
      code: 'TARGET_DRIFTED',
      message: 'The target changed after observation; no action was executed.',
    };
  const policy = await evaluateExecutionPolicy(page, locator, action.kind, allowedOrigin);
  if (!policy.ok) return policy;
  if (action.kind === 'click') await locator.click({ timeout: timeoutMs });
  else if (action.kind === 'select')
    await locator.selectOption({ label: action.value! }, { timeout: timeoutMs });
  else if (action.kind === 'fill') {
    if (control.type === 'password')
      return {
        ok: false,
        code: 'SENSITIVE_FIELD_BLOCKED',
        message: 'Discovery cannot fill password fields.',
      };
    await locator.fill(action.value!, { timeout: timeoutMs });
  }
  return { ok: true, code: 'ACTION_EXECUTED', message: 'The validated action executed.' };
}
