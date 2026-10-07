import type { Connection } from 'mongoose';
import { CapabilityCatalog } from '../discovery/catalog.ts';
import { DiscoveryController } from '../discovery/controller.ts';
import { ExecutionDispatcher } from '../discovery/dispatcher.ts';
import { MockDecisionClient, OpenAIDecisionClient } from '../discovery/model.ts';
import type { DecisionClient } from '../discovery/model.ts';
import { readOnlyDiscoveryPolicy } from '../discovery/policy.ts';
import { ReplayController } from '../discovery/replay.ts';
import { SessionRegistry } from '../discovery/sessions.ts';
import { ensureAutomationIndexes } from '../discovery/storage.ts';

export interface AutomationOptions {
  sessionRegistry?: SessionRegistry;
  decisionClient?: DecisionClient | null;
  catalogDirectory?: string;
  operatorAccessToken?: string | null;
}

const sessions = new SessionRegistry();
const numberEnv = (name: string, fallback: number) => {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};
const apiKey = process.env.OPENAI_API_KEY?.trim();
const model = process.env.OPENAI_MODEL?.trim() || 'gpt-4o-mini';
const modelMode = process.env.DISCOVERY_MODEL_MODE?.trim() || 'openai';
const modelClient =
  modelMode === 'mock'
    ? new MockDecisionClient()
    : apiKey
      ? new OpenAIDecisionClient(apiKey, model, numberEnv('DISCOVERY_MODEL_TIMEOUT_MS', 120_000))
      : null;

export function createAutomationServices(database: Connection, options: AutomationOptions = {}) {
  const initializeStorage = () => {
    void ensureAutomationIndexes(database)
      .then(() =>
        console.info(JSON.stringify({ service: 'automation', event: 'database_indexes_ready' })),
      )
      .catch(() =>
        console.error(JSON.stringify({ service: 'automation', event: 'database_indexes_failed' })),
      );
  };
  if (database.readyState === 1) initializeStorage();
  else database.once('connected', initializeStorage);
  const sessionRegistry = options.sessionRegistry ?? sessions;
  const decisionClient =
    options.decisionClient === undefined ? modelClient : options.decisionClient;
  const operatorAccessToken =
    options.operatorAccessToken === undefined
      ? process.env.OPERATOR_ACCESS_TOKEN?.trim() || null
      : options.operatorAccessToken;
  const catalog = new CapabilityCatalog(database, options.catalogDirectory);
  const discovery = decisionClient
    ? new DiscoveryController(
        database,
        decisionClient,
        {
          maxSteps: numberEnv('DISCOVERY_MAX_STEPS', 40),
          runTimeoutMs: numberEnv('DISCOVERY_RUN_TIMEOUT_MS', 600_000),
          actionTimeoutMs: numberEnv('DISCOVERY_ACTION_TIMEOUT_MS', 30_000),
          modelAttempts: numberEnv('DISCOVERY_MODEL_ATTEMPTS', 3),
          retryBaseMs: numberEnv('DISCOVERY_RETRY_BASE_MS', 1_000),
          repeatedDecisionLimit: numberEnv('DISCOVERY_REPEAT_LIMIT', 3),
          noProgressLimit: numberEnv('DISCOVERY_NO_PROGRESS_LIMIT', 3),
          maxModelCalls: numberEnv('DISCOVERY_MAX_MODEL_CALLS', 50),
          maxTotalTokens: numberEnv('DISCOVERY_MAX_TOTAL_TOKENS', 100_000),
          actionPolicy: readOnlyDiscoveryPolicy,
        },
        catalog,
      )
    : null;
  const replay = new ReplayController(database, catalog);
  const dispatcher = new ExecutionDispatcher(discovery, replay, catalog);

  return {
    database,
    sessionRegistry,
    decisionClient,
    operatorAccessToken,
    dispatcher,
    catalog,
    replay,
  };
}

export type AutomationServices = ReturnType<typeof createAutomationServices>;
export { sessions as defaultSessionRegistry };
