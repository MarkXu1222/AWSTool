/**
 * HTTP API client — replaces Electron IPC calls
 */

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
  listAccounts: () => request('/aws/accounts'),
  getAccountDetail: (id: string) => request(`/aws/accounts/${id}/detail`),
  getCostByAccount: (start: string, end: string) => request(`/aws/billing/by-account?start=${start}&end=${end}`),
  getCostByService: (accountId: string, start: string, end: string) => request(`/aws/billing/by-service/${accountId}?start=${start}&end=${end}`),
  listServiceQuotas: (accountId: string, serviceCode: string, region?: string) =>
    request(`/aws/quotas/${accountId}/${serviceCode}?region=${region || ''}`),
  requestQuotaIncrease: (accountId: string, serviceCode: string, quotaCode: string, desiredValue: number, quotaName?: string) =>
    request('/aws/quotas/increase', { method: 'POST', body: JSON.stringify({ accountId, serviceCode, quotaCode, desiredValue, quotaName }) }),
  listQuotaRequests: () => request('/aws/quotas/requests'),
  syncQuotaRequests: (accountIds: string[]) =>
    request('/aws/quotas/sync', { method: 'POST', body: JSON.stringify({ accountIds }) }),
  scanResources: (accountId: string, region: string) => request(`/aws/resources/${accountId}/${region}`),
  getAuditLog: () => request('/aws/audit'),
};
