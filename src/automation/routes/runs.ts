import { Router } from 'express';
import type { AutomationServices } from '../services.ts';
import { createRunHandlers } from '../handlers/runs.ts';
import { createHandoffRoutes } from './handoff.ts';

export function createRunRoutes(services: AutomationServices) {
  const router = Router();
  const handlers = createRunHandlers(services);
  router.post('/', handlers.startRun);
  router.get('/:runId', handlers.getRun);
  router.post('/:runId/cancel', handlers.cancelRun);
  router.use('/:runId/handoff', createHandoffRoutes(services));
  return router;
}
