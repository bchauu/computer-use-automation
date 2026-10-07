import type { RequestHandler } from 'express';
import type { AutomationServices } from '../services.ts';
import { createSessionSchema } from '../../contracts/discovery.ts';
import { controlToken } from '../authorization.ts';

export function createSessionHandlers(services: AutomationServices) {
  const { sessionRegistry, decisionClient } = services;
  const createSession: RequestHandler = async (request, response, next) => {
    try {
      const body = createSessionSchema.parse(request.body);
      const targetUrl =
        body.targetUrl || process.env.BANK_TARGET_URL || 'http://127.0.0.1:5174/#/members';
      const session = await sessionRegistry.create(
        targetUrl,
        process.env.DISCOVERY_HEADLESS === 'true',
      );
      response.status(201).json({
        sessionId: session.sessionId,
        controlToken: session.controlToken,
        owner: session.owner,
        target: new URL(targetUrl).origin,
        modelConfigured: Boolean(decisionClient),
        decisionProvider: decisionClient?.model ?? null,
      });
    } catch (error) {
      next(error);
    }
  };

  const getSession: RequestHandler<{ sessionId: string }> = (request, response) => {
    const session = sessionRegistry.authorize(request.params.sessionId, controlToken(request));
    if (!session) return response.status(404).json({ code: 'SESSION_NOT_FOUND' });
    return response.json({
      sessionId: session.sessionId,
      owner: session.owner,
      epoch: session.epoch,
      activeRunId: session.activeRunId,
    });
  };
  return { createSession, getSession };
}
