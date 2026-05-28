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

function ensureDir() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readDB(): DBSchema {
  ensureDir();
  if (!fs.existsSync(DB_PATH)) {
    return { users: [], quota_requests: [], audit_log: [] };
  }
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
}

function writeDB(data: DBSchema) {
  ensureDir();
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
    return readDB().quota_requests.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  },

  upsertQuotaRequest(record: any) {
    const data = readDB();
    const idx = data.quota_requests.findIndex(r => r.id === record.id);
    if (idx >= 0) {
      Object.assign(data.quota_requests[idx], record, { updated_at: new Date().toISOString() });
    } else {
      record.created_at = record.created_at || new Date().toISOString();
      record.updated_at = new Date().toISOString();
      data.quota_requests.push(record);
    }
    writeDB(data);
  },

  // Audit log
  addAuditLog(userId: number | null, action: string, detail: string) {
    const data = readDB();
    data.audit_log.push({ id: Date.now(), user_id: userId, action, detail, created_at: new Date().toISOString() });
    // Keep last 500 entries
    if (data.audit_log.length > 500) data.audit_log = data.audit_log.slice(-500);
    writeDB(data);
  },

  getAuditLog(limit = 100) {
    const data = readDB();
    return data.audit_log.slice(-limit).reverse();
  },
};
