import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import mongoose from 'mongoose';
import { chromium } from 'playwright';
import { capabilityArtifactSchema } from '../src/contracts/capability.ts';
import { publicRunSchema } from '../src/contracts/run.ts';
import { CapabilityCatalog } from '../src/discovery/catalog.ts';
import { ExecutionDispatcher } from '../src/discovery/dispatcher.ts';
import { ReplayController } from '../src/discovery/replay.ts';
import type { LiveSession } from '../src/discovery/sessions.ts';

const runId = '11111111-1111-4111-8111-111111111111';

const artifact = capabilityArtifactSchema.parse({
  schemaVersion: 1, artifactId: 'view-transaction-history', artifactVersion: 1, status: 'validated',
  capability: { name: 'view_transaction_history', description: 'Open transaction history for the verified member.', effect: 'read_only' },
  inputs: {
    accountType: { type: 'enum', required: true, values: ['checking', 'savings'], uiValues: { checking: 'Checking', savings: 'Savings' } },
    period: {
      type: 'enum', required: true, values: ['latest', '7_days', '14_days', '30_days'],
      uiValues: { latest: 'Latest posted transaction', '7_days': 'Last 7 days', '14_days': 'Last 14 days', '30_days': 'Last 30 days' },
    },
  },
  preconditions: [{ kind: 'verified_member', expected: true }, { kind: 'verified_member_count', expected: 1 }],
  steps: [
    {
      id: 'open_transactions', action: { kind: 'click' },
      target: { strategy: 'role', role: 'link', accessibleName: { value: 'Transactions', match: 'exact' }, expectedCount: 1 },
      timeoutMs: 5000, retry: { maxAttempts: 1, allowedWhen: [] },
      postconditions: [{ kind: 'heading_visible', text: 'Transaction inquiry' }],
      checkpoint: { routeTemplate: '/#/transactions', requiredHeadings: ['Transaction inquiry'], selectedValue: null }, sourceStep: 1,
    },
    {
      id: 'open_history', action: { kind: 'click' },
      target: {
        strategy: 'scoped_role', scope: { role: 'row', containsInput: 'accountType' }, role: 'link',
        accessibleName: { value: 'View history', match: 'exact' }, expectedCount: 1,
      },
      timeoutMs: 5000, retry: { maxAttempts: 1, allowedWhen: [] },
      postconditions: [{ kind: 'heading_visible', text: 'Posted transaction history' }],
      checkpoint: {
        routeTemplate: '/#/members/{verifiedMemberId}/accounts/{selectedAccountId}/history',
        requiredHeadings: ['Posted transaction history'], selectedValue: null,
      }, sourceStep: 2,
    },
    {
      id: 'select_period', action: { kind: 'select', valueFromInput: 'period' },
      target: { strategy: 'label', label: 'History period', expectedCount: 1 },
      timeoutMs: 5000, retry: { maxAttempts: 2, allowedWhen: ['value_not_applied'] }, postconditions: [],
      checkpoint: {
        routeTemplate: '/#/members/{verifiedMemberId}/accounts/{selectedAccountId}/history', requiredHeadings: [],
        selectedValue: { label: 'History period', valueFromInput: 'period' },
      }, sourceStep: 3,
    },
  ],
  outputs: {
    account: { kind: 'account_context', fields: ['accountType', 'accountLastFour'] },
    transactions: { kind: 'table', columns: ['postedDate', 'description', 'reference', 'status', 'debit', 'credit'] },
  },
  completion: { all: [
    { kind: 'verified_member_preserved' }, { kind: 'account_type_matches_input', input: 'accountType' },
    { kind: 'history_period_matches_input', input: 'period' }, { kind: 'transaction_history_visible' },
  ] },
  limits: { maxSteps: 8, overallTimeoutMs: 30000 },
  source: {
    kind: 'discovery_run', runId, testedModel: 'gpt-4o-mini', compiledAt: '2026-09-29T12:00:00.000Z',
    evidenceSteps: [1, 2, 3], discoveryInputs: { accountType: 'checking', period: '14_days' },
  },
});

