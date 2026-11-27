import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  BufferJSON,
  initAuthCreds,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataSet,
  type SignalDataTypeMap
} from '@whiskeysockets/baileys';

const SAFE_ID_RE = /^[a-zA-Z0-9_-]{3,96}$/;

interface PersistedSessionEnvelope {
  version: 1;
  creds: AuthenticationCreds;
  keys: Record<string, Record<string, unknown>>;
}

function assertSafeIdentifier(value: string, label: string): string {
  const trimmed = value.trim();
  if (!SAFE_ID_RE.test(trimmed)) {
    throw new Error(`Invalid ${label} identifier.`);
  }
  return trimmed;
}

/**
 * AES-256-GCM encrypted persistent disk store for Baileys auth credentials and Signal keys.
 * Uses atomic temp-file writes to protect a persistent VPS volume from partial-write corruption.
 */
export class EncryptedSessionStore {
  private readonly rootDir: string;
  private readonly aesKey: Buffer;
  private readonly writeLocks = new Map<string, Promise<void>>();

  constructor(options: { rootDir: string; encryptionKey: string }) {
    const cleanKey = options.encryptionKey.trim();
    if (cleanKey.length < 16) {
      throw new Error('QR_SESSION_ENCRYPTION_KEY must be at least 16 characters.');
    }
    this.rootDir = path.resolve(options.rootDir);
    this.aesKey = crypto.createHash('sha256').update(cleanKey, 'utf8').digest();
  }

  private getSessionFilePath(organizationId: string, whatsappAccountId: string): string {
    const safeOrg = assertSafeIdentifier(organizationId, 'organizationId');
    const safeAcc = assertSafeIdentifier(whatsappAccountId, 'whatsappAccountId');
    const targetDir = path.resolve(this.rootDir, safeOrg, safeAcc);
    if (!targetDir.startsWith(this.rootDir + path.sep)) {
      throw new Error('Session storage path traversal blocked.');
    }
    return path.join(targetDir, 'session.enc.json');
  }

  private encryptPayload(plaintext: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.aesKey, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `enc:v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
  }

  private decryptPayload(ciphertext: string): string {
    const parts = ciphertext.trim().split(':');
    if (parts.length !== 5 || parts[0] !== 'enc' || parts[1] !== 'v1') {
      throw new Error('Corrupted encrypted QR session envelope.');
    }
    const iv = Buffer.from(parts[2]!, 'base64');
    const tag = Buffer.from(parts[3]!, 'base64');
    const data = Buffer.from(parts[4]!, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.aesKey, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
    return decrypted.toString('utf8');
  }

  async hasSessionFile(organizationId: string, whatsappAccountId: string): Promise<boolean> {
    const filePath = this.getSessionFilePath(organizationId, whatsappAccountId);
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async readRawEncryptedBlob(organizationId: string, whatsappAccountId: string): Promise<string | null> {
    const filePath = this.getSessionFilePath(organizationId, whatsappAccountId);
    try {
      return await fs.readFile(filePath, 'utf8');
    } catch {
      return null;
    }
  }

  async clearSession(organizationId: string, whatsappAccountId: string): Promise<void> {
    const safeOrg = assertSafeIdentifier(organizationId, 'organizationId');
    const safeAcc = assertSafeIdentifier(whatsappAccountId, 'whatsappAccountId');
    const targetDir = path.resolve(this.rootDir, safeOrg, safeAcc);
    if (!targetDir.startsWith(this.rootDir + path.sep)) {
      throw new Error('Session storage path traversal blocked.');
    }
    await fs.rm(targetDir, { recursive: true, force: true });
  }

  private queueWrite(key: string, task: () => Promise<void>): Promise<void> {
    const prev = this.writeLocks.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(task);
    this.writeLocks.set(key, next);
    return next;
  }

  private async persistEnvelope(
    organizationId: string,
    whatsappAccountId: string,
    envelope: PersistedSessionEnvelope
  ): Promise<void> {
    const filePath = this.getSessionFilePath(organizationId, whatsappAccountId);
    const dir = path.dirname(filePath);
    const tmpPath = `${filePath}.${crypto.randomUUID()}.tmp`;
    const lockKey = `${organizationId}:${whatsappAccountId}`;

    await this.queueWrite(lockKey, async () => {
      await fs.mkdir(dir, { recursive: true });
      const serialized = JSON.stringify(envelope, BufferJSON.replacer);
      const encrypted = this.encryptPayload(serialized);
      await fs.writeFile(tmpPath, encrypted, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(tmpPath, filePath);
    });
  }

  async loadAuthState(
    organizationId: string,
    whatsappAccountId: string
  ): Promise<{
    state: AuthenticationState;
    hasExistingCreds: boolean;
    saveCreds: () => Promise<void>;
    clear: () => Promise<void>;
  }> {
    const filePath = this.getSessionFilePath(organizationId, whatsappAccountId);
    let envelope: PersistedSessionEnvelope;
    let hasExistingCreds = false;

    try {
      const cipherText = await fs.readFile(filePath, 'utf8');
      const plain = this.decryptPayload(cipherText);
      const parsed = JSON.parse(plain, BufferJSON.reviver) as PersistedSessionEnvelope;
      if (parsed && parsed.version === 1 && parsed.creds) {
        envelope = {
          version: 1,
          creds: parsed.creds,
          keys: parsed.keys && typeof parsed.keys === 'object' ? parsed.keys : {}
        };
        hasExistingCreds = Boolean(parsed.creds.registered || parsed.creds.me?.id);
      } else {
        envelope = { version: 1, creds: initAuthCreds(), keys: {} };
      }
    } catch {
      envelope = { version: 1, creds: initAuthCreds(), keys: {} };
    }

    const state: AuthenticationState = {
      creds: envelope.creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
          const result: { [id: string]: SignalDataTypeMap[T] } = {};
          const bucket = envelope.keys[type] ?? {};
          for (const id of ids) {
            const val = bucket[id];
            if (val !== undefined && val !== null) {
              result[id] = val as SignalDataTypeMap[T];
            }
          }
          return result;
        },
        set: async (data: SignalDataSet) => {
          for (const category of Object.keys(data) as Array<keyof SignalDataTypeMap>) {
            const updates = data[category];
            if (!updates) continue;
            if (!envelope.keys[category]) {
              envelope.keys[category] = {};
            }
            const bucket = envelope.keys[category]!;
            for (const id of Object.keys(updates)) {
              const value = updates[id];
              if (value === null || value === undefined) {
                delete bucket[id];
              } else {
                bucket[id] = value;
              }
            }
          }
          await this.persistEnvelope(organizationId, whatsappAccountId, envelope);
        }
      }
    };

    return {
      state,
      hasExistingCreds,
      saveCreds: async () => {
        await this.persistEnvelope(organizationId, whatsappAccountId, envelope);
      },
      clear: async () => {
        envelope = { version: 1, creds: initAuthCreds(), keys: {} };
        await this.clearSession(organizationId, whatsappAccountId);
      }
    };
  }
}
