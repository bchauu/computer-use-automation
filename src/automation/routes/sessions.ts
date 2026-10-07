import { Router } from 'express';
import type { AutomationServices } from '../services.ts';
import { createSessionHandlers } from '../handlers/sessions.ts';

export function createSessionRoutes(services: AutomationServices) {
  const router = Router();
  const handlers = createSessionHandlers(services);
  router.post('/', handlers.createSession);
  router.get('/:sessionId', handlers.getSession);
  return router;
}
