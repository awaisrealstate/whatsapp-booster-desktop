import {
  ProviderApiError,
  type QrSessionSnapshot,
  type SendMessageResult
} from './types.ts';

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqualStrings(a: string, b: string): boolean {
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  if (aBytes.length !== bBytes.length) return false;
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
}

export async function computeBridgeSignature(
  secret: string,
  timestampMs: number,
  method: string,
  path: string,
  rawBody: string
): Promise<string> {
  const keyData = new TextEncoder().encode(secret);
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const canonical = `${timestampMs}.${method.toUpperCase()}.${path}.${rawBody}`;
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(canonical));
  return `v1=${toHex(new Uint8Array(sig))}`;
}

export async function verifyBridgeSignature(params: {
  secret: string;
  timestampHeader: string | undefined;
  signatureHeader: string | undefined;
  method: string;
  path: string;
  rawBody: string;
  maxSkewMs?: number;
  nowMs?: number;
}): Promise<boolean> {
  if (!params.secret || params.secret.trim().length < 16) return false;
  if (!params.timestampHeader || !params.signatureHeader) return false;

  const ts = Number(params.timestampHeader);
  if (!Number.isFinite(ts) || ts <= 0) return false;

  const now = params.nowMs ?? Date.now();
  const maxSkew = params.maxSkewMs ?? 5 * 60 * 1000;
  if (Math.abs(now - ts) > maxSkew) return false;

  const expected = await computeBridgeSignature(
    params.secret,
    ts,
    params.method,
    params.path,
    params.rawBody
  );
  return timingSafeEqualStrings(expected, params.signatureHeader.trim());
}

export interface QrBridgeClientOptions {
  baseUrl: string;
  secret: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Signed HTTP client used by Cloudflare API/Workers to talk to the separate Node.js QR service.
 * Never imports Baileys or Node-specific packages so Workers bundle stays clean.
 */
export class QrBridgeClient {
  private readonly baseUrl: string;
  private readonly secret: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: QrBridgeClientOptions) {
    const cleanUrl = options.baseUrl.trim().replace(/\/+$/, '');
    let parsed: URL;
    try {
      parsed = new URL(cleanUrl);
    } catch {
      throw new ProviderApiError(400, 'INVALID_QR_BRIDGE_URL', 'QR_BRIDGE_URL must be a valid http(s) URL.', false);
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new ProviderApiError(400, 'INVALID_QR_BRIDGE_URL', 'QR_BRIDGE_URL protocol must be http or https.', false);
    }
    if (!options.secret || options.secret.trim().length < 16) {
      throw new ProviderApiError(
        503,
        'QR_BRIDGE_SECRET_INVALID',
        'QR_BRIDGE_SECRET (>= 16 chars) is required.',
        false
      );
    }
    this.baseUrl = cleanUrl;
    this.secret = options.secret.trim();
    this.fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 12_000;
  }

  private async signedRequest<T>(method: 'GET' | 'POST', path: string, bodyObj?: unknown): Promise<T> {
    const rawBody = bodyObj !== undefined ? JSON.stringify(bodyObj) : '';
    const timestamp = Date.now();
    const signature = await computeBridgeSignature(this.secret, timestamp, method, path, rawBody);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-Bridge-Timestamp': String(timestamp),
          'X-Bridge-Signature': signature
        },
        body: rawBody ? rawBody : undefined,
        signal: controller.signal
      });
    } catch (err) {
      throw new ProviderApiError(
        503,
        'QR_BRIDGE_UNREACHABLE',
        err instanceof Error ? err.message : 'QR bridge service unreachable.',
        true
      );
    } finally {
      clearTimeout(timer);
    }

    let parsed: Record<string, unknown> = {};
    try {
      parsed = (await res.json()) as Record<string, unknown>;
    } catch {}

    if (!res.ok) {
      const errObj = parsed.error as { code?: string; message?: string; retryable?: boolean } | undefined;
      const retryable = Boolean(errObj?.retryable ?? (res.status === 429 || res.status >= 500));
      throw new ProviderApiError(
        res.status,
        errObj?.code || `QR_BRIDGE_HTTP_${res.status}`,
        errObj?.message || `QR bridge returned HTTP ${res.status}.`,
        retryable
      );
    }

    return parsed as T;
  }

  startSession(input: { organizationId: string; whatsappAccountId: string }): Promise<QrSessionSnapshot> {
    return this.signedRequest<QrSessionSnapshot>('POST', '/internal/sessions/start', input);
  }

  refreshSession(input: { organizationId: string; whatsappAccountId: string }): Promise<QrSessionSnapshot> {
    return this.signedRequest<QrSessionSnapshot>('POST', '/internal/sessions/refresh', input);
  }

  reconnectSession(input: { organizationId: string; whatsappAccountId: string }): Promise<QrSessionSnapshot> {
    return this.signedRequest<QrSessionSnapshot>('POST', '/internal/sessions/reconnect', input);
  }

  getSessionStatus(organizationId: string, whatsappAccountId: string): Promise<QrSessionSnapshot> {
    const query = `?organizationId=${encodeURIComponent(organizationId)}&whatsappAccountId=${encodeURIComponent(whatsappAccountId)}`;
    return this.signedRequest<QrSessionSnapshot>('GET', `/internal/sessions/status${query}`);
  }

  disconnectSession(input: { organizationId: string; whatsappAccountId: string }): Promise<QrSessionSnapshot> {
    return this.signedRequest<QrSessionSnapshot>('POST', '/internal/sessions/disconnect', input);
  }

  sendTextMessage(input: {
    organizationId: string;
    whatsappAccountId: string;
    toPhone: string;
    text: string;
  }): Promise<SendMessageResult> {
    return this.signedRequest<SendMessageResult>('POST', '/internal/messages/send', input);
  }
}
