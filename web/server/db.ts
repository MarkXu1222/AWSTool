/**
 * Simple JSON file-based store — no native dependencies needed
 */
import fs from 'fs';
import path from 'path';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto';

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/db.json');

// Encryption key for sensitive fields (MFA secrets) — independent from JWT
let ENC_KEY: Buffer;
try {
  const configPath = path.join(__dirname, '../../config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  const source = config.web?.encryptionKey  // Dedicated key (preferred)
    || process.env.ENCRYPTION_KEY
    || config.web?.jwtSecret                // Fallback for backward compat
    || 'default-fallback-key-32chars-xxx';
  ENC_KEY = createHash('sha256').update(source).digest();
} catch {
  ENC_KEY = createHash('sha256').update('default-fallback-key-32chars-xxx').digest();
}

export function encryptField(text: string): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', ENC_KEY, iv);
  return iv.toString('hex') + ':' + cipher.update(text, 'utf8', 'hex') + cipher.final('hex');
}

export function decryptField(data: string): string {
  try {
    const [ivHex, encrypted] = data.split(':');
    if (!ivHex || !encrypted) return data; // Not encrypted, return as-is (migration)
    const decipher = createDecipheriv('aes-256-cbc', ENC_KEY, Buffer.from(ivHex, 'hex'));
    return decipher.update(encrypted, 'hex', 'utf8') + decipher.final('utf8');
  } catch {
    return data; // Return raw if decryption fails (not yet encrypted)
  }
}

interface DBSchema {
  users: any[];
  quota_requests: any[];
  audit_log: any[];
  region_data: any[];
  accounts_cache: any[];
  accounts_cache_time: string;
}

// In-memory cache to avoid reading file on every request
let cache: DBSchema | null = null;
let cacheTime = 0;

function ensureDir() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readDB(): DBSchema {
  // Return cache if written within last 5 seconds (same process)
  if (cache && Date.now() - cacheTime < 5000) return cache;

  ensureDir();
  if (!fs.existsSync(DB_PATH)) {
    cache = { users: [], quota_requests: [], audit_log: [], region_data: [], accounts_cache: [], accounts_cache_time: '' };
    cacheTime = Date.now();
    return cache;
  }
  try {
    cache = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
    if (!cache!.accounts_cache) cache!.accounts_cache = [];
    if (!cache!.accounts_cache_time) cache!.accounts_cache_time = '';
    cacheTime = Date.now();
    return cache!;
  } catch {
    cache = { users: [], quota_requests: [], audit_log: [], region_data: [], accounts_cache: [], accounts_cache_time: '' };
    cacheTime = Date.now();
    return cache;
  }
}

function writeDB(data: DBSchema) {
  ensureDir();
  cache = data;
  cacheTime = Date.now();
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

// === Auto-backup: keep a daily rotating copy of the DB ===
let lastBackupDay = '';
export function backupDB() {
  try {
    if (!fs.existsSync(DB_PATH)) return;
    const dir = path.join(path.dirname(DB_PATH), 'backups');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const dest = path.join(dir, `db-${today}.json`);
    fs.copyFileSync(DB_PATH, dest);
    // Keep only last 7 daily backups
    const files = fs.readdirSync(dir).filter(f => f.startsWith('db-') && f.endsWith('.json')).sort();
    while (files.length > 7) {
      const old = files.shift();
      if (old) fs.unlinkSync(path.join(dir, old));
    }
    lastBackupDay = today;
  } catch (e: any) {
    console.error('[DB Backup] failed:', e.message);
  }
}

// Run backup at most once per day, triggered on read
export function maybeBackup() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== lastBackupDay) backupDB();
}

// === Query helpers (simple) ===

