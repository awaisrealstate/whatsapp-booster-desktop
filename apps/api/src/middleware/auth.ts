import type { MiddlewareHandler } from 'hono';
import { createDb, resolveSessionContext, TenantAccessError, type OrgContext } from '@wacrm/db';
import type { WorkerBindings } from '../env.ts';

export interface AuthVariables {
  requestId: string;
  orgContext?: OrgContext;
}

function extractBearerToken(authHeader: string | undefined): string {
  if (!authHeader) return '';
  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  return match?.[1]?.trim() ?? '';
}

/**
 * Enforces authenticated session + active organization membership on protected routes.
 * Never accepts demo/unauthenticated bypasses.
 */
export function requireOrgSession(): MiddlewareHandler<{
  Bindings: WorkerBindings;
  Variables: AuthVariables;
}> {
  return async (c, next) => {
    if (!c.env.DB) {
      throw new TenantAccessError(401, 'DB_UNCONFIGURED', 'Database binding is not configured.');
    }

    const token = extractBearerToken(c.req.header('authorization'));
    const requestedOrgId = c.req.header('x-organization-id');
    const db = createDb(c.env.DB);
    const orgContext = await resolveSessionContext(db, token, requestedOrgId);

    c.set('orgContext', orgContext);
    await next();
  };
}
