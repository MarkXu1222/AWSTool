import { createCipheriv, createDecipheriv, randomBytes, randomInt } from 'crypto';
import { deriveEncryptionKeyring, type DerivedEncryptionKey } from './db';

export const ROOT_PASSWORD_LENGTH = 24;

export interface RootPasswordContext {
  jobId: string;
  accountId: string;
  createdByUserId: string;
}

const UPPERCASE = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWERCASE = 'abcdefghijkmnopqrstuvwxyz';
const DIGITS = '23456789';
const SYMBOLS = '!@#$%^&*()-_=+';
const ALL_CHARACTERS = `${UPPERCASE}${LOWERCASE}${DIGITS}${SYMBOLS}`;
const CURRENT_FORMAT = 'gcm2';
const LEGACY_FORMAT = 'gcm1';
const KEY_ID_PATTERN = /^[0-9a-f]{16}$/;

function pick(characters: string): string {
  return characters[randomInt(0, characters.length)];
}

/** Generate a 24-character CSPRNG password containing every required character class. */
export function generateRootPassword(): string {
  // Keep the first character alphabetic so spreadsheet software cannot interpret the password as a formula.
  const characters = [pick(UPPERCASE), pick(LOWERCASE), pick(DIGITS), pick(SYMBOLS)];
  while (characters.length < ROOT_PASSWORD_LENGTH) characters.push(pick(ALL_CHARACTERS));
  for (let index = characters.length - 1; index > 1; index--) {
    const target = randomInt(1, index + 1);
    [characters[index], characters[target]] = [characters[target], characters[index]];
  }
  return characters.join('');
}

function validateContext(context: RootPasswordContext): void {
  if (!/^[0-9a-f-]{36}$/i.test(context.jobId) || !/^\d{12}$/.test(context.accountId)
    || !/^\d+$/.test(context.createdByUserId)) throw new Error('Root 密码密文上下文无效');
}

function legacyAad(context: RootPasswordContext): Buffer {
  validateContext(context);
  return Buffer.from(`awstool:root-password:v1:${context.jobId}:${context.accountId}:${context.createdByUserId}`, 'utf8');
}

function currentAad(context: RootPasswordContext, keyId: string): Buffer {
  validateContext(context);
  return Buffer.from(`awstool:root-password:v2:${keyId}:${context.jobId}:${context.accountId}:${context.createdByUserId}`, 'utf8');
}

function validateKeyring(keys: readonly DerivedEncryptionKey[]): void {
  if (!keys.length || keys.some(item => !KEY_ID_PATTERN.test(item.keyId) || item.key.length !== 32)
    || new Set(keys.map(item => item.keyId)).size !== keys.length) {
    throw new Error('Root 密码加密密钥环无效');
  }
}

function decodeCiphertext(ivValue: string, tagValue: string, ciphertextValue: string) {
  const iv = Buffer.from(ivValue, 'base64url');
  const tag = Buffer.from(tagValue, 'base64url');
  const ciphertext = Buffer.from(ciphertextValue, 'base64url');
  if (iv.length !== 12 || tag.length !== 16 || !ciphertext.length) throw new Error('Root 密码密文参数无效');
  return { iv, tag, ciphertext };
}

function decryptWithKey(
  key: Buffer,
  values: ReturnType<typeof decodeCiphertext>,
  authenticatedData: Buffer,
): string {
  const decipher = createDecipheriv('aes-256-gcm', key, values.iv);
  decipher.setAAD(authenticatedData);
  decipher.setAuthTag(values.tag);
  const password = Buffer.concat([decipher.update(values.ciphertext), decipher.final()]).toString('utf8');
  if (password.length !== ROOT_PASSWORD_LENGTH) throw new Error('Root 密码明文校验失败');
  return password;
}

/** Fail closed before any recovery email is sent if the permanent credential keyring is unavailable. */
export function assertRootPasswordEncryptionReady(): void {
  const keys = deriveEncryptionKeyring('root-password');
  validateKeyring(keys);
}

/** Encrypt a permanent Root password with the current key ID and task-bound authenticated data. */
export function encryptRootPassword(
  password: string,
  context: RootPasswordContext,
  keys: readonly DerivedEncryptionKey[] = deriveEncryptionKeyring('root-password'),
): string {
  if (password.length !== ROOT_PASSWORD_LENGTH) throw new Error('Root 密码长度无效');
  validateKeyring(keys);
  const current = keys[0];
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', current.key, iv);
  cipher.setAAD(currentAad(context, current.keyId));
  const ciphertext = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
  return [CURRENT_FORMAT, current.keyId, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url')].join(':');
}

/** Decrypt gcm2 by key ID, or authenticate legacy gcm1 against the configured rotation keyring. */
export function decryptRootPassword(
  value: string,
  context: RootPasswordContext,
  keys: readonly DerivedEncryptionKey[] = deriveEncryptionKeyring('root-password'),
): string {
  validateKeyring(keys);
  const parts = value.split(':');
  if (parts[0] === CURRENT_FORMAT) {
    const [format, keyId, ivValue, tagValue, ciphertextValue, extra] = parts;
    if (format !== CURRENT_FORMAT || !KEY_ID_PATTERN.test(keyId) || !ivValue || !tagValue || !ciphertextValue
      || extra !== undefined) throw new Error('Root 密码密文格式无效');
    const selected = keys.find(item => item.keyId === keyId);
    if (!selected) throw new Error(`Root 密码密文引用未配置的 key ID: ${keyId}`);
    const values = decodeCiphertext(ivValue, tagValue, ciphertextValue);
    try {
      return decryptWithKey(selected.key, values, currentAad(context, keyId));
    } catch {
      throw new Error('Root 密码密文认证失败');
    }
  }

  const [format, ivValue, tagValue, ciphertextValue, extra] = parts;
  if (format !== LEGACY_FORMAT || !ivValue || !tagValue || !ciphertextValue || extra !== undefined) {
    throw new Error('Root 密码密文格式无效');
  }
  const values = decodeCiphertext(ivValue, tagValue, ciphertextValue);
  const authenticatedData = legacyAad(context);
  for (const candidate of keys) {
    try { return decryptWithKey(candidate.key, values, authenticatedData); }
    catch { /* gcm1 has no key ID; GCM authentication safely selects the matching historical key. */ }
  }
  throw new Error('Root 密码旧版密文无法使用当前密钥环解密');
}

/** Re-encrypt an authenticated Root password with the current key while preserving its task-bound context. */
export function reencryptRootPassword(
  value: string,
  context: RootPasswordContext,
  keys: readonly DerivedEncryptionKey[] = deriveEncryptionKeyring('root-password'),
): string {
  validateKeyring(keys);
  const password = decryptRootPassword(value, context, keys);
  const parts = value.split(':');
  if (parts.length === 5 && parts[0] === CURRENT_FORMAT && parts[1] === keys[0].keyId) return value;
  return encryptRootPassword(password, context, keys);
}

function csvCell(value: string): string {
  // Root emails beginning with a formula marker are neutralized; generated passwords always begin with a letter.
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function buildRootCredentialCsv(rows: Array<{ accountId: string; email: string; password: string }>): Buffer {
  const lines = [
    ['AWS Account ID', 'Root Email', 'New Root Password'],
    ...rows.map(row => [row.accountId, row.email, row.password]),
  ];
  return Buffer.from(`\uFEFF${lines.map(row => row.map(csvCell).join(',')).join('\r\n')}\r\n`, 'utf8');
}
