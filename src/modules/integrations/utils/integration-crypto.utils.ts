import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';

function getEncryptionKey(): Buffer {
  const rawSecret =
    process.env.ZOTERO_ENCRYPTION_KEY ||
    process.env.ENCRYPTION_SECRET ||
    'flux-default-vault-secure-token-encryption-key-32b';
  return createHash('sha256').update(rawSecret).digest();
}

/**
 * Encrypts a sensitive string using AES-256-GCM.
 * Output format: "ivHex:authTagHex:ciphertextHex"
 */
export function encryptToken(plaintext: string): string {
  if (!plaintext) {
    throw new Error('Plaintext cannot be empty');
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, getEncryptionKey(), iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

/**
 * Decrypts an encrypted payload formatted as "ivHex:authTagHex:ciphertextHex".
 */
export function decryptToken(cipherPayload: string): string {
  if (!cipherPayload) {
    throw new Error('Cipher payload cannot be empty');
  }
  const parts = cipherPayload.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid cipher payload format; expected iv:authTag:ciphertext');
  }

  const [ivHex, authTagHex, encryptedHex] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');

  const decipher = createDecipheriv(ALGORITHM, getEncryptionKey(), iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}
