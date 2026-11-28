import type { MiddlewareHandler } from 'hono';
import { parseApiConfig, type WorkerBindings } from '../env.ts';

/**
 * Restricts CORS strictly to explicitly configured origins in ALLOWED_ORIGINS.
 * Exposes X-Request-Id so browser clients can correlate error reports.
 */
export function restrictedCors(): MiddlewareHandler<{ Bindings: WorkerBindings }> {
  return async (c, next) => {
    const origin = c.req.header('origin');
    const config = parseApiConfig(c.env);
    const isAllowed = !!origin && config.allowedOrigins.includes(origin);

    if (c.req.method === 'OPTIONS') {
      if (!isAllowed) {
        return c.json(
          {
            error: {
              code: 'CORS_ORIGIN_DENIED',
              message: 'Origin is not permitted.'
            }
          },
          403
        );
      }
      c.header('Access-Control-Allow-Origin', origin);
      c.header('Vary', 'Origin');
      c.header('Access-Control-Allow-Credentials', 'true');
      c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Organization-Id');
      c.header('Access-Control-Expose-Headers', 'X-Request-Id');
      c.header('Access-Control-Allow-Private-Network', 'true');
      c.header('Access-Control-Max-Age', '600');
      return c.body(null, 204);
    }

    await next();

    if (isAllowed) {
      c.header('Access-Control-Allow-Origin', origin);
      c.header('Vary', 'Origin');
      c.header('Access-Control-Allow-Credentials', 'true');
      c.header('Access-Control-Expose-Headers', 'X-Request-Id');
      c.header('Access-Control-Allow-Private-Network', 'true');
    }
  };
}
