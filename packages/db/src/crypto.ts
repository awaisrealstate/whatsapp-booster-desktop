/**
 * Cloudflare Workers WebCrypto restricts PBKDF2 to at most 100,000 iterations.
 */
export const PBKDF2_MAX_WORKERS_ITERATIONS = 100_000;
export const PBKDF2_DEFAULT_ITERATIONS = 100_000;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) {
    throw new Error('Invalid hex string.');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

/**
 * Generates a URL-safe opaque token using WebCrypto CSPRNG.
 */
export function generateOpaqueToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

/**
 * Computes SHA-256 hex digest of an opaque session/verification token.
 * Raw tokens must never be persisted in D1.
 */
export async function hashTokenSha256(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return toHex(new Uint8Array(digest));
}

/**
 * Hashes a password with WebCrypto PBKDF2-SHA256 (<= 100,000 iterations for Workers compatibility).
 * Format: pbkdf2_sha256$<iterations>$<saltHex>$<derivedHex>
 */
export async function hashPasswordPbkdf2(
  password: string,
  iterations = PBKDF2_DEFAULT_ITERATIONS
): Promise<string> {
  if (!password || password.length < 8) {
    throw new Error('Password must be at least 8 characters.');
  }
  if (!Number.isInteger(iterations) || iterations < 10_000 || iterations > PBKDF2_MAX_WORKERS_ITERATIONS) {
    throw new Error(`PBKDF2 iterations must be between 10000 and ${PBKDF2_MAX_WORKERS_ITERATIONS}.`);
  }

  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );

  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations,
      hash: 'SHA-256'
    },
    keyMaterial,
    256
  );

  return `pbkdf2_sha256$${iterations}$${toHex(salt)}$${toHex(new Uint8Array(bits))}`;
}

export async function verifyPasswordPbkdf2(password: string, storedHash: string): Promise<boolean> {
  const parts = storedHash.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2_sha256') {
    return false;
  }

  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 10_000 || iterations > PBKDF2_MAX_WORKERS_ITERATIONS) {
    return false;
  }

  try {
    const salt = fromHex(parts[2] ?? '');
    const expected = fromHex(parts[3] ?? '');
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(password),
      'PBKDF2',
      false,
      ['deriveBits']
    );

    const bits = await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt: salt as unknown as BufferSource,
        iterations,
        hash: 'SHA-256'
      },
      keyMaterial,
      expected.length * 8
    );

    return timingSafeEqualBytes(new Uint8Array(bits), expected);
  } catch {
    return false;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function importAesKeyFromSecret(secretMaterial: string): Promise<CryptoKey> {
  const clean = secretMaterial.trim();
  if (clean.length < 16) {
    throw new Error('ENCRYPTION_KEY must be configured with at least 16 characters.');
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(clean));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt'
  ]);
}

/**
 * Encrypts sensitive tenant credentials (e.g. Meta WABA access token / app secret)
 * using AES-256-GCM with a fresh 96-bit CSPRNG IV. Envelope: `enc:v1:<ivB64>:<cipherB64>`.
 */
export async function encryptSecretAesGcm(plaintext: string, encryptionKey: string): Promise<string> {
  if (!plaintext) {
    throw new Error('Cannot encrypt empty secret.');
  }
  const key = await importAesKeyFromSecret(encryptionKey);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as unknown as BufferSource },
    key,
    new TextEncoder().encode(plaintext)
  );
  return `enc:v1:${bytesToBase64(iv)}:${bytesToBase64(new Uint8Array(ciphertext))}`;
}

export async function decryptSecretAesGcm(envelope: string, encryptionKey: string): Promise<string> {
  const parts = envelope.split(':');
  if (parts.length !== 4 || parts[0] !== 'enc' || parts[1] !== 'v1') {
    throw new Error('Invalid encrypted secret envelope format.');
  }
  const key = await importAesKeyFromSecret(encryptionKey);
  const iv = base64ToBytes(parts[2] ?? '');
  const cipherBytes = base64ToBytes(parts[3] ?? '');
  const plaintextBuffer = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as unknown as BufferSource },
    key,
    cipherBytes as unknown as BufferSource
  );
  return new TextDecoder().decode(plaintextBuffer);
}
