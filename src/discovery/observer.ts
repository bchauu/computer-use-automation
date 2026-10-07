import type { Page } from 'playwright';
import { stableHash } from '../contracts/discovery.ts';
import type { Observation, ObservedControl } from './types.ts';

export const interactiveSelector = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  '[role="button"]',
  '[role="link"]',
  '[role="combobox"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

interface RawControl {
  index: number;
  tag: string;
  role: string;
  name: string;
  type: string;
  disabled: boolean;
  value: string | null;
  options: string[];
  contextRole: string | null;
  contextText: string | null;
}

function compact(value: string, max = 12_000) {
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

export async function observe(page: Page, sequence: number | string): Promise<Observation> {
  const route = await page.evaluate(() => `${location.pathname}${location.hash}`);
  const title = await page.title();
  const headings = (await page.locator('h1,h2,h3').allTextContents())
    .map((value) => compact(value, 200))
    .filter(Boolean)
    .slice(0, 30);
  const visibleText = compact(await page.locator('body').innerText());
  const raw = await page.locator(interactiveSelector).evaluateAll((elements): RawControl[] =>
    elements
      .map((element, index) => ({ element, index }))
      .filter(({ element }) => {
        const node = element as HTMLElement;
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== 'hidden' &&
          style.display !== 'none'
        );
      })
      .slice(0, 200)
      .map(({ element, index }) => {
        const html = element as HTMLElement;
        const input = element as HTMLInputElement;
        const select = element as HTMLSelectElement;
        const tag = element.tagName.toLowerCase();
        const type = input.type || '';
        const sensitive = type === 'password';
        const label =
          element.getAttribute('aria-label') || input.labels?.[0]?.innerText?.trim() || '';
        const clone = html.cloneNode(true) as HTMLElement;
        clone.querySelectorAll('[aria-hidden="true"]').forEach((node) => node.remove());
        const text = clone.textContent?.trim() || input.placeholder || '';
        const name = (label || text || element.getAttribute('title') || '')
          .replace(/\s+/g, ' ')
          .slice(0, 180);
        const context = element.closest('tr,[role="row"],li,[role="listitem"],fieldset');
        return {
          index,
          tag,
          role:
            element.getAttribute('role') ||
            (tag === 'a' ? 'link' : tag === 'button' ? 'button' : tag),
          name,
          type,
          disabled: input.disabled || element.getAttribute('aria-disabled') === 'true',
          value: sensitive
            ? null
            : tag === 'select'
              ? select.value
              : ['input', 'textarea'].includes(tag)
                ? input.value.slice(0, 120)
                : null,
          options:
            tag === 'select'
              ? Array.from(select.options)
                  .map((option) => option.text.trim())
                  .slice(0, 30)
              : [],
          contextRole:
            context?.getAttribute('role') ||
            (context?.tagName.toLowerCase() === 'tr'
              ? 'row'
              : context?.tagName.toLowerCase() === 'li'
                ? 'listitem'
                : context?.tagName.toLowerCase() || null),
          contextText: context
            ? (context as HTMLElement).innerText.replace(/\s+/g, ' ').trim().slice(0, 300)
            : null,
        };
      }),
  );
  const revision = `observation-${sequence}`;
  const controls: ObservedControl[] = raw.map((control, ordinal) => ({
    ...control,
    ref: `${revision}:control-${ordinal + 1}`,
    fingerprint: stableHash({
      tag: control.tag,
      role: control.role,
      name: control.name,
      type: control.type,
    }),
  }));
  return {
    revision,
    route,
    title,
    headings,
    visibleText,
    controls,
    stateHash: stableHash({
      route,
      headings,
      visibleText,
      controls: controls.map(({ ref: _ref, index: _index, ...control }) => control),
    }),
  };
}

export function modelObservation(observation: Observation) {
  return {
    revision: observation.revision,
    route: observation.route,
    title: observation.title,
    headings: observation.headings,
    visibleText: observation.visibleText,
    controls: observation.controls.map(
      ({ index: _index, fingerprint: _fingerprint, ...control }) => control,
    ),
  };
}
