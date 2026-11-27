import type { Context } from 'hono';
import type { ZodSchema } from 'zod';

export class RequestValidationError extends Error {
  readonly issues: Array<{ path: string; message: string }>;

  constructor(issues: Array<{ path: string; message: string }>) {
    super('Request validation failed.');
    this.name = 'RequestValidationError';
    this.issues = issues;
  }
}

export async function parseJsonBody<T>(c: Context, schema: ZodSchema<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new RequestValidationError([{ path: '$body', message: 'Invalid JSON request body.' }]);
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new RequestValidationError(
      parsed.error.issues.map((issue) => ({
        path: issue.path.join('.') || '$body',
        message: issue.message
      }))
    );
  }
  return parsed.data;
}
