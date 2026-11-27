import { Hono } from 'hono';
import { z } from 'zod';
import { validateContactInput, formatMessageText } from '@wacrm/shared';
import type { QrBridgeClient, WhatsAppProvider } from '@wacrm/providers';
import { createDb, CrmError, getOrganizationByContext, TenantAccessError } from '@wacrm/db';
import { parseApiConfig, type WorkerBindings } from './env.ts';
import { createLogger, type StructuredLogger } from './logger.ts';
import { restrictedCors } from './middleware/cors.ts';
import { parseJsonBody, RequestValidationError } from './middleware/validate.ts';
import { requireOrgSession, type AuthVariables } from './middleware/auth.ts';
import { createAuthRoutes } from './routes/auth.ts';
import { createCrmRoutes } from './routes/crm.ts';
import { createWebhookRoutes } from './routes/webhooks.ts';
import { createWhatsappRoutes } from './routes/whatsapp.ts';
import { createTemplateRoutes } from './routes/templates.ts';
import { createCampaignRoutes } from './routes/campaigns.ts';
import { createAiRoutes } from './routes/ai.ts';
import { createSaasRoutes } from './routes/saas.ts';
import type { EmailSender } from './auth/email.ts';

export interface AppOptions {
  logger?: StructuredLogger;
  emailSender?: EmailSender;
  metaProvider?: WhatsAppProvider;
  qrBridge?: QrBridgeClient;
  oauthFetchFn?: typeof fetch;
}

const ValidateContactSchema = z.object({
  name: z.string().max(120).optional(),
  phone: z.union([z.string().min(1).max(40), z.number()]),
  company: z.string().max(120).optional(),
  defaultCountryCode: z.string().regex(/^\d{1,4}$/).optional(),
  template: z.string().max(4096).optional()
});

