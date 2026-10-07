import { Router } from 'express';
import type { AutomationServices } from '../services.ts';
import { createHandoffHandlers } from '../handlers/handoff.ts';

export function createHandoffRoutes(services: AutomationServices) {
  const router = Router({ mergeParams: true });
  const handlers = createHandoffHandlers(services);
  router.post('/claim', handlers.claimControl);
  router.post('/actions', handlers.executeAction);
  router.post('/resume', handlers.resumeRun);
  return router;
}
