import type { RequestHandler } from 'express';
import type { AutomationServices } from '../services.ts';
import { startRunSchema } from '../../contracts/discovery.ts';
import { publicRunSchema } from '../../contracts/run.ts';
import { controlToken } from '../authorization.ts';

export function createRunHandlers(services: AutomationServices) {
  const { sessionRegistry, dispatcher } = services;
  const startRun: RequestHandler = async (request, response) => {
    const parsed = startRunSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ code: 'INVALID_RUN_REQUEST' });
    const session = sessionRegistry.authorize(parsed.data.sessionId, controlToken(request));
    if (!session) return response.status(404).json({ code: 'SESSION_NOT_FOUND' });
    try {
      const run = await dispatcher.start(session, parsed.data.goal);
      return response.status(202).json({ runId: run.runId, status: run.status, mode: run.mode });
    } catch (error) {
      if (error instanceof Error && error.message === 'SESSION_BUSY')
        return response.status(409).json({ code: 'SESSION_BUSY' });
      if (error instanceof Error && error.message === 'VERIFIED_MEMBER_REQUIRED')
        return response.status(409).json({ code: 'VERIFIED_MEMBER_REQUIRED' });
      if (error instanceof Error && error.message === 'MODEL_NOT_CONFIGURED')
        return response.status(503).json({ code: 'MODEL_NOT_CONFIGURED' });
      if (error instanceof Error && error.message === 'UNSUPPORTED_GOAL')
        return response.status(422).json({
          code: 'UNSUPPORTED_GOAL',
          message:
            'For this first slice, request checking or savings transactions for the latest, 7, 14, or 30 days.',
        });
      throw error;
    }
  };

  const getRun: RequestHandler<{ runId: string }> = (request, response) => {
    const run = dispatcher.get(request.params.runId);
    if (!run) return response.status(404).json({ code: 'RUN_NOT_FOUND' });
    const session = sessionRegistry.authorize(run.sessionId, controlToken(request));
    if (!session) return response.status(404).json({ code: 'RUN_NOT_FOUND' });
    return response.json(publicRunSchema.parse(run));
  };

  const cancelRun: RequestHandler<{ runId: string }> = (request, response) => {
    const run = dispatcher.get(request.params.runId);
    if (!run) return response.status(404).json({ code: 'RUN_NOT_FOUND' });
    const session = sessionRegistry.authorize(run.sessionId, controlToken(request));
    if (!session) return response.status(404).json({ code: 'RUN_NOT_FOUND' });
    const result = dispatcher.cancel(run.runId, session);
    if (result === 'not_running') return response.status(409).json({ code: 'RUN_NOT_ACTIVE' });
    if (result !== 'accepted') return response.status(404).json({ code: 'RUN_NOT_FOUND' });
    return response.status(202).json({ runId: run.runId, status: 'cancelling' });
  };
  return { startRun, getRun, cancelRun };
}
