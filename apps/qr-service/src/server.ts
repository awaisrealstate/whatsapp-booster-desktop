import fsSync from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ProviderApiError, verifyBridgeSignature } from '@wacrm/providers';
import { EncryptedSessionStore } from './crypto-store.ts';
import { MemoryRateLimiter } from './rate-limit.ts';
import { QrSessionManager, type WaSocketFactory } from './session-manager.ts';

export interface QrServerOptions {
  bridgeSecret: string;
  encryptionKey: string;
  storageDir: string;
  webhookUrl?: string | null;
  qrTtlMs?: number;
  socketFactory?: WaSocketFactory;
  fetchFn?: typeof fetch;
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(payload);
}

async function readRawBody(req: IncomingMessage, maxBytes = 64 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      throw new ProviderApiError(413, 'PAYLOAD_TOO_LARGE', 'Request payload too large.', false);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function headerStr(req: IncomingMessage, name: string): string | undefined {
  const val = req.headers[name.toLowerCase()];
  return Array.isArray(val) ? val[0] : val;
}

export function createQrServiceServer(options: QrServerOptions) {
  const bridgeSecret = options.bridgeSecret.trim();
  if (bridgeSecret.length < 16) {
    throw new Error('QR_BRIDGE_SECRET (>= 16 chars) is required.');
  }

  const store = new EncryptedSessionStore({
    rootDir: options.storageDir,
    encryptionKey: options.encryptionKey
  });

  const mediaDir = path.join(options.storageDir, 'media');

  const manager = new QrSessionManager({
    store,
    bridgeSecret,
    webhookUrl: options.webhookUrl,
    mediaDir,
    qrTtlMs: options.qrTtlMs,
    socketFactory: options.socketFactory,
    fetchFn: options.fetchFn
  });

  const sessionRateLimiter = new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 25 });
  const sendRateLimiter = new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 120 });

  async function handleRequest(input: {
    method: string;
    url: string;
    headers: Record<string, string | undefined>;
    rawBody: string;
  }): Promise<{ statusCode: number; headers: Record<string, string>; body: unknown }> {
    const reqUrl = new URL(input.url || '/', 'http://127.0.0.1');
    const method = (input.method || 'GET').toUpperCase();
    const baseHeaders: Record<string, string> = {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    };

    if (method === 'GET' && reqUrl.pathname === '/health') {
      return {
        statusCode: 200,
        headers: baseHeaders,
        body: {
          ok: true,
          service: 'wacrm-qr-service',
          activeSessions: manager.getActiveSessionCount(),
          timestamp: new Date().toISOString()
        }
      };
    }

    if (!reqUrl.pathname.startsWith('/internal/')) {
      return {
        statusCode: 404,
        headers: baseHeaders,
        body: { error: { code: 'NOT_FOUND', message: 'Route not found.' } }
      };
    }

    try {
      const signedPath = `${reqUrl.pathname}${reqUrl.search}`;
      const validSig = await verifyBridgeSignature({
        secret: bridgeSecret,
        timestampHeader: input.headers['x-bridge-timestamp'],
        signatureHeader: input.headers['x-bridge-signature'],
        method,
        path: signedPath,
        rawBody: method === 'GET' ? '' : input.rawBody
      });

      if (!validSig) {
        return {
          statusCode: 401,
          headers: baseHeaders,
          body: {
            error: { code: 'INVALID_BRIDGE_SIGNATURE', message: 'Bridge HMAC signature invalid or expired.' }
          }
        };
      }

      if (method === 'GET' && reqUrl.pathname === '/internal/sessions/status') {
        const organizationId = reqUrl.searchParams.get('organizationId')?.trim() || '';
        const whatsappAccountId = reqUrl.searchParams.get('whatsappAccountId')?.trim() || '';
        if (!organizationId || !whatsappAccountId) {
          return {
            statusCode: 400,
            headers: baseHeaders,
            body: { error: { code: 'MISSING_PARAMS', message: 'organizationId and whatsappAccountId are required.' } }
          };
        }
        return {
          statusCode: 200,
          headers: baseHeaders,
          body: await manager.getSessionStatus(organizationId, whatsappAccountId)
        };
      }

      const body = input.rawBody ? (JSON.parse(input.rawBody) as Record<string, unknown>) : {};
      const organizationId = typeof body.organizationId === 'string' ? body.organizationId.trim() : '';
      const whatsappAccountId = typeof body.whatsappAccountId === 'string' ? body.whatsappAccountId.trim() : '';

      if (!organizationId || !whatsappAccountId) {
        return {
          statusCode: 400,
          headers: baseHeaders,
          body: { error: { code: 'MISSING_PARAMS', message: 'organizationId and whatsappAccountId are required.' } }
        };
      }

      if (reqUrl.pathname.startsWith('/internal/sessions/')) {
        const rl = sessionRateLimiter.checkAndConsume(`sess:${organizationId}`);
        if (!rl.allowed) {
          return {
            statusCode: 429,
            headers: { ...baseHeaders, 'Retry-After': String(rl.retryAfterSec) },
            body: { error: { code: 'RATE_LIMITED', message: 'Too many QR session operations; try shortly.', retryable: true } }
          };
        }
      }

      if (method === 'POST' && reqUrl.pathname === '/internal/sessions/start') {
        return { statusCode: 200, headers: baseHeaders, body: await manager.startSession(organizationId, whatsappAccountId) };
      }
      if (method === 'POST' && reqUrl.pathname === '/internal/sessions/refresh') {
        return { statusCode: 200, headers: baseHeaders, body: await manager.refreshSession(organizationId, whatsappAccountId) };
      }
      if (method === 'POST' && reqUrl.pathname === '/internal/sessions/reconnect') {
        return { statusCode: 200, headers: baseHeaders, body: await manager.reconnectSession(organizationId, whatsappAccountId) };
      }
      if (method === 'POST' && reqUrl.pathname === '/internal/sessions/disconnect') {
        return { statusCode: 200, headers: baseHeaders, body: await manager.disconnectSession(organizationId, whatsappAccountId) };
      }

      if (method === 'POST' && reqUrl.pathname === '/internal/messages/send') {
        const rl = sendRateLimiter.checkAndConsume(`send:${organizationId}`);
        if (!rl.allowed) {
          return {
            statusCode: 429,
            headers: { ...baseHeaders, 'Retry-After': String(rl.retryAfterSec) },
            body: { error: { code: 'RATE_LIMITED', message: 'QR message rate limit exceeded.', retryable: true } }
          };
        }
        const toPhone = typeof body.toPhone === 'string' ? body.toPhone.trim() : '';
        const text = typeof body.text === 'string' ? body.text : '';
        if (!toPhone || !text.trim()) {
          return {
            statusCode: 400,
            headers: baseHeaders,
            body: { error: { code: 'MESSAGE_REQUIRED', message: 'toPhone and text are required.' } }
          };
        }
        return {
          statusCode: 200,
          headers: baseHeaders,
          body: await manager.sendTextMessage({ organizationId, whatsappAccountId, toPhone, text })
        };
      }

      return {
        statusCode: 404,
        headers: baseHeaders,
        body: { error: { code: 'NOT_FOUND', message: 'Unknown QR bridge endpoint.' } }
      };
    } catch (err) {
      if (err instanceof ProviderApiError) {
        return {
          statusCode: err.statusCode,
          headers: baseHeaders,
          body: { error: { code: err.code, message: err.message, retryable: err.retryable } }
        };
      }
      return {
        statusCode: 500,
        headers: baseHeaders,
        body: {
          error: {
            code: 'QR_SERVICE_ERROR',
            message: err instanceof Error ? err.message : 'Unexpected QR service failure.'
          }
        }
      };
    }
  }

  const server = http.createServer(async (req, res) => {
    try {
      const method = (req.method || 'GET').toUpperCase();
      const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');

      // Serve downloaded WhatsApp media files securely
      if (method === 'GET' && reqUrl.pathname.startsWith('/media/')) {
        const parts = reqUrl.pathname.slice('/media/'.length).split('/');
        if (parts.length === 3) {
          const orgId = parts[0]!;
          const accountId = parts[1]!;
          const filename = parts[2]!;
          if (/^[a-zA-Z0-9_-]+$/.test(orgId) && /^[a-zA-Z0-9_-]+$/.test(accountId) && /^[a-zA-Z0-9_.-]+$/.test(filename)) {
            const filePath = path.resolve(mediaDir, orgId, accountId, filename);
            if (filePath.startsWith(mediaDir) && fsSync.existsSync(filePath)) {
              const ext = path.extname(filename).toLowerCase();
              const mimeMap: Record<string, string> = {
                '.jpg': 'image/jpeg',
                '.jpeg': 'image/jpeg',
                '.png': 'image/png',
                '.webp': 'image/webp',
                '.gif': 'image/gif',
                '.mp4': 'video/mp4',
                '.ogg': 'audio/ogg',
                '.opus': 'audio/ogg',
                '.mp3': 'audio/mpeg',
                '.pdf': 'application/pdf',
                '.txt': 'text/plain'
              };
              const mime = mimeMap[ext] || 'application/octet-stream';
              const stat = fsSync.statSync(filePath);
              res.writeHead(200, {
                'Content-Type': mime,
                'Content-Length': stat.size,
                'Cache-Control': 'public, max-age=86400',
                'X-Content-Type-Options': 'nosniff'
              });
              fsSync.createReadStream(filePath).pipe(res);
              return;
            }
          }
        }
        sendJson(res, 404, { error: { code: 'MEDIA_NOT_FOUND', message: 'Media file not found.' } });
        return;
      }

      const rawBody = method === 'GET' ? '' : await readRawBody(req);
      const out = await handleRequest({
        method,
        url: req.url || '/',
        headers: {
          'x-bridge-timestamp': headerStr(req, 'x-bridge-timestamp'),
          'x-bridge-signature': headerStr(req, 'x-bridge-signature')
        },
        rawBody
      });
      res.writeHead(out.statusCode, out.headers);
      res.end(JSON.stringify(out.body));
    } catch (err) {
      if (err instanceof ProviderApiError) {
        return sendJson(res, err.statusCode, { error: { code: err.code, message: err.message } });
      }
      return sendJson(res, 500, { error: { code: 'QR_SERVICE_ERROR', message: 'Request read error.' } });
    }
  });

  return { server, manager, store, handleRequest };
}

