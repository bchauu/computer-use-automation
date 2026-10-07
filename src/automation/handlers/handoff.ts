import type { RequestHandler } from 'express';
import type { AutomationServices } from '../services.ts';
import { handoffEpochSchema, humanActionSchema } from '../../contracts/discovery.ts';
import { controlToken } from '../authorization.ts';

export function createHandoffHandlers(services: AutomationServices) {
  const { sessionRegistry, dispatcher } = services;
  const claimControl: RequestHandler<{ runId: string }> = async (request, response) => {
    const run = dispatcher.get(request.params.runId);
    if (!run) return response.status(404).json({ code: 'RUN_NOT_FOUND' });
    const session = sessionRegistry.authorize(run.sessionId, controlToken(request));
    if (!session) return response.status(404).json({ code: 'RUN_NOT_FOUND' });
    const outcome = await dispatcher.claimHandoff(run.runId, session);
    if (outcome.result === 'not_available')
      return response.status(409).json({ code: 'HANDOFF_NOT_AVAILABLE' });
    if (outcome.result === 'already_claimed')
      return response.status(409).json({ code: 'HANDOFF_ALREADY_CLAIMED' });
    return response.json({ runId: run.runId, owner: 'human', epoch: outcome.epoch });
  };

  const executeAction: RequestHandler<{ runId: string }> = async (request, response) => {
    const parsed = humanActionSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ code: 'INVALID_HUMAN_ACTION' });
    const run = dispatcher.get(request.params.runId);
    if (!run) return response.status(404).json({ code: 'RUN_NOT_FOUND' });
    const session = sessionRegistry.authorize(run.sessionId, controlToken(request));
    if (!session) return response.status(404).json({ code: 'RUN_NOT_FOUND' });
    const { expectedEpoch, ...command } = parsed.data;
    const outcome = await dispatcher.executeHumanAction(run.runId, session, expectedEpoch, command);
    if (outcome === 'stale_epoch')
      return response.status(409).json({ code: 'STALE_OWNERSHIP_EPOCH' });
    if (outcome === 'command_in_flight')
      return response.status(409).json({ code: 'HUMAN_COMMAND_IN_FLIGHT' });
    if (outcome === 'command_denied')
      return response.status(403).json({ code: 'HUMAN_ACTION_DENIED' });
    if (outcome === 'target_invalid')
      return response.status(422).json({ code: 'HUMAN_TARGET_INVALID' });
    if (outcome !== 'accepted') return response.status(409).json({ code: 'HANDOFF_NOT_AVAILABLE' });
    return response.json({ result: 'accepted' });
  };

  const resumeRun: RequestHandler<{ runId: string }> = async (request, response) => {
    const parsed = handoffEpochSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ code: 'INVALID_RESUME_REQUEST' });
    const run = dispatcher.get(request.params.runId);
    if (!run) return response.status(404).json({ code: 'RUN_NOT_FOUND' });
    const session = sessionRegistry.authorize(run.sessionId, controlToken(request));
    if (!session) return response.status(404).json({ code: 'RUN_NOT_FOUND' });
    const outcome = await dispatcher.resumeHandoff(run.runId, session, parsed.data.expectedEpoch);
    if (outcome === 'stale_epoch')
      return response.status(409).json({ code: 'STALE_OWNERSHIP_EPOCH' });
    if (outcome === 'command_in_flight')
      return response.status(409).json({ code: 'HUMAN_COMMAND_IN_FLIGHT' });
    if (outcome === 'checkpoint_failed')
      return response.status(422).json({ code: 'RESUME_CHECKPOINT_FAILED' });
    if (outcome !== 'accepted') return response.status(409).json({ code: 'HANDOFF_NOT_AVAILABLE' });
    return response.json({ runId: run.runId, status: 'running', owner: 'automation' });
  };
  return { claimControl, executeAction, resumeRun };
}
