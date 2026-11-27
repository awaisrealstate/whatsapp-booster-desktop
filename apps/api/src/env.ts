import type { CampaignQueueMessageBody, WorkersAiBinding } from '@wacrm/db';
import { QrBridgeClient } from '@wacrm/providers';

export type AppEnvironment = 'development' | 'staging' | 'production';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type WorkerQueueJob =
  | CampaignQueueMessageBody
  | {
      kind: 'ai_reply';
      organizationId: string;
      conversationId: string;
      customerText: string;
    };

export interface WorkerBindings {
  DB?: D1Database;
  AI?: WorkersAiBinding;
  JOBS_QUEUE?: Queue<WorkerQueueJob>;
  APP_ENV?: string;
  ALLOWED_ORIGINS?: string;
  LOG_LEVEL?: string;
  PASSWORD_AUTH_ENABLED?: string;
  SESSION_SECRET?: string;
  ENCRYPTION_KEY?: string;
  META_APP_SECRET?: string;
  META_WEBHOOK_VERIFY_TOKEN?: string;
  META_GRAPH_VERSION?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  WEB_APP_URL?: string;
  QR_BRIDGE_URL?: string;
  QR_BRIDGE_SECRET?: string;
  PLATFORM_ADMIN_EMAILS?: string;
  GEMINI_API_KEY?: string;
}

export function parsePlatformAdminEmails(env: WorkerBindings | undefined): Set<string> {
  return new Set(
    (env?.PLATFORM_ADMIN_EMAILS ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

export interface ApiConfig {
  environment: AppEnvironment;
  allowedOrigins: string[];
  logLevel: LogLevel;
  passwordAuthEnabled: boolean;
  metaGraphVersion: string;
  encryptionConfigured: boolean;
  googleOAuthConfigured: boolean;
  githubOAuthConfigured: boolean;
  workersAiConfigured: boolean;
  geminiConfigured: boolean;
  qrBridgeConfigured: boolean;
  webAppUrl: string | null;
}

const VALID_ENVS = new Set<AppEnvironment>(['development', 'staging', 'production']);
const VALID_LOG_LEVELS = new Set<LogLevel>(['debug', 'info', 'warn', 'error']);

export function parseApiConfig(env: WorkerBindings | undefined): ApiConfig {
  const rawEnv = (env?.APP_ENV ?? 'development').trim().toLowerCase() as AppEnvironment;
  const environment: AppEnvironment = VALID_ENVS.has(rawEnv) ? rawEnv : 'development';

  const rawLog = (env?.LOG_LEVEL ?? 'info').trim().toLowerCase() as LogLevel;
  const logLevel: LogLevel = VALID_LOG_LEVELS.has(rawLog) ? rawLog : 'info';

  const allowedOrigins = (env?.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => {
      if (!origin || origin === '*') return false;
      try {
        const parsed = new URL(origin);
        return parsed.protocol === 'https:' || parsed.protocol === 'http:';
      } catch {
        return false;
      }
    });

  // Password auth defaults OFF unless explicitly enabled, because 100k PBKDF2
  // has not yet been verified within Cloudflare Workers Free 10 ms CPU limit.
  const passwordAuthEnabled = env?.PASSWORD_AUTH_ENABLED === 'true';
  const rawGraphVer = (env?.META_GRAPH_VERSION ?? 'v21.0').trim();
  const metaGraphVersion = /^v\d{2}\.\d$/.test(rawGraphVer) ? rawGraphVer : 'v21.0';
  const encryptionConfigured = Boolean(env?.ENCRYPTION_KEY && env.ENCRYPTION_KEY.trim().length >= 16);
  const googleOAuthConfigured = Boolean(env?.GOOGLE_CLIENT_ID?.trim() && env?.GOOGLE_CLIENT_SECRET?.trim());
  const githubOAuthConfigured = Boolean(env?.GITHUB_CLIENT_ID?.trim() && env?.GITHUB_CLIENT_SECRET?.trim());
  const workersAiConfigured = Boolean(env?.AI);
  const geminiConfigured = Boolean(env?.GEMINI_API_KEY?.trim());
  const qrBridgeConfigured = Boolean(
    env?.QR_BRIDGE_URL?.trim() && env?.QR_BRIDGE_SECRET && env.QR_BRIDGE_SECRET.trim().length >= 16
  );
  const webAppUrl = env?.WEB_APP_URL?.trim() || null;

  return {
    environment,
    allowedOrigins,
    logLevel,
    passwordAuthEnabled,
    metaGraphVersion,
    encryptionConfigured,
    googleOAuthConfigured,
    githubOAuthConfigured,
    workersAiConfigured,
    geminiConfigured,
    qrBridgeConfigured,
    webAppUrl
  };
}

export function createOptionalQrBridgeClient(
  env: WorkerBindings | undefined,
  customClient?: QrBridgeClient
): QrBridgeClient | undefined {
  if (customClient) return customClient;
  const url = env?.QR_BRIDGE_URL?.trim();
  const secret = env?.QR_BRIDGE_SECRET?.trim();
  if (!url || !secret || secret.length < 16) return undefined;
  return new QrBridgeClient({ baseUrl: url, secret });
}
