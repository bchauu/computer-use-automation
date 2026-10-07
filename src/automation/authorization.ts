import { timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';

export function controlToken(request: Request) {
  const value = request.header('x-control-token');
  return value?.trim() || undefined;
}

function operatorAuthorization(request: Request, configuredToken: string | null) {
  if (!configuredToken) return 'not_configured' as const;
  const provided = request.header('x-operator-token')?.trim();
  if (!provided) return 'denied' as const;
  const actual = Buffer.from(provided);
  const expected = Buffer.from(configuredToken);
  return actual.length === expected.length && timingSafeEqual(actual, expected)
    ? ('accepted' as const)
    : ('denied' as const);
}

export function requireOperator(
  request: Request,
  response: Response,
  configuredToken: string | null,
) {
  const authorization = operatorAuthorization(request, configuredToken);
  if (authorization === 'accepted') return true;
  if (authorization === 'not_configured')
    response.status(503).json({ code: 'OPERATOR_ACCESS_NOT_CONFIGURED' });
  else response.status(401).json({ code: 'OPERATOR_ACCESS_DENIED' });
  return false;
}
