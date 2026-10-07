import type { RequestHandler } from 'express';
import type { AutomationServices } from '../services.ts';
import { z } from 'zod';
import { requireOperator } from '../authorization.ts';
import {
  getPersistedCapability,
  getPersistedEvidence,
  getPersistedRun,
  listPersistedRuns,
} from '../../discovery/run-history.ts';

export function createOperatorHandlers(services: AutomationServices) {
  const { database, operatorAccessToken } = services;
  const getStatus: RequestHandler = (_request, response) =>
    response.json({
      configured: Boolean(operatorAccessToken),
      persistence: database.readyState === 1 ? 'connected' : 'unavailable',
    });

  const listRuns: RequestHandler = async (request, response, next) => {
    if (!requireOperator(request, response, operatorAccessToken)) return;
    try {
      const parsed = z.coerce
        .number()
        .int()
        .min(1)
        .max(100)
        .default(30)
        .safeParse(request.query.limit);
      if (!parsed.success) return response.status(400).json({ code: 'INVALID_LIMIT' });
      return response.json({ runs: await listPersistedRuns(database, parsed.data) });
    } catch (error) {
      if (error instanceof Error && error.message === 'DATABASE_NOT_CONNECTED')
        return response.status(503).json({ code: 'PERSISTENCE_UNAVAILABLE' });
      return next(error);
    }
  };

  const getRun: RequestHandler = async (request, response, next) => {
    if (!requireOperator(request, response, operatorAccessToken)) return;
    const parsed = z.string().uuid().safeParse(request.params.runId);
    if (!parsed.success) return response.status(400).json({ code: 'INVALID_RUN_ID' });
    try {
      const run = await getPersistedRun(database, parsed.data);
      if (!run) return response.status(404).json({ code: 'RUN_NOT_FOUND' });
      return response.json(run);
    } catch (error) {
      if (error instanceof Error && error.message === 'DATABASE_NOT_CONNECTED')
        return response.status(503).json({ code: 'PERSISTENCE_UNAVAILABLE' });
      return next(error);
    }
  };

  const getEvidence: RequestHandler = async (request, response, next) => {
    if (!requireOperator(request, response, operatorAccessToken)) return;
    const parsed = z.string().uuid().safeParse(request.params.runId);
    if (!parsed.success) return response.status(400).json({ code: 'INVALID_RUN_ID' });
    try {
      const evidence = await getPersistedEvidence(database, parsed.data);
      if (!evidence) return response.status(404).json({ code: 'RUN_NOT_FOUND' });
      return response.json({ evidence });
    } catch (error) {
      if (error instanceof Error && error.message === 'DATABASE_NOT_CONNECTED')
        return response.status(503).json({ code: 'PERSISTENCE_UNAVAILABLE' });
      return next(error);
    }
  };

  const getCapability: RequestHandler = async (request, response, next) => {
    if (!requireOperator(request, response, operatorAccessToken)) return;
    const parsed = z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{1,119}$/)
      .safeParse(request.params.artifactId);
    if (!parsed.success) return response.status(400).json({ code: 'INVALID_ARTIFACT_ID' });
    try {
      const artifact = await getPersistedCapability(database, parsed.data);
      if (!artifact) return response.status(404).json({ code: 'CAPABILITY_NOT_FOUND' });
      return response.json(artifact);
    } catch (error) {
      if (error instanceof Error && error.message === 'DATABASE_NOT_CONNECTED')
        return response.status(503).json({ code: 'PERSISTENCE_UNAVAILABLE' });
      return next(error);
    }
  };
  return { getStatus, listRuns, getRun, getEvidence, getCapability };
}