export const db = {
  getUser(username: string) {
    const data = readDB();
    return data.users.find(u => u.username === username) || null;
  },

  createUser(user: any) {
    const data = readDB();
    user.id = Date.now();
    user.created_at = new Date().toISOString();
    data.users.push(user);
    writeDB(data);
    return user;
  },

  updateUser(id: number, updates: any) {
    const data = readDB();
    const idx = data.users.findIndex(u => u.id === id);
    if (idx >= 0) { Object.assign(data.users[idx], updates); writeDB(data); }
  },

  // Quota requests — sorted by created_at descending (newest first)
  getQuotaRequests() {
    return readDB().quota_requests.sort((a, b) => {
      return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
    });
  },

  upsertQuotaRequest(record: any) {
    const data = readDB();
    const idx = data.quota_requests.findIndex(r => r.id === record.id);
    if (idx >= 0) {
      // Update fields but don't overwrite current_value with null
      const existing = data.quota_requests[idx];
      for (const [key, value] of Object.entries(record)) {
        if (key === 'current_value' && (value === null || value === undefined)) continue; // Don't overwrite with null
        (existing as any)[key] = value;
      }
      existing.updated_at = new Date().toISOString();
    } else {
      record.created_at = record.created_at || new Date().toISOString();
      record.updated_at = new Date().toISOString();
      data.quota_requests.push(record);
    }
    writeDB(data);
  },

  // Audit log
  addAuditLog(
    userId: number | null,
    action: string,
    detail: string,
    username?: string,
    ip?: string,
    extras?: { method?: string; path?: string; status?: number; duration_ms?: number; params?: any },
  ) {
    const data = readDB();
    const cleanIp = ip ? ip.replace('::ffff:', '') : null;
    const lastAuditId = data.audit_log.reduce(
      (max, log) => Math.max(max, Number(log.id) || 0),
      0,
    );
    const auditId = Math.max(Date.now(), lastAuditId + 1);
    const entry: any = {
      id: auditId,
      user_id: userId,
      username: username || null,
      action,
      detail,
      ip: cleanIp,
      created_at: new Date().toISOString(),
    };
    if (extras) {
      if (extras.method !== undefined) entry.method = extras.method;
      if (extras.path !== undefined) entry.path = extras.path;
      if (extras.status !== undefined) entry.status = extras.status;
      if (extras.duration_ms !== undefined) entry.duration_ms = extras.duration_ms;
      if (extras.params !== undefined) entry.params = extras.params;
    }
    data.audit_log.push(entry);
    if (data.audit_log.length > 5000) data.audit_log = data.audit_log.slice(-5000);
    writeDB(data);
  },

  getAuditLog(limit = 100) {
    const data = readDB();
    const logs = data.audit_log.slice(-limit).reverse();
    // Resolve usernames
    return logs.map(log => {
      if (!log.username && log.user_id) {
        const user = data.users.find(u => u.id === log.user_id);
        log.username = user?.username || 'unknown';
      }
      return log;
    });
  },

  // User management
  getAllUsers() {
    return readDB().users.map(u => ({
      id: u.id,
      username: u.username,
      role: u.role,
      mfa_enabled: u.mfa_enabled,
      allowed_pages: (u as any).allowed_pages ?? null,
      root_access: (u as any).root_access === true,
      bulk_quota_access: (u as any).bulk_quota_access === true,
      created_at: u.created_at,
    }));
  },

  deleteUser(id: number) {
    const data = readDB();
    data.users = data.users.filter(u => u.id !== id);
    writeDB(data);
  },

  // Accounts cache — for instant loading
  getAccountsCache() {
    const data = readDB();
    return { accounts: data.accounts_cache || [], cachedAt: data.accounts_cache_time || '' };
  },

  setAccountsCache(accounts: any[]) {
    const data = readDB();
    data.accounts_cache = accounts;
    data.accounts_cache_time = new Date().toISOString();
    writeDB(data);
  },

  // Dashboard cache — cost summary for instant loading
  getDashboardCache() {
    const data = readDB() as any;
    return data.dashboard_cache || null;
  },

  setDashboardCache(summary: any) {
    const data = readDB() as any;
    data.dashboard_cache = { ...summary, cachedAt: new Date().toISOString() };
    writeDB(data);
  },

  // Region data
  getRegionData() {
    const data = readDB();
    return data.region_data || [];
  },

  // 账户角色自愈状态 —— 记录每个账户的 support-quota / admin-console 可用性
  getAccountRoles(): any[] {
    const data = readDB() as any;
    return data.account_roles || [];
  },

  upsertAccountRole(record: any) {
    db.upsertAccountRoles([record]);
  },

  // 批量写入 —— 单条写会让每个账户都 stringify 一遍整个 db，几千账户时无法接受
  upsertAccountRoles(records: any[]) {
    if (!records?.length) return;
    const data = readDB() as any;
    if (!data.account_roles) data.account_roles = [];
    const idxMap = new Map<string, number>();
    data.account_roles.forEach((r: any, i: number) => idxMap.set(r.account_id, i));
    for (const rec of records) {
      const i = idxMap.get(rec.account_id);
      if (i !== undefined) data.account_roles[i] = { ...data.account_roles[i], ...rec };
      else {
        idxMap.set(rec.account_id, data.account_roles.length);
        data.account_roles.push(rec);
      }
    }
    writeDB(data);
  },

  upsertRegionData(accountId: string, regions: { region: string; status: string }[]) {
    const data = readDB();
    if (!data.region_data) data.region_data = [];
    const idx = data.region_data.findIndex((r: any) => r.account_id === accountId);
    if (idx >= 0) {
      const existing = data.region_data[idx];
      for (const r of regions) {
        const ri = (existing.regions || []).findIndex((er: any) => er.region === r.region);
        if (ri >= 0) existing.regions[ri] = r;
        else existing.regions.push(r);
      }
      existing.updated_at = new Date().toISOString();
    } else {
      data.region_data.push({ account_id: accountId, regions, updated_at: new Date().toISOString() });
    }
    writeDB(data);
  },
};

// Migration: encrypt any plaintext MFA secrets on startup
export function migrateEncryptMFASecrets() {
  const data = readDB();
  let changed = false;
  for (const user of data.users) {
    if (user.mfa_secret && !user.mfa_secret.includes(':')) {
      user.mfa_secret = encryptField(user.mfa_secret);
      changed = true;
      console.log(`✅ Migrated MFA secret for user: ${user.username}`);
    }
  }
  if (changed) writeDB(data);
}