const html = `<!doctype html><html><body><main id="app"></main><script>
const member = '<div class="member-strip"><strong>Alex Morgan</strong><span>Member #12345</span></div>';
function render() {
  const route = location.hash.slice(1);
  if (route === '/transactions') {
    app.innerHTML = member + '<h1>Transaction inquiry</h1><table><tbody><tr><td>Everyday Checking</td><td><a href="#/members/12345/accounts/a101/history">View history</a></td></tr></tbody></table>';
  } else if (route.includes('/history')) {
    app.innerHTML = member + '<p class="eyebrow">Account services / Checking</p><h1>Everyday Checking •••• 4821</h1><h2>Posted transaction history</h2><label for="period">History period</label><select id="period"><option value="30">Last 30 days</option><option value="14">Last 14 days</option><option value="7">Last 7 days</option><option value="latest">Latest posted transaction</option></select><table><tbody id="history-rows"><tr><td>Sep 28, 2026</td><td><strong>Payroll</strong><small>TX-100001</small></td><td>Posted</td><td>—</td><td>$2,450.00</td></tr></tbody></table><span id="page-status" role="status">Showing 1–1 of 2 transactions</span><button id="next" type="button">Next</button>';
    document.getElementById('next').addEventListener('click', () => { document.getElementById('history-rows').innerHTML = '<tr><td>Sep 27, 2026</td><td><strong>Market</strong><small>TX-100002</small></td><td>Posted</td><td>$84.32</td><td>—</td></tr>'; document.getElementById('page-status').textContent = 'Showing 2–2 of 2 transactions'; document.getElementById('next').disabled = true; });
  } else {
    app.innerHTML = member + '<h1>Member overview</h1><a href="#/transactions">Transactions</a>';
  }
}
addEventListener('hashchange', render); render();
</script></body></html>`;

