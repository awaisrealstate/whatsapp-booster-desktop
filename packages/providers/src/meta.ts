import { isStopOptOutText } from './stop.ts';
import {
  ProviderApiError,
  type ParsedWebhookEvent,
  type ProviderTemplateSummary,
  type SendFreeformTextInput,
  type SendMessageResult,
  type SendTemplateInput,
  type VerifyAccountResult,
  type WebhookChallengeInput,
  type WhatsAppProvider
} from './types.ts';

const META_GRAPH_HOST = 'https://graph.facebook.com';
const GRAPH_VERSION_RE = /^v\d{2}\.\d$/;
const NUMERIC_ID_RE = /^\d{5,32}$/;

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

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return toHex(new Uint8Array(digest));
}

export interface MetaCloudProviderOptions {
  graphVersion?: string;
  fetchFn?: typeof fetch;
}

/**
 * Official Meta WhatsApp Cloud API provider using https://graph.facebook.com directly.
 * Enforces 24h customer care windows for free-form text and HMAC-SHA256 webhook verification.
 */
export class MetaCloudProvider implements WhatsAppProvider {
  readonly providerType = 'official_meta_cloud' as const;
  private readonly graphVersion: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: MetaCloudProviderOptions = {}) {
    const version = (options.graphVersion ?? 'v21.0').trim();
    if (!GRAPH_VERSION_RE.test(version)) {
      throw new Error(`Invalid Meta Graph API version: ${version}`);
    }
    this.graphVersion = version;
    this.fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
  }

  private assertNumericId(value: string, label: string): string {
    const trimmed = value.trim();
    if (!NUMERIC_ID_RE.test(trimmed)) {
      throw new ProviderApiError(400, 'INVALID_META_ID', `${label} must be a numeric Meta ID.`, false);
    }
    return trimmed;
  }

  private normalizeRecipientDigits(phone: string): string {
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 8 || digits.length > 15) {
      throw new ProviderApiError(422, 'INVALID_RECIPIENT_PHONE', 'Recipient phone must have 8..15 digits.', false);
    }
    return digits;
  }

  private async postMessagesEndpoint(
    phoneNumberId: string,
    accessToken: string,
    payload: Record<string, unknown>
  ): Promise<SendMessageResult> {
    const cleanPhoneId = this.assertNumericId(phoneNumberId, 'phoneNumberId');
    if (!accessToken.trim()) {
      throw new ProviderApiError(401, 'MISSING_ACCESS_TOKEN', 'Meta access token is missing.', false);
    }

    const url = `${META_GRAPH_HOST}/${this.graphVersion}/${cleanPhoneId}/messages`;
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken.trim()}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });
    } catch (err) {
      throw new ProviderApiError(
        503,
        'META_NETWORK_ERROR',
        err instanceof Error ? err.message : 'Network error calling Meta Cloud API.',
        true
      );
    }

    let bodyJson: {
      messages?: Array<{ id?: string }>;
      contacts?: Array<{ wa_id?: string }>;
      error?: { message?: string; code?: number; fbtrace_id?: string };
    } = {};

    try {
      bodyJson = (await res.json()) as typeof bodyJson;
    } catch {}

    if (!res.ok) {
      const retryable = res.status === 429 || res.status >= 500;
      const errCode = bodyJson.error?.code ? `META_${bodyJson.error.code}` : `META_HTTP_${res.status}`;
      const errMsg = bodyJson.error?.message || `Meta Cloud API returned HTTP ${res.status}.`;
      throw new ProviderApiError(res.status, errCode, errMsg, retryable);
    }

    const messageId = bodyJson.messages?.[0]?.id;
    if (!messageId) {
      throw new ProviderApiError(502, 'META_EMPTY_RESPONSE', 'Meta Cloud API response did not include message ID.', true);
    }

    return {
      providerMessageId: messageId,
      recipientWaId: bodyJson.contacts?.[0]?.wa_id ?? null
    };
  }

  async verifyAccountCredentials(phoneNumberId: string, accessToken: string): Promise<VerifyAccountResult> {
    const cleanPhoneId = this.assertNumericId(phoneNumberId, 'phoneNumberId');
    if (!accessToken.trim()) {
      throw new ProviderApiError(401, 'MISSING_ACCESS_TOKEN', 'Meta access token is missing.', false);
    }

    const url = `${META_GRAPH_HOST}/${this.graphVersion}/${cleanPhoneId}?fields=display_phone_number,verified_name`;
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken.trim()}` }
      });
    } catch (err) {
      throw new ProviderApiError(
        503,
        'META_NETWORK_ERROR',
        err instanceof Error ? err.message : 'Network error verifying Meta credentials.',
        true
      );
    }

    let bodyJson: {
      id?: string;
      display_phone_number?: string;
      verified_name?: string;
      error?: { message?: string; code?: number };
    } = {};
    try {
      bodyJson = (await res.json()) as typeof bodyJson;
    } catch {}

    if (!res.ok) {
      const retryable = res.status === 429 || res.status >= 500;
      const errCode = bodyJson.error?.code ? `META_${bodyJson.error.code}` : `META_HTTP_${res.status}`;
      const errMsg = bodyJson.error?.message || `Meta Graph verification failed (HTTP ${res.status}).`;
      throw new ProviderApiError(res.status, errCode, errMsg, retryable);
    }

    return {
      valid: true,
      phoneNumber: bodyJson.display_phone_number?.trim() || null,
      verifiedName: bodyJson.verified_name?.trim() || null
    };
  }

  async sendTemplateMessage(input: SendTemplateInput): Promise<SendMessageResult> {
    const to = this.normalizeRecipientDigits(input.toPhone);
    const params = (input.bodyParameters ?? []).map((val) => ({
      type: 'text',
      text: String(val)
    }));

    const templateObj: Record<string, unknown> = {
      name: input.templateName.trim(),
      language: { code: input.languageCode.trim() || 'en' }
    };

    if (params.length > 0) {
      templateObj.components = [
        {
          type: 'body',
          parameters: params
        }
      ];
    }

    return this.postMessagesEndpoint(input.phoneNumberId, input.accessToken, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'template',
      template: templateObj
    });
  }

  async sendFreeformText(input: SendFreeformTextInput): Promise<SendMessageResult> {
    const now = input.now ?? Date.now();
    if (!input.serviceWindowExpiresAt || input.serviceWindowExpiresAt <= now) {
      throw new ProviderApiError(
        422,
        'OUTSIDE_24H_WINDOW',
        'Cannot send free-form text outside the 24-hour customer service window. Use an approved Meta template instead.',
        false
      );
    }

    const to = this.normalizeRecipientDigits(input.toPhone);
    const body = input.body.trim();
    if (!body) {
      throw new ProviderApiError(422, 'EMPTY_MESSAGE', 'Message body cannot be empty.', false);
    }

    return this.postMessagesEndpoint(input.phoneNumberId, input.accessToken, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: {
        preview_url: false,
        body: body.slice(0, 4096)
      }
    });
  }

  async syncTemplates(wabaId: string, accessToken: string): Promise<ProviderTemplateSummary[]> {
    const cleanWabaId = this.assertNumericId(wabaId, 'wabaId');
    if (!accessToken.trim()) {
      throw new ProviderApiError(401, 'MISSING_ACCESS_TOKEN', 'Meta access token is missing.', false);
    }

    const url = `${META_GRAPH_HOST}/${this.graphVersion}/${cleanWabaId}/message_templates?limit=100`;
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken.trim()}`
        }
      });
    } catch (err) {
      throw new ProviderApiError(
        503,
        'META_NETWORK_ERROR',
        err instanceof Error ? err.message : 'Network error syncing templates.',
        true
      );
    }

    const json = (await res.json().catch(() => ({}))) as {
      data?: Array<{
        id?: string;
        name?: string;
        language?: string;
        category?: string;
        status?: string;
        components?: Array<{ type?: string; text?: string }>;
      }>;
      error?: { message?: string; code?: number };
    };

    if (!res.ok) {
      throw new ProviderApiError(
        res.status,
        json.error?.code ? `META_${json.error.code}` : `META_HTTP_${res.status}`,
        json.error?.message || `Failed to sync templates (HTTP ${res.status}).`,
        res.status === 429 || res.status >= 500
      );
    }

    const validCategories = new Set(['UTILITY', 'MARKETING', 'AUTHENTICATION']);
    const validStatuses = new Set(['PENDING', 'APPROVED', 'REJECTED']);

    return (json.data ?? [])
      .filter((t) => Boolean(t.id && t.name))
      .map((t) => {
        const rawCat = (t.category ?? 'UTILITY').toUpperCase();
        const rawStatus = (t.status ?? 'PENDING').toUpperCase();
        const bodyComp = t.components?.find((c) => c.type?.toUpperCase() === 'BODY');
        return {
          metaTemplateId: String(t.id),
          name: String(t.name),
          language: String(t.language || 'en'),
          category: (validCategories.has(rawCat) ? rawCat : 'UTILITY') as ProviderTemplateSummary['category'],
          approvalStatus: (validStatuses.has(rawStatus) ? rawStatus : 'PENDING') as ProviderTemplateSummary['approvalStatus'],
          bodyText: String(bodyComp?.text ?? '')
        };
      });
  }

  async verifyWebhookChallenge(
    input: WebhookChallengeInput
  ): Promise<{ valid: boolean; challenge: string | null }> {
    if (input.mode !== 'subscribe' || !input.verifyToken || !input.challenge) {
      return { valid: false, challenge: null };
    }

    if (input.expectedVerifyTokenSha256) {
      const incomingHash = await sha256Hex(input.verifyToken);
      if (timingSafeEqualStrings(incomingHash, input.expectedVerifyTokenSha256.toLowerCase())) {
        return { valid: true, challenge: input.challenge };
      }
    }

    if (input.expectedVerifyToken) {
      if (timingSafeEqualStrings(input.verifyToken, input.expectedVerifyToken)) {
        return { valid: true, challenge: input.challenge };
      }
    }

    return { valid: false, challenge: null };
  }

  async verifyWebhookSignature(
    rawBody: string,
    signatureHeader: string | undefined,
    appSecret: string
  ): Promise<boolean> {
    if (!signatureHeader || !appSecret) return false;
    const match = /^sha256=([0-9a-f]{64})$/i.exec(signatureHeader.trim());
    if (!match?.[1]) return false;

    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(appSecret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );

    const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
    const expectedHex = toHex(new Uint8Array(mac));
    return timingSafeEqualStrings(expectedHex, match[1].toLowerCase());
  }

  parseWebhookPayload(payload: unknown): ParsedWebhookEvent[] {
    if (!payload || typeof payload !== 'object') return [];
    const root = payload as {
      entry?: Array<{
        changes?: Array<{
          field?: string;
          value?: {
            metadata?: { phone_number_id?: string };
            contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>;
            messages?: Array<{
              id?: string;
              from?: string;
              timestamp?: string;
              type?: string;
              text?: { body?: string };
              button?: { text?: string };
              interactive?: {
                button_reply?: { title?: string };
                list_reply?: { title?: string };
              };
            }>;
            statuses?: Array<{
              id?: string;
              status?: string;
              timestamp?: string;
              recipient_id?: string;
              errors?: Array<{ code?: number; title?: string; message?: string }>;
            }>;
          };
        }>;
      }>;
    };

    const events: ParsedWebhookEvent[] = [];

    for (const entry of root.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const val = change.value;
        if (!val) continue;
        const phoneNumberId = val.metadata?.phone_number_id ?? '';
        if (!phoneNumberId) continue;

        const profileMap = new Map<string, string>();
        for (const c of val.contacts ?? []) {
          if (c.wa_id && c.profile?.name) {
            profileMap.set(c.wa_id, c.profile.name);
          }
        }

        for (const msg of val.messages ?? []) {
          if (!msg.id || !msg.from) continue;
          const bodyText =
            msg.text?.body ??
            msg.button?.text ??
            msg.interactive?.button_reply?.title ??
            msg.interactive?.list_reply?.title ??
            `[${msg.type ?? 'media'} message]`;

          const tsSec = Number(msg.timestamp ?? 0);
          const timestampMs = tsSec > 0 ? tsSec * 1000 : Date.now();
          const normalizedType =
            msg.type === 'image' || msg.type === 'document' || msg.type === 'audio' ? msg.type : 'text';

          events.push({
            kind: 'inbound_message',
            eventKey: `in:${msg.id}`,
            phoneNumberId,
            fromPhone: msg.from,
            profileName: profileMap.get(msg.from) ?? null,
            providerMessageId: msg.id,
            msgType: normalizedType,
            body: bodyText,
            timestampMs,
            isStopKeyword: isStopOptOutText(bodyText)
          });
        }

        for (const st of val.statuses ?? []) {
          if (!st.id || !st.status) continue;
          if (!['sent', 'delivered', 'read', 'failed'].includes(st.status)) continue;

          const tsSec = Number(st.timestamp ?? 0);
          const timestampMs = tsSec > 0 ? tsSec * 1000 : Date.now();
          const firstErr = st.errors?.[0];

          events.push({
            kind: 'status_update',
            eventKey: `st:${st.id}:${st.status}`,
            phoneNumberId,
            providerMessageId: st.id,
            recipientPhone: st.recipient_id ?? null,
            status: st.status as 'sent' | 'delivered' | 'read' | 'failed',
            errorCode: firstErr?.code ? String(firstErr.code) : null,
            errorMessage: firstErr?.message || firstErr?.title || null,
            timestampMs
          });
        }
      }
    }

    return events;
  }
}
