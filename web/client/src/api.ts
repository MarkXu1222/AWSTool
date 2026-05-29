/**
 * HTTP API client — replaces Electron IPC calls
 */

import { cacheGet, cacheSet } from './utils/cache';

const BASE = '/api';

function getToken(): string | null {
  return localStorage.getItem('token');
}

async function request(path: string, options: RequestInit = {}) {
  const token = getToken();
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });

  // Only redirect on 401 for non-auth routes
  if (res.status === 401 && !path.startsWith('/auth/')) {
    localStorage.removeItem('token');
    window.location.href = '/';
    throw new Error('Session expired');
  }

  return res.json();
}

export const api = {
  // Auth
  login: async (username: string, password: string, totpCode?: string) => {
    const res = await request('/auth/login', { method: 'POST', body: JSON.stringify({ username, password, totpCode }) });
    if (res.token) {
      localStorage.setItem('mfaEnabled', res.mfaEnabled ? 'true' : 'false');
    }
    return res;
  },
  me: () => request('/auth/me'),
  setupMFA: () => request('/auth/mfa/setup', { method: 'POST' }),
  confirmMFA: (secret: string, code: string) =>
    request('/auth/mfa/confirm', { method: 'POST', body: JSON.stringify({ secret, code }) }),

  // AWS
  testConnection: () => request('/aws/connection'),
  listAccounts: async () => {
    const cached = cacheGet('accounts');
    if (cached) return cached;
    const res = await request('/aws/accounts');
    if (res.success) cacheSet('accounts', res, 5 * 60 * 1000); // 5 min cache
    return res;
  },
  getAccountDetail: (id: string) => request(`/aws/accounts/${id}/detail`),
  getCostByAccount: (start: string, end: string) => request(`/aws/billing/by-account?start=${start}&end=${end}`),
  getCostByService: (accountId: string, start: string, end: string) => request(`/aws/billing/by-service/${accountId}?start=${start}&end=${end}`),
  listServiceQuotas: (accountId: string, serviceCode: string, region?: string) =>
    request(`/aws/quotas/${accountId}/${serviceCode}?region=${region || ''}`),
  requestQuotaIncrease: (accountId: string, serviceCode: string, quotaCode: string, desiredValue: number, quotaName?: string, region?: string) =>
    request('/aws/quotas/increase', { method: 'POST', body: JSON.stringify({ accountId, serviceCode, quotaCode, desiredValue, quotaName, region }) }),
  listQuotaRequests: () => request('/aws/quotas/requests'),
  syncQuotaRequests: (accountIds: string[]) =>
    request('/aws/quotas/sync', { method: 'POST', body: JSON.stringify({ accountIds }) }),
  syncSingleAccount: (accountId: string) =>
    request(`/aws/quotas/sync-account/${accountId}`, { method: 'POST' }),
  getSyncStatus: () => request('/aws/quotas/sync-status'),
  // Streaming sync — returns EventSource for real-time progress
  startStreamSync: (onProgress: (data: any) => void, onDone: (data: any) => void, onError?: (err: any) => void) => {
    const token = getToken();
    const es = new EventSource(`${BASE}/aws/quotas/sync-stream?token=${token}`);
    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'progress') onProgress(data);
        else if (data.type === 'done') { onDone(data); es.close(); }
        else if (data.type === 'error') { if (onError) onError(data); es.close(); }
        else if (data.type === 'start') onProgress(data);
      } catch {}
    };
    es.onerror = () => { if (onError) onError({ message: 'Connection lost' }); es.close(); };
    return es;
  },
  scanResources: (accountId: string, region: string) => request(`/aws/resources/${accountId}/${region}`),
  getAuditLog: () => request('/aws/audit'),
  // Regions
  getRegionStatus: () => request('/regions/status'),
  scanRegions: (accountIds?: string[]) => request('/regions/scan', { method: 'POST', body: JSON.stringify({ accountIds }) }),
  scanAccountRegions: (accountId: string) => request(`/regions/scan/${accountId}`, { method: 'POST' }),
  enableRegion: (accountId: string, region: string) => request('/regions/enable', { method: 'POST', body: JSON.stringify({ accountId, region }) }),
  enableRegionBatch: (accountIds: string[], region: string) => request('/regions/enable-batch', { method: 'POST', body: JSON.stringify({ accountIds, region }) }),
  getRootCredentials: (accountId: string) => request(`/aws/root-credentials/${accountId}`),
  changePassword: (currentPassword: string, newPassword: string) =>
    request('/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) }),
  // User management
  listUsers: () => request('/auth/users'),
  createUser: (username: string, password: string, role: string) =>
    request('/auth/users', { method: 'POST', body: JSON.stringify({ username, password, role }) }),
  deleteUser: (id: number) => request(`/auth/users/${id}`, { method: 'DELETE' }),
  resetUserPassword: (id: number, newPassword: string) =>
    request(`/auth/users/${id}/reset-password`, { method: 'POST', body: JSON.stringify({ newPassword }) }),
};
