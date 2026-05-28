import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

const STORE_FILE = path.join(app.getPath('userData'), 'aws-toolbox-config.enc');
const ENCRYPTION_KEY = crypto.createHash('sha256').update('aws-toolbox-v1-key').digest();
const IV_LENGTH = 16;

function encrypt(text: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

function decrypt(text: string): string {
  const parts = text.split(':');
  const iv = Buffer.from(parts.shift()!, 'hex');
  const encrypted = parts.join(':');
  const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

export function storeGet(key: string): any {
  try {
    if (!fs.existsSync(STORE_FILE)) return undefined;
    const raw = fs.readFileSync(STORE_FILE, 'utf8');
    const data = JSON.parse(decrypt(raw));
    return data[key];
  } catch {
    return undefined;
  }
}

export function storeSet(key: string, value: any): void {
  let data: Record<string, any> = {};
  try {
    if (fs.existsSync(STORE_FILE)) {
      const raw = fs.readFileSync(STORE_FILE, 'utf8');
      data = JSON.parse(decrypt(raw));
    }
  } catch {
    data = {};
  }
  data[key] = value;
  fs.writeFileSync(STORE_FILE, encrypt(JSON.stringify(data)), 'utf8');
}

export function storeDelete(key: string): void {
  try {
    if (!fs.existsSync(STORE_FILE)) return;
    const raw = fs.readFileSync(STORE_FILE, 'utf8');
    const data = JSON.parse(decrypt(raw));
    delete data[key];
    fs.writeFileSync(STORE_FILE, encrypt(JSON.stringify(data)), 'utf8');
  } catch {
    // ignore
  }
}
