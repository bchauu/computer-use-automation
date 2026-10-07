import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import mongoose from 'mongoose';
import { configureAutomation } from '../src/automation/server.ts';
import { SessionRegistry } from '../src/discovery/sessions.ts';
import { createApp } from '../src/shared/http.ts';

test('operator route modules preserve authorization before validation and persistence access', async () => {
  const database = mongoose.createConnection();
  const app = createApp('automation', database, (instance) => {
    configureAutomation(instance, database, {
      sessionRegistry: new SessionRegistry(),
      decisionClient: null,
      operatorAccessToken: 'synthetic-operator-token',
    });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const headers = { 'x-operator-token': 'synthetic-operator-token' };

  try {
    const status = await fetch(`${origin}/api/operator/status`);
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), { configured: true, persistence: 'unavailable' });

    // Invalid parameters must not disclose anything to an unauthorized caller.
    for (const path of [
      '/api/operator/runs?limit=0',
      '/api/operator/runs/not-a-uuid',
      '/api/operator/runs/not-a-uuid/evidence',
      '/api/operator/capabilities/invalid!',
    ]) {
      for (const requestHeaders of [{}, { 'x-operator-token': 'wrong-token' }]) {
        const response = await fetch(`${origin}${path}`, { headers: requestHeaders });
        assert.equal(response.status, 401);
        assert.deepEqual(await response.json(), { code: 'OPERATOR_ACCESS_DENIED' });
      }
    }

    for (const [path, code] of [
      ['/api/operator/runs?limit=0', 'INVALID_LIMIT'],
      ['/api/operator/runs/not-a-uuid', 'INVALID_RUN_ID'],
      ['/api/operator/runs/not-a-uuid/evidence', 'INVALID_RUN_ID'],
      ['/api/operator/capabilities/invalid!', 'INVALID_ARTIFACT_ID'],
    ]) {
      const response = await fetch(`${origin}${path}`, { headers });
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { code });
    }

    const unavailable = await fetch(`${origin}/api/operator/runs`, { headers });
    assert.equal(unavailable.status, 503);
    assert.deepEqual(await unavailable.json(), { code: 'PERSISTENCE_UNAVAILABLE' });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await database.close();
  }
});