async function runThroughDispatcher(status: 'draft' | 'validated', registeredArtifact = artifact) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.route('http://app.local/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: html }));
  const page = await context.newPage();
  await page.goto('http://app.local/#/members/12345');
  const database = mongoose.createConnection();
  const catalogDirectory = await mkdtemp(path.join(tmpdir(), 'capability-catalog-'));
  const catalog = new CapabilityCatalog(database, catalogDirectory);
  await catalog.register(capabilityArtifactSchema.parse({ ...registeredArtifact, status }));
  const replay = new ReplayController(database, catalog);
  const dispatcher = new ExecutionDispatcher(null, replay, catalog);
  const session: LiveSession = {
    sessionId: '22222222-2222-4222-8222-222222222222', controlToken: 'test-token', browser, context, page,
    owner: 'human', epoch: 1, activeRunId: null, createdAt: new Date().toISOString(), allowedOrigin: 'http://app.local',
  };
  let runId: string | null = null;
  try {
    const run = await dispatcher.start(session, 'Show this member’s checking transactions for the last 7 days.');
    runId = run.runId;
    const deadline = Date.now() + 10000;
    while (['created', 'running'].includes(run.status) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    return publicRunSchema.parse(run);
  } finally {
    await browser.close();
    await database.close();
    await rm(catalogDirectory, { recursive: true, force: true });
    if (runId) await rm(path.resolve('.local', 'runs', runId), { recursive: true, force: true });
  }
}

test('validated artifact is selected and replays through the dispatcher without a model', async () => {
  const run = await runThroughDispatcher('validated');
  assert.equal(run.status, 'succeeded', JSON.stringify({ result: run.result, events: run.events }, null, 2));
  assert.equal(run.mode, 'replay');
  assert.equal(run.result?.code, 'REPLAY_SUCCEEDED');
  assert.deepEqual(run.result?.output?.account, { accountType: 'checking', accountLastFour: '4821' });
  assert.equal(run.result?.output?.transactions[0]?.reference, 'TX-100001');
  assert.equal(run.result?.output?.transactions[1]?.reference, 'TX-100002');
  assert.equal(run.events.some(event => event.code === 'OUTPUT_PAGE_ADVANCED'), true);
  assert.equal(run.artifact?.path, null);
  assert.equal(run.events.some(event => event.type === 'model_request'), false);
});

test('bounded pagination fails explicitly instead of returning a partial output', async () => {
  const onePageArtifact = capabilityArtifactSchema.parse({
    ...artifact,
    outputs: {
      ...artifact.outputs,
      transactions: {
        ...artifact.outputs.transactions,
        pagination: { ...artifact.outputs.transactions.pagination, maxPages: 1 },
      },
    },
  });
  const run = await runThroughDispatcher('validated', onePageArtifact);
  assert.equal(run.status, 'failed');
  assert.equal(run.result?.code, 'OUTPUT_PAGE_LIMIT_EXCEEDED');
  assert.equal(run.result?.diagnostic?.phase, 'completion');
  assert.equal(run.result?.output, null);
});

test('draft artifact uses validation replay and promotes after a different input succeeds', async () => {
  const run = await runThroughDispatcher('draft');
  assert.equal(run.status, 'succeeded', JSON.stringify({ result: run.result, events: run.events }, null, 2));
  assert.equal(run.mode, 'validation_replay');
  assert.equal(run.artifact?.status, 'validated');
  assert.equal(run.events.some(event => event.code === 'ARTIFACT_VALIDATED'), true);
  assert.equal(run.events.some(event => event.type === 'model_request'), false);
});

test('session expiry transfers the same live page to a human and resumes only after checkpoint verification', async () => {
  const expiringHtml = `<!doctype html><html><body><main id="app"></main><script>
  let authenticated = false;
  const member = '<div class="member-strip"><strong>Alex Morgan</strong><span>Member #12345</span></div>';
  function render() {
    const route = location.hash.slice(1);
    if (route === '/transactions') {
      app.innerHTML = member + '<h1>Transaction inquiry</h1><table><tbody><tr><td>Everyday Checking</td><td><a href="#/members/12345/accounts/a101/history">View history</a></td></tr></tbody></table>';
    } else if (route.includes('/history') && !authenticated) {
      app.innerHTML = '<h1>Employee session expired</h1><form id="reauth"><label for="pin">Employee PIN</label><input id="pin" type="password"><button>Re-authenticate</button></form>';
      reauth.addEventListener('submit', event => { event.preventDefault(); if (pin.value === '2468') { authenticated = true; render(); } });
    } else if (route.includes('/history')) {
      app.innerHTML = member + '<p class="eyebrow">Account services / Checking</p><h1>Everyday Checking •••• 4821</h1><h2>Posted transaction history</h2><label for="period">History period</label><select id="period"><option value="30">Last 30 days</option><option value="14">Last 14 days</option><option value="7">Last 7 days</option><option value="latest">Latest posted transaction</option></select><table><tbody><tr><td>Sep 28, 2026</td><td><strong>Payroll</strong><small>TX-100001</small></td><td>Posted</td><td>—</td><td>$2,450.00</td></tr></tbody></table>';
    } else {
      app.innerHTML = member + '<h1>Member overview</h1><a href="#/transactions">Transactions</a>';
    }
  }
  addEventListener('hashchange', render); render();
  </script></body></html>`;
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.route('http://app.local/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: expiringHtml }));
  const page = await context.newPage();
  await page.goto('http://app.local/#/members/12345');
  const database = mongoose.createConnection();
  const catalogDirectory = await mkdtemp(path.join(tmpdir(), 'capability-catalog-'));
  const catalog = new CapabilityCatalog(database, catalogDirectory);
  await catalog.register(artifact);
  const replay = new ReplayController(database, catalog);
  const dispatcher = new ExecutionDispatcher(null, replay, catalog);
  const session: LiveSession = {
    sessionId: '33333333-3333-4333-8333-333333333333', controlToken: 'test-token', browser, context, page,
    owner: 'human', epoch: 1, activeRunId: null, createdAt: new Date().toISOString(), allowedOrigin: 'http://app.local',
  };
  let activeRunId: string | null = null;
  try {
    const originalPage = session.page;
    const originalContext = session.context;
    const run = await dispatcher.start(session, 'Show this member’s checking transactions for the last 7 days.');
    activeRunId = run.runId;
    const handoffDeadline = Date.now() + 10_000;
    while (run.status !== 'awaiting_human' && Date.now() < handoffDeadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(run.status, 'awaiting_human');
    assert.equal(run.result?.code, 'REAUTHENTICATION_REQUIRED');
    assert.equal(session.page, originalPage);
    assert.equal(session.context, originalContext);

    const automationEpoch = session.epoch;
    const claim = await dispatcher.claimHandoff(run.runId, session);
    assert.equal(claim.result, 'accepted');
    if (claim.result !== 'accepted') throw new Error('HANDOFF_NOT_CLAIMED');
    assert.equal(session.owner, 'human');
    assert.equal(await dispatcher.executeHumanAction(run.runId, session, automationEpoch, { kind: 'fill', label: 'Employee PIN', value: '2468' }), 'stale_epoch');
    assert.equal(await dispatcher.resumeHandoff(run.runId, session, claim.epoch), 'checkpoint_failed');
    assert.equal(session.owner, 'human');
    assert.equal(await dispatcher.executeHumanAction(run.runId, session, claim.epoch, { kind: 'fill', label: 'Employee PIN', value: '2468' }), 'accepted');
    assert.equal(await dispatcher.executeHumanAction(run.runId, session, claim.epoch, { kind: 'click', name: 'Re-authenticate' }), 'accepted');
    assert.equal(await dispatcher.resumeHandoff(run.runId, session, claim.epoch), 'accepted');

    const completionDeadline = Date.now() + 10_000;
    while (['created', 'running', 'awaiting_human'].includes(run.status) && Date.now() < completionDeadline) await new Promise(resolve => setTimeout(resolve, 10));
    const result = publicRunSchema.parse(run);
    assert.equal(result.status, 'succeeded', JSON.stringify(result.result));
    assert.equal(result.result?.code, 'REPLAY_SUCCEEDED');
    assert.equal(result.events.some(event => event.code === 'HUMAN_CONTROL_CLAIMED'), true);
    assert.equal(result.events.some(event => event.code === 'RESUME_CHECKPOINT_REJECTED'), true);
    assert.equal(result.events.some(event => event.code === 'AUTOMATION_CONTROL_RESUMED'), true);
    assert.equal(result.events.some(event => event.type === 'model_request'), false);
    assert.equal(JSON.stringify(result).includes('2468'), false);
  } finally {
    await browser.close();
    await database.close();
    await rm(catalogDirectory, { recursive: true, force: true });
    if (activeRunId) await rm(path.resolve('.local', 'runs', activeRunId), { recursive: true, force: true });
  }
});

type FaultScenario = 'slow' | 'notice' | 'permission' | 'app_error' | 'unknown_dialog' | 'ambiguous' | 'forbidden' | 'account_missing';
function faultHtml(scenario: FaultScenario) {
  const initialLinks = scenario === 'ambiguous'
    ? '<a href="#/transactions">Transactions</a><a href="#/transactions">Transactions</a>'
    : `<a href="${scenario === 'forbidden' ? '#/transfer' : '#/transactions'}">Transactions</a>`;
  return `<!doctype html><html><body><main id="app"></main><script>
  window.__actionClicks = 0;
  const scenario = '${scenario}';
  const member = '<div class="member-strip"><strong>Alex Morgan</strong><span>Member #12345</span></div>';
  const inquiry = () => member + '<h1>Transaction inquiry</h1>' + (scenario === 'notice' ? '<div role="dialog"><h2>Scheduled maintenance notice</h2><button onclick="this.parentElement.remove()">Dismiss notice</button></div>' : '') + '<table><tbody><tr><td>Everyday Checking</td><td><a href="#/members/12345/accounts/a101/history">View history</a></td></tr></tbody></table>';
  function render() {
    const route = location.hash.slice(1);
    if (route === '/transactions') {
      if (scenario === 'permission') app.innerHTML = '<h1>Permission denied</h1>';
      else if (scenario === 'app_error') app.innerHTML = '<h1>Application unavailable</h1>';
      else if (scenario === 'unknown_dialog') app.innerHTML = '<div role="dialog">Unexpected security message<button onclick="app.innerHTML=inquiry()">Proceed anyway</button></div>';
      else if (scenario === 'slow') { app.innerHTML = '<div class="runtime-loading" role="progressbar">Loading</div>'; setTimeout(() => { app.innerHTML = inquiry(); }, 350); }
      else app.innerHTML = inquiry();
    } else if (route.includes('/history')) {
      app.innerHTML = member + '<p class="eyebrow">Account services / Checking</p><h1>Everyday Checking •••• 4821</h1><h2>Posted transaction history</h2><label for="period">History period</label><select id="period"><option value="30">Last 30 days</option><option value="14">Last 14 days</option><option value="7">Last 7 days</option><option value="latest">Latest posted transaction</option></select><table><tbody><tr><td>Sep 28, 2026</td><td><strong>Payroll</strong><small>TX-100001</small></td><td>Posted</td><td>—</td><td>$2,450.00</td></tr></tbody></table>';
    } else if (route === '/transfer') app.innerHTML = '<h1>Transfer funds</h1><button>Submit transfer</button>';
    else app.innerHTML = member + '<h1>Member overview</h1>${initialLinks}';
  }
  addEventListener('click', () => window.__actionClicks++); addEventListener('hashchange', render); render();
  </script></body></html>`;
}

async function runFaultScenario(scenario: FaultScenario, goal = 'Show this member’s checking transactions for the last 7 days.') {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.route('http://app.local/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: faultHtml(scenario) }));
  const page = await context.newPage();
  await page.goto('http://app.local/#/members/12345');
  const database = mongoose.createConnection();
  const catalogDirectory = await mkdtemp(path.join(tmpdir(), 'capability-catalog-'));
  const catalog = new CapabilityCatalog(database, catalogDirectory);
  await catalog.register(artifact);
  const dispatcher = new ExecutionDispatcher(null, new ReplayController(database, catalog), catalog);
  const session: LiveSession = {
    sessionId: crypto.randomUUID(), controlToken: 'test-token', browser, context, page,
    owner: 'human', epoch: 1, activeRunId: null, createdAt: new Date().toISOString(), allowedOrigin: 'http://app.local',
  };
  let activeRunId: string | null = null;
  try {
    const run = await dispatcher.start(session, goal);
    activeRunId = run.runId;
    const deadline = Date.now() + 12_000;
    while (['created', 'running'].includes(run.status) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    const clicks = await page.evaluate(() => (window as unknown as { __actionClicks: number }).__actionClicks).catch(() => -1);
    return { run: publicRunSchema.parse(run), clicks };
  } finally {
    await browser.close(); await database.close(); await rm(catalogDirectory, { recursive: true, force: true });
    if (activeRunId) await rm(path.resolve('.local', 'runs', activeRunId), { recursive: true, force: true });
  }
}

test('runtime matrix distinguishes recovery, intervention, business outcomes, drift, and policy denial', async () => {
  const slow = await runFaultScenario('slow');
  assert.equal(slow.run.status, 'succeeded');
  assert.equal(slow.clicks, 2, 'navigation and history link should each execute once');
  const notice = await runFaultScenario('notice');
  assert.equal(notice.run.status, 'succeeded');
  assert.equal(notice.run.events.some(event => event.code === 'AUTHORED_RECOVERY_EXECUTED'), true);
  const permission = await runFaultScenario('permission');
  assert.equal(permission.run.status, 'failed');
  assert.equal(permission.run.result?.category, 'intervention');
  assert.equal(permission.run.result?.code, 'PERMISSION_DENIED');
  const appError = await runFaultScenario('app_error');
  assert.equal(appError.run.result?.code, 'APPLICATION_ERROR');
  assert.equal(appError.run.result?.diagnostic?.phase, 'checkpoint');
  const ambiguous = await runFaultScenario('ambiguous');
  assert.equal(ambiguous.run.result?.code, 'TARGET_AMBIGUOUS');
  assert.equal(ambiguous.clicks, 0);
  const forbidden = await runFaultScenario('forbidden');
  assert.equal(forbidden.run.result?.code, 'DESTINATION_DENIED');
  assert.equal(forbidden.clicks, 0);
  const missing = await runFaultScenario('account_missing', 'Show this member’s savings transactions for the last 7 days.');
  assert.equal(missing.run.status, 'succeeded');
  assert.equal(missing.run.result?.category, 'business_outcome');
  assert.equal(missing.run.result?.code, 'ACCOUNT_NOT_FOUND');
});

test('unknown dialog pauses for an explicit human decision and resumes on the same session', async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.route('http://app.local/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: faultHtml('unknown_dialog') }));
  const page = await context.newPage();
  await page.goto('http://app.local/#/members/12345');
  const database = mongoose.createConnection();
  const catalogDirectory = await mkdtemp(path.join(tmpdir(), 'capability-catalog-'));
  const catalog = new CapabilityCatalog(database, catalogDirectory);
  await catalog.register(artifact);
  const dispatcher = new ExecutionDispatcher(null, new ReplayController(database, catalog), catalog);
  const session: LiveSession = {
    sessionId: crypto.randomUUID(), controlToken: 'test-token', browser, context, page,
    owner: 'human', epoch: 1, activeRunId: null, createdAt: new Date().toISOString(), allowedOrigin: 'http://app.local',
  };
  let activeRunId: string | null = null;
  try {
    const originalPage = session.page;
    const originalContext = session.context;
    const run = await dispatcher.start(session, 'Show this member’s checking transactions for the last 7 days.');
    activeRunId = run.runId;
    const handoffDeadline = Date.now() + 10_000;
    while (run.status !== 'awaiting_human' && Date.now() < handoffDeadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(run.result?.code, 'HUMAN_DECISION_REQUIRED');
    assert.equal(session.page, originalPage);
    assert.equal(session.context, originalContext);
    const automationEpoch = session.epoch;
    const claim = await dispatcher.claimHandoff(run.runId, session);
    assert.equal(claim.result, 'accepted');
    if (claim.result !== 'accepted') throw new Error('HANDOFF_NOT_CLAIMED');
    assert.equal(await dispatcher.executeHumanAction(run.runId, session, automationEpoch, { kind: 'click', name: 'Proceed anyway' }), 'stale_epoch');
    assert.equal(await dispatcher.executeHumanAction(run.runId, session, claim.epoch, { kind: 'click', name: 'Re-authenticate' }), 'command_denied');
    assert.equal(await dispatcher.resumeHandoff(run.runId, session, claim.epoch), 'checkpoint_failed');
    assert.equal(await dispatcher.executeHumanAction(run.runId, session, claim.epoch, { kind: 'click', name: 'Proceed anyway' }), 'accepted');
    assert.equal(await dispatcher.resumeHandoff(run.runId, session, claim.epoch), 'accepted');
    const completionDeadline = Date.now() + 10_000;
    while (['created', 'running', 'awaiting_human'].includes(run.status) && Date.now() < completionDeadline) await new Promise(resolve => setTimeout(resolve, 10));
    const result = publicRunSchema.parse(run);
    assert.equal(result.status, 'succeeded', JSON.stringify(result.result));
    assert.equal(result.events.some(event => event.code === 'HUMAN_DECISION_REQUIRED'), true);
    assert.equal(result.events.some(event => event.targetRef === 'button:Proceed anyway'), true);
    assert.equal(result.events.some(event => event.code === 'AUTOMATION_CONTROL_RESUMED'), true);
    assert.equal(result.events.some(event => event.type === 'model_request'), false);
  } finally {
    await browser.close(); await database.close(); await rm(catalogDirectory, { recursive: true, force: true });
    if (activeRunId) await rm(path.resolve('.local', 'runs', activeRunId), { recursive: true, force: true });
  }
});