const isEntryPoint =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

function loadLocalEnvFile(envPath: string): void {
  if (!fsSync.existsSync(envPath)) return;
  const raw = fsSync.readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key && process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}

if (isEntryPoint) {
  loadLocalEnvFile(path.resolve(process.cwd(), '.env'));
  const port = Number(process.env.PORT ?? 8790) || 8790;
  const host = process.env.HOST?.trim() || '127.0.0.1';
  const bridgeSecret = process.env.QR_BRIDGE_SECRET?.trim() || '';
  const encryptionKey = process.env.QR_SESSION_ENCRYPTION_KEY?.trim() || '';
  const storageDir = process.env.QR_STORAGE_DIR?.trim() || path.resolve(process.cwd(), 'qr_data');
  const webhookUrl = process.env.API_WEBHOOK_URL?.trim() || null;
  const qrTtlMs = Number(process.env.QR_TTL_MS ?? 60_000) || 60_000;

  const { server, manager } = createQrServiceServer({
    bridgeSecret,
    encryptionKey,
    storageDir,
    webhookUrl,
    qrTtlMs
  });

  server.listen(port, host, () => {
    console.log(`[wacrm-qr-service] Listening on http://${host}:${port} (encrypted storage: ${storageDir})`);
    void manager
      .restorePersistedSessions()
      .then((res) => {
        if (res.restored > 0 || res.failed > 0) {
          console.log(
            `[wacrm-qr-service] Session recovery complete: restored=${res.restored}, skipped=${res.skipped}, failed=${res.failed}`
          );
        }
      })
      .catch((err) => {
        console.warn('[wacrm-qr-service] Startup session recovery error:', err instanceof Error ? err.message : String(err));
      });
  });
}
