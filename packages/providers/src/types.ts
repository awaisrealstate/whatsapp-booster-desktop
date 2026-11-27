export type ProviderType = 'official_meta_cloud' | 'unofficial_local_desktop' | 'unofficial_bridge';

export interface MetaTemplateComponentParam {
  type: 'text';
  text: string;
}

export interface SendTemplateInput {
  phoneNumberId: string;
  accessToken: string;
  toPhone: string;
  templateName: string;
  languageCode: string;
  bodyParameters?: string[];
}

export interface SendFreeformTextInput {
  phoneNumberId: string;
  accessToken: string;
  toPhone: string;
  body: string;
  serviceWindowExpiresAt: number | null;
  now?: number;
}

export interface SendMessageResult {
  providerMessageId: string;
  recipientWaId: string | null;
}

export interface ProviderTemplateSummary {
  metaTemplateId: string;
  name: string;
  language: string;
  category: 'UTILITY' | 'MARKETING' | 'AUTHENTICATION' | 'CUSTOM_TEXT';
  approvalStatus: 'LOCAL' | 'PENDING' | 'APPROVED' | 'REJECTED';
  bodyText: string;
}

export interface WebhookChallengeInput {
  mode: string | null | undefined;
  verifyToken: string | null | undefined;
  challenge: string | null | undefined;
  expectedVerifyToken?: string | null;
  expectedVerifyTokenSha256?: string | null;
}

export interface ParsedInboundMessage {
  kind: 'inbound_message';
  eventKey: string;
  phoneNumberId: string;
  fromPhone: string;
  profileName: string | null;
  providerMessageId: string;
  msgType: 'text' | 'image' | 'document' | 'audio';
  body: string;
  timestampMs: number;
  isStopKeyword: boolean;
}

export interface ParsedStatusUpdate {
  kind: 'status_update';
  eventKey: string;
  phoneNumberId: string;
  providerMessageId: string;
  recipientPhone: string | null;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  errorCode: string | null;
  errorMessage: string | null;
  timestampMs: number;
}

export type ParsedWebhookEvent = ParsedInboundMessage | ParsedStatusUpdate;

export class ProviderApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly retryable: boolean;

  constructor(statusCode: number, code: string, message: string, retryable: boolean) {
    super(message);
    this.name = 'ProviderApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.retryable = retryable;
  }
}

export interface VerifyAccountResult {
  valid: boolean;
  phoneNumber: string | null;
  verifiedName: string | null;
}

export type QrBridgeStatus =
  | 'connecting'
  | 'waiting_for_scan'
  | 'connected'
  | 'disconnected'
  | 'expired'
  | 'error';

export interface QrSessionSnapshot {
  organizationId: string;
  whatsappAccountId: string;
  status: QrBridgeStatus;
  qrDataUrl: string | null;
  qrExpiresAt: number | null;
  phoneNumber: string | null;
  lastConnectedAt: number | null;
  lastError: string | null;
}

export interface QrBridgeInboundEvent {
  eventType: 'inbound_message';
  eventId: string;
  organizationId: string;
  whatsappAccountId: string;
  fromPhone: string;
  profileName?: string | null;
  providerMessageId: string;
  body: string;
  timestampMs: number;
}

export interface QrBridgeSessionEvent {
  eventType: 'session_update';
  organizationId: string;
  whatsappAccountId: string;
  status: QrBridgeStatus;
  qrDataUrl?: string | null;
  qrExpiresAt?: number | null;
  phoneNumber?: string | null;
  lastConnectedAt?: number | null;
  lastError?: string | null;
}

export type QrBridgeWebhookPayload = QrBridgeSessionEvent | QrBridgeInboundEvent;

export interface WhatsAppProvider {
  readonly providerType: ProviderType;
  sendTemplateMessage(input: SendTemplateInput): Promise<SendMessageResult>;
  sendFreeformText(input: SendFreeformTextInput): Promise<SendMessageResult>;
  syncTemplates(wabaId: string, accessToken: string): Promise<ProviderTemplateSummary[]>;
  verifyAccountCredentials?(phoneNumberId: string, accessToken: string): Promise<VerifyAccountResult>;
  verifyWebhookChallenge(input: WebhookChallengeInput): Promise<{ valid: boolean; challenge: string | null }>;
  verifyWebhookSignature(rawBody: string, signatureHeader: string | undefined, appSecret: string): Promise<boolean>;
  parseWebhookPayload(payload: unknown): ParsedWebhookEvent[];
}