export function createApp(options: AppOptions = {}) {
  const app = new Hono<{
    Bindings: WorkerBindings;
    Variables: AuthVariables;
  }>();

  // Request ID, Security Headers & Structured Logging
  app.use('*', async (c, next) => {
    const requestId = crypto.randomUUID();
    c.set('requestId', requestId);
    c.header('X-Request-Id', requestId);
    c.header('X-Content-Type-Options', 'nosniff');

    const config = parseApiConfig(c.env);
    const logger = options.logger ?? createLogger(config.logLevel);
    const start = Date.now();

    await next();

    c.header('X-Request-Id', requestId);
    c.header('X-Content-Type-Options', 'nosniff');
    if (c.req.path.startsWith('/api/v1/')) {
      c.header('Cache-Control', 'no-store');
      c.header('Pragma', 'no-cache');
    }

    logger.info('http_request', {
      requestId,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durationMs: Date.now() - start
    });
  });

  // Strict origin-allowlisted CORS
  app.use('*', restrictedCors());

  // Centralized Error Handling (never leaks DB credentials, env secrets, or stack traces)
  app.onError((err, c) => {
    const requestId = c.get('requestId') || crypto.randomUUID();
    const config = parseApiConfig(c.env);
    const logger = options.logger ?? createLogger(config.logLevel);

    if (err instanceof RequestValidationError) {
      return c.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: err.message,
            issues: err.issues,
            requestId
          }
        },
        400
      );
    }

    if (err instanceof TenantAccessError || err instanceof CrmError) {
      return c.json(
        {
          error: {
            code: err.code,
            message: err.message,
            requestId
          }
        },
        err.statusCode
      );
    }

    logger.error('unhandled_error', {
      requestId,
      path: c.req.path,
      errorName: err.name
    });

    return c.json(
      {
        error: {
          code: 'INTERNAL_ERROR',
          message: 'An unexpected internal error occurred.',
          requestId
        }
      },
      500
    );
  });

  app.notFound((c) => {
    return c.json(
      {
        error: {
          code: 'NOT_FOUND',
          message: 'Requested endpoint does not exist.',
          requestId: c.get('requestId')
        }
      },
      404
    );
  });

  // Health Endpoint
  app.get('/health', async (c) => {
    let dbCheck: 'ok' | 'unconfigured' | 'error' = 'unconfigured';

    if (c.env?.DB) {
      try {
        await c.env.DB.prepare('SELECT 1 AS ok').first();
        dbCheck = 'ok';
      } catch {
        dbCheck = 'error';
      }
    }

    const healthy = dbCheck !== 'error';
    return c.json(
      {
        ok: healthy,
        service: 'wacrm-api',
        timestamp: new Date().toISOString(),
        checks: {
          database: dbCheck
        }
      },
      healthy ? 200 : 503
    );
  });

  // API Status Endpoint
  app.get('/api/v1/status', (c) => {
    const config = parseApiConfig(c.env);
    return c.json({
      status: 'ok',
      service: 'wacrm-api',
      phase: 'final',
      version: '1.0.0',
      environment: config.environment,
      providers: {
        officialMetaCloud: 'ready',
        unofficialQrBridge: config.qrBridgeConfigured ? 'configured' : 'unconfigured',
        localDesktopConnector: 'isolated_legacy'
      },
      auth: {
        mode: config.passwordAuthEnabled ? 'session_password_enabled' : 'oauth2_pkce_preferred',
        googleOAuthConfigured: config.googleOAuthConfigured,
        githubOAuthConfigured: config.githubOAuthConfigured
      },
      security: {
        encryptionConfigured: config.encryptionConfigured,
        workersAiConfigured: config.workersAiConfigured,
        qrBridgeConfigured: config.qrBridgeConfigured
      }
    });
  });

  // Auth Foundation + OAuth2 PKCE + Workspace Switching
  app.route('/api/v1/auth', createAuthRoutes(options.emailSender, options.oauthFetchFn));

  // Phase 2 CRM Routes (Auth + Org Isolated)
  app.route('/api/v1/crm', createCrmRoutes());

  // Phase 3 Official Meta Cloud API, Templates, QR Bridge & Cloud Campaigns
  app.route('/webhooks', createWebhookRoutes(options.metaProvider, options.qrBridge));
  app.route('/api/v1/whatsapp', createWhatsappRoutes(options.metaProvider, options.qrBridge));
  app.route('/api/v1/templates', createTemplateRoutes());
  app.route('/api/v1/campaigns', createCampaignRoutes(options.metaProvider, options.qrBridge));

  // Phase 5 & 7: AI Support, Knowledge Base, RBAC Team, Invites & SaaS Subscriptions
  app.route('/api/v1/ai', createAiRoutes(options.metaProvider, options.qrBridge));
  app.route('/api/v1', createSaasRoutes());

  // Request Validation Endpoint (exercises @wacrm/shared validation without CRM/WA writes)
  app.post('/api/v1/validate/contact', async (c) => {
    const body = await parseJsonBody(c, ValidateContactSchema);
    const result = validateContactInput(
      {
        name: body.name,
        phone: body.phone,
        company: body.company
      },
      body.defaultCountryCode ?? '92'
    );

    if (!result.valid || !result.contact) {
      return c.json(
        {
          valid: false,
          errors: result.errors
        },
        422
      );
    }

    const preview = body.template
      ? formatMessageText(body.template, result.contact, { spintaxStrategy: 'first' })
      : undefined;

    return c.json({
      valid: true,
      contact: result.contact,
      preview
    });
  });

  // Organization-Isolated Protected Endpoint (Session + Membership Guard)
  app.get('/api/v1/orgs/current', requireOrgSession(), async (c) => {
    const orgContext = c.get('orgContext')!;
    const db = createDb(c.env.DB!);
    const org = await getOrganizationByContext(db, orgContext);

    if (!org) {
      return c.json(
        {
          error: {
            code: 'ORG_NOT_FOUND',
            message: 'Organization not found.',
            requestId: c.get('requestId')
          }
        },
        404
      );
    }

    return c.json({
      organization: org,
      membership: {
        userId: orgContext.userId,
        role: orgContext.role
      }
    });
  });

  return app;
}
