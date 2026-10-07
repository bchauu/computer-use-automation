import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import mongoose from 'mongoose';
import { chromium } from 'playwright';
import type { Page } from 'playwright';
import { newId } from '../src/contracts/discovery.ts';
import type { ModelAction } from '../src/contracts/discovery.ts';
import { DiscoveryController } from '../src/discovery/controller.ts';
import { CapabilityCatalog } from '../src/discovery/catalog.ts';
import { executeAction } from '../src/discovery/executor.ts';
import type { DecisionClient } from '../src/discovery/model.ts';
import { observe } from '../src/discovery/observer.ts';
import { evaluateKnownNoticePolicy, readOnlyDiscoveryPolicy } from '../src/discovery/policy.ts';
import type { LiveSession } from '../src/discovery/sessions.ts';

const origin = 'http://app.local';
const entry = `${origin}/#/members/12345`;

async function clickObserved(page: Page, name: string, mutate?: () => Promise<void>) {
  const observation = await observe(page, 'policy-test');
  const target = observation.controls.find((control) => control.name === name);
  assert.ok(target, `Fixture target ${name} must be visible`);
  await mutate?.();
  const action: ModelAction = {
    observationRevision: observation.revision,
    kind: 'click',
    targetRef: target.ref,
    value: null,
    direction: null,
    purpose: 'Injected safety regression',
    completionEvidence: [],
  };
  return executeAction(page, action, observation, 1000, origin);
}

test('discovery blocks innocent labels with forbidden effects before dispatch', async (t) => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  let outsideRequests = 0;
  await page.route('**/*', (route) => {
    if (new URL(route.request().url()).origin !== origin) outsideRequests += 1;
    return route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' });
  });
  try {
    for (const fixture of [
      {
        name: 'ancestor form',
        html: '<form><button type="submit">Continue</button></form>',
        target: 'Continue',
        code: 'TARGET_EFFECT_DENIED',
      },
      {
        name: 'associated form outside ancestors',
        html: '<form id="write"></form><button form="write" type="submit">Continue</button>',
        target: 'Continue',
        code: 'TARGET_EFFECT_DENIED',
      },
      {
        name: 'external link',
        html: '<a href="https://outside.invalid/">Details</a>',
        target: 'Details',
        code: 'DESTINATION_DENIED',
      },
      {
        name: 'same-origin forbidden route',
        html: '<a href="#/payments">Details</a>',
        target: 'Details',
        code: 'DESTINATION_DENIED',
      },
      {
        name: 'unknown button effect',
        html: '<button type="button">Continue</button>',
        target: 'Continue',
        code: 'TARGET_EFFECT_DENIED',
      },
      {
        name: 'download link',
        html: '<a href="#/transactions" download>Details</a>',
        target: 'Details',
        code: 'TARGET_EFFECT_DENIED',
      },
      {
        name: 'new browser surface',
        html: '<a href="#/transactions" target="_blank">Details</a>',
        target: 'Details',
        code: 'TARGET_EFFECT_DENIED',
      },
    ]) {
      await t.test(fixture.name, async () => {
        await page.goto(entry);
        await page.setContent(fixture.html);
        await page.evaluate(() => {
          (window as unknown as { effects: number }).effects = 0;
          document.addEventListener('click', () => {
            (window as unknown as { effects: number }).effects += 1;
          });
          document.addEventListener('submit', (event) => {
            event.preventDefault();
            (window as unknown as { effects: number }).effects += 1;
          });
        });
        assert.equal((await clickObserved(page, fixture.target)).code, fixture.code);
        assert.equal(
          await page.evaluate(() => (window as unknown as { effects: number }).effects),
          0,
        );
        assert.equal(page.url(), entry);
        assert.equal(outsideRequests, 0);
      });
    }
    await t.test('destination changed after observation', async () => {
      await page.goto(entry);
      await page.setContent('<a href="#/transactions">Details</a>');
      const result = await clickObserved(page, 'Details', async () => {
        await page
          .locator('a')
          .evaluate((element) => element.setAttribute('href', 'https://outside.invalid/'));
      });
      assert.equal(result.code, 'DESTINATION_DENIED');
      assert.equal(page.url(), entry);
      assert.equal(outsideRequests, 0);
    });
    await t.test('allowed navigation executes', async () => {
      await page.goto(entry);
      await page.setContent('<a href="#/transactions">Details</a>');
      assert.equal((await clickObserved(page, 'Details')).ok, true);
      assert.equal(page.url(), `${origin}/#/transactions`);
    });
    await t.test('hidden controls do not shift the visible target index', async () => {
      await page.goto(entry);
      await page.setContent(
        '<button hidden>Hidden</button><input type="hidden"><a href="#/transactions">Details</a>',
      );
      assert.equal((await clickObserved(page, 'Details')).code, 'ACTION_EXECUTED');
      assert.equal(page.url(), `${origin}/#/transactions`);
    });
    await t.test('changed DOM ordering still stops as target drift', async () => {
      await page.goto(entry);
      await page.setContent('<a href="#/transactions">Details</a>');
      const result = await clickObserved(page, 'Details', async () => {
        await page.evaluate(() => {
          const button = document.createElement('button');
          button.textContent = 'Other';
          document.body.prepend(button);
        });
      });
      assert.equal(result.code, 'TARGET_DRIFTED');
      assert.equal(page.url(), entry);
    });
  } finally {
    await browser.close();
  }
});

