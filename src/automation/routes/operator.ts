import { Router } from 'express';
import type { AutomationServices } from '../services.ts';
import { createOperatorHandlers } from '../handlers/operator.ts';

export function createOperatorRoutes(services: AutomationServices) {
  const router = Router();
  const handlers = createOperatorHandlers(services);
  router.get('/status', handlers.getStatus);
  router.get('/runs', handlers.listRuns);
  router.get('/runs/:runId', handlers.getRun);
  router.get('/runs/:runId/evidence', handlers.getEvidence);
  router.get('/capabilities/:artifactId', handlers.getCapability);
  return router;
}
