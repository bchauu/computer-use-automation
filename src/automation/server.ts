import type { Express } from 'express';
import type { Connection } from 'mongoose';
import { createAutomationServices } from './services.ts';
import type { AutomationOptions } from './services.ts';
import { createSessionRoutes } from './routes/sessions.ts';
import { createRunRoutes } from './routes/runs.ts';
import { createOperatorRoutes } from './routes/operator.ts';

export function configureAutomation(
  app: Express,
  database: Connection,
  options: AutomationOptions = {},
) {
  const services = createAutomationServices(database, options);
  app.use('/api/sessions', createSessionRoutes(services));
  app.use('/api/runs', createRunRoutes(services));
  app.use('/api/operator', createOperatorRoutes(services));
  const { dispatcher, catalog, replay } = services;
  return { dispatcher, catalog, replay };
}

export { defaultSessionRegistry } from './services.ts';