test('known-notice recovery requires its declared dialog and a non-form button', async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.route('**/*', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<body></body>' }),
  );
  try {
    await page.goto(entry);
    for (const fixture of [
      {
        html: '<div role="dialog"><h2>Scheduled maintenance notice</h2><button>Dismiss notice</button></div>',
        ok: true,
      },
      { html: '<button>Dismiss notice</button>', ok: false },
      {
        html: '<form id="write"></form><div role="dialog"><h2>Scheduled maintenance notice</h2><button form="write">Dismiss notice</button></div>',
        ok: false,
      },
    ]) {
      await page.setContent(fixture.html);
      assert.equal(
        (
          await evaluateKnownNoticePolicy(
            page,
            page.getByRole('button', { name: 'Dismiss notice', exact: true }),
            origin,
          )
        ).ok,
        fixture.ok,
      );
    }
  } finally {
    await browser.close();
  }
});

test('injected model choices reach the discovery execution gate and record non-execution', async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route('**/*', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<body></body>' }),
  );
  const database = mongoose.createConnection();
  const directory = await mkdtemp(path.join(tmpdir(), 'discovery-policy-'));
  const runs: string[] = [];
  let modelDelayMs = 0;
  let modelCalls = 0;
  const model: DecisionClient = {
    model: 'injected-policy-test',
    async decide({ observation }) {
      modelCalls += 1;
      if (modelDelayMs) await new Promise((resolve) => setTimeout(resolve, modelDelayMs));
      return {
        action: {
          observationRevision: observation.revision,
          kind: 'click',
          targetRef: observation.controls[0]!.ref,
          value: null,
          direction: null,
          purpose: 'Injected forbidden target choice',
          completionEvidence: [],
        },
        requestId: null,
        inputTokens: null,
        outputTokens: null,
        latencyMs: 0,
      };
    },
  };
  try {
    for (const fixture of [
      { html: '<form><button>Continue</button></form>', code: 'TARGET_EFFECT_DENIED' },
      { html: '<a href="https://outside.invalid/">Details</a>', code: 'DESTINATION_DENIED' },
      {
        html: '<form id="write"></form><div role="dialog"><h2>Scheduled maintenance notice</h2><button form="write">Dismiss notice</button></div>',
        code: 'RECOVERY_TARGET_INVALID',
      },
      { html: '<a href="#/transactions">Details</a>', code: 'RUN_TIMEOUT' },
    ]) {
      modelDelayMs = fixture.code === 'RUN_TIMEOUT' ? 1200 : 0;
      modelCalls = 0;
      await page.goto(entry);
      await page.setContent(fixture.html);
      await page.evaluate(() => {
        (window as unknown as { clicks: number }).clicks = 0;
        document.addEventListener('click', () => {
          (window as unknown as { clicks: number }).clicks += 1;
        });
      });
      const session: LiveSession = {
        sessionId: newId(),
        controlToken: 'test',
        browser,
        context,
        page,
        owner: 'human',
        epoch: 1,
        activeRunId: null,
        createdAt: new Date().toISOString(),
        allowedOrigin: origin,
      };
      const controller = new DiscoveryController(
        database,
        model,
        {
          maxSteps: 1,
          runTimeoutMs: fixture.code === 'RUN_TIMEOUT' ? 1000 : 10000,
          actionTimeoutMs: 1000,
          modelAttempts: 1,
          retryBaseMs: 1,
          repeatedDecisionLimit: 2,
          noProgressLimit: 2,
          maxModelCalls: 1,
          maxTotalTokens: 100,
          actionPolicy: readOnlyDiscoveryPolicy,
        },
        new CapabilityCatalog(database, directory),
      );
      const run = controller.start(session, 'Show checking transactions for the last 7 days', {
        memberId: '12345',
        memberName: 'Alex Morgan',
        accountType: 'Checking',
        period: '7',
        view: 'transaction_history',
      });
      runs.push(run.runId);
      const until = Date.now() + 10000;
      while (session.activeRunId && Date.now() < until)
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(session.activeRunId, null);
      assert.equal(run.status, 'failed');
      assert.ok(run.events.some((event) => event.code === fixture.code));
      assert.equal(
        run.events.some(
          (event) =>
            event.code === 'ACTION_EXECUTED' || event.code === 'AUTHORED_RECOVERY_EXECUTED',
        ),
        false,
      );
      assert.equal(await page.evaluate(() => (window as unknown as { clicks: number }).clicks), 0);
      assert.equal(page.url(), entry);
      assert.equal(run.artifact, null);
      if (fixture.code === 'RUN_TIMEOUT') {
        assert.equal(modelCalls, 1);
        assert.ok(run.events.some((event) => event.code === 'MODEL_RESPONSE_AFTER_DEADLINE'));
      }
      if (!['RECOVERY_TARGET_INVALID', 'RUN_TIMEOUT'].includes(fixture.code)) {
        const evidence = JSON.parse(
          await readFile(path.resolve('.local/runs', run.runId, 'action-evidence.jsonl'), 'utf8'),
        );
        assert.equal(evidence.execution.status, 'not_executed');
        assert.equal(evidence.execution.code, fixture.code);
      }
    }
  } finally {
    await browser.close();
    await database.close();
    await rm(directory, { recursive: true, force: true });
    for (const run of runs)
      await rm(path.resolve('.local/runs', run), { recursive: true, force: true });
  }
});
