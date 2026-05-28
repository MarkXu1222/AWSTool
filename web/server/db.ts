/**
 * Simple JSON file-based store — no native dependencies needed
 */
import fs from 'fs';
import path from 'path';

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/db.json');

interface DBSchema {
  users: any[];
  quota_requests: any[];
  audit_log: any[];
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
    cache = { users: [], quota_requests: [], audit_log: [] };
    cacheTime = Date.now();
    return cache;
  }
  try {
    cache = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
    cacheTime = Date.now();
    return cache!;
  } catch {
    cache = { users: [], quota_requests: [], audit_log: [] };
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

  // Quota requests
  getQuotaRequests() {
    const statusOrder: Record<string, number> = { CASE_OPENED: 0, PENDING: 1, APPROVED: 2, DENIED: 3, CASE_CLOSED: 4 };
    return readDB().quota_requests.sort((a, b) => {
      const sa = statusOrder[a.status] ?? 5;
      const sb = statusOrder[b.status] ?? 5;
      if (sa !== sb) return sa - sb;
      return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
    });
  },

  upsertQuotaRequest(record: any) {
    const data = readDB();
    const idx = data.quota_requests.findIndex(r => r.id === record.id);
    if (idx >= 0) {
      // Update all fields including created_at if provided by AWS
      const existing = data.quota_requests[idx];
      Object.assign(existing, record);
      existing.updated_at = new Date().toISOString();
    } else {
      record.created_at = record.created_at || new Date().toISOString();
      record.updated_at = new Date().toISOString();
      data.quota_requests.push(record);
    }
    writeDB(data);
  },

  // Audit log
  addAuditLog(userId: number | null, action: string, detail: string, username?: string) {
    const data = readDB();
    data.audit_log.push({ id: Date.now(), user_id: userId, username: username || null, action, detail, created_at: new Date().toISOString() });
    if (data.audit_log.length > 500) data.audit_log = data.audit_log.slice(-500);
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
    return readDB().users.map(u => ({ id: u.id, username: u.username, role: u.role, mfa_enabled: u.mfa_enabled, created_at: u.created_at }));
  },

  deleteUser(id: number) {
    const data = readDB();
    data.users = data.users.filter(u => u.id !== id);
    writeDB(data);
  },
};
