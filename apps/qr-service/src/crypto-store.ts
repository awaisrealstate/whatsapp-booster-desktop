import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataSet,
  type SignalDataTypeMap
} from '@whiskeysockets/baileys';

const SAFE_ID_RE = /^[a-zA-Z0-9_-]{3,96}$/;

export interface PersistedSessionSummary {
  organizationId: string;
  whatsappAccountId: string;
  hasExistingCreds: boolean;
  phoneNumber: string | null;
}

interface PersistedSessionEnvelope {
  version: 1;
  creds: AuthenticationCreds;
  keys: Record<string, Record<string, unknown>>;
}

function jidToPhoneNumber(jid: string | null | undefined): string | null {
  if (!jid) return null;
  const userPart = jid.split('@')[0]?.split(':')[0] ?? '';
  const digits = userPart.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) return null;
  return `+${digits}`;
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

  async listPersistedSessionKeys(): Promise<Array<{ organizationId: string; whatsappAccountId: string }>> {
    const results: Array<{ organizationId: string; whatsappAccountId: string }> = [];
    let orgEntries: import('node:fs').Dirent[];
    try {
      orgEntries = await fs.readdir(this.rootDir, { withFileTypes: true });
    } catch (err) {
      if ((err as { code?: string } | null)?.code === 'ENOENT') return results;
      throw err;
    }

    for (const orgEntry of orgEntries) {
      if (!orgEntry.isDirectory() || !SAFE_ID_RE.test(orgEntry.name)) continue;
      const orgDir = path.join(this.rootDir, orgEntry.name);
      let accEntries: import('node:fs').Dirent[];
      try {
        accEntries = await fs.readdir(orgDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const accEntry of accEntries) {
        if (!accEntry.isDirectory() || !SAFE_ID_RE.test(accEntry.name)) continue;
        const encFile = path.join(orgDir, accEntry.name, 'session.enc.json');
        try {
          await fs.access(encFile);
          results.push({ organizationId: orgEntry.name, whatsappAccountId: accEntry.name });
        } catch {
          // Directory exists without finalized encrypted session file
        }
      }
    }
    return results;
  }

  async readPersistedSummary(
    organizationId: string,
    whatsappAccountId: string
  ): Promise<PersistedSessionSummary | null> {
    const filePath = this.getSessionFilePath(organizationId, whatsappAccountId);
    let cipherText: string;
    try {
      cipherText = await fs.readFile(filePath, 'utf8');
    } catch (err) {
      if ((err as { code?: string } | null)?.code === 'ENOENT') return null;
      throw err;
    }

    const plain = this.decryptPayload(cipherText);
    const parsed = JSON.parse(plain, BufferJSON.reviver) as PersistedSessionEnvelope;
    if (!parsed || parsed.version !== 1 || !parsed.creds) {
      throw new Error('Corrupted encrypted QR session envelope.');
    }
    return {
      organizationId,
      whatsappAccountId,
      hasExistingCreds: Boolean(parsed.creds.registered || parsed.creds.me?.id),
      phoneNumber: jidToPhoneNumber(parsed.creds.me?.id)
    };
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
      if (!parsed || parsed.version !== 1 || !parsed.creds) {
        throw new Error('Corrupted encrypted QR session envelope.');
      }
      envelope = {
        version: 1,
        creds: parsed.creds,
        keys: parsed.keys && typeof parsed.keys === 'object' ? parsed.keys : {}
      };
      hasExistingCreds = Boolean(parsed.creds.registered || parsed.creds.me?.id);
    } catch (err) {
      if ((err as { code?: string } | null)?.code === 'ENOENT') {
        envelope = { version: 1, creds: initAuthCreds(), keys: {} };
      } else {
        throw new Error(
          `Failed to decrypt persisted QR session for ${organizationId}:${whatsappAccountId}. Check QR_SESSION_ENCRYPTION_KEY.`
        );
      }
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
              const normalized =
                type === 'app-state-sync-key' && typeof val === 'object'
                  ? proto.Message.AppStateSyncKeyData.fromObject(val as Record<string, unknown>)
                  : val;
              result[id] = normalized as SignalDataTypeMap[T];
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
