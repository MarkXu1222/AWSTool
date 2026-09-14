import { createCipheriv, createDecipheriv, randomBytes, randomInt } from 'crypto';
import { deriveEncryptionKey } from './db';

export const ROOT_PASSWORD_LENGTH = 24;
export const ROOT_CREDENTIAL_TTL_MS = 30 * 60_000;

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
const FORMAT = 'gcm1';

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

function aad(context: RootPasswordContext): Buffer {
  if (!/^[0-9a-f-]{36}$/i.test(context.jobId) || !/^\d{12}$/.test(context.accountId)
    || !/^\d+$/.test(context.createdByUserId)) throw new Error('Root 密码密文上下文无效');
  return Buffer.from(`awstool:root-password:v1:${context.jobId}:${context.accountId}:${context.createdByUserId}`, 'utf8');
}

/** Fail closed before any recovery email is sent if temporary credential encryption is unavailable. */
export function assertRootPasswordEncryptionReady(): void {
  deriveEncryptionKey('root-password');
}

/** Encrypt a temporary Root password with authenticated encryption and task-bound AAD. */
export function encryptRootPassword(password: string, context: RootPasswordContext): string {
  if (password.length !== ROOT_PASSWORD_LENGTH) throw new Error('Root 密码长度无效');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveEncryptionKey('root-password'), iv);
  cipher.setAAD(aad(context));
  const ciphertext = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
  return [FORMAT, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join(':');
}

/** Decrypt only after GCM authentication and task-bound AAD validation succeed. */
export function decryptRootPassword(value: string, context: RootPasswordContext): string {
  const [format, ivValue, tagValue, ciphertextValue, extra] = value.split(':');
  if (format !== FORMAT || !ivValue || !tagValue || !ciphertextValue || extra !== undefined) {
    throw new Error('Root 密码密文格式无效');
  }
  const iv = Buffer.from(ivValue, 'base64url');
  const tag = Buffer.from(tagValue, 'base64url');
  const ciphertext = Buffer.from(ciphertextValue, 'base64url');
  if (iv.length !== 12 || tag.length !== 16 || !ciphertext.length) throw new Error('Root 密码密文参数无效');
  const decipher = createDecipheriv('aes-256-gcm', deriveEncryptionKey('root-password'), iv);
  decipher.setAAD(aad(context));
  decipher.setAuthTag(tag);
  const password = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  if (password.length !== ROOT_PASSWORD_LENGTH) throw new Error('Root 密码明文校验失败');
  return password;
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
