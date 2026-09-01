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

export type CleanupResourceType = 'EC2' | 'EBS' | 'S3' | 'Lambda' | 'IAMUser';
export type CleanupTimeBasis = 'launchTime' | 'createTime' | 'creationDate' | 'lastModified';

export interface CleanupIamDetails {
  username: string;
  userId: string;
  arn: string;
  path: string;
  createDate: string;
  passwordEnabled: boolean;
  passwordLastUsed?: string;
  accessKeys: { id: string; status: string; createDate?: string }[];
  mfaDevices: { serialNumber: string; enableDate?: string }[];
  groups: string[];
  attachedPolicies: { name: string; arn: string }[];
  inlinePolicies: string[];
  permissionsBoundary?: string;
  dependencies: Record<string, number>;
}

export interface CleanupResource {
  key: string;
  type: CleanupResourceType;
  id: string;
  name: string;
  arn: string;
  details: string;
  eventTime: string;
  timeBasis: CleanupTimeBasis;
  scope: 'regional' | 'global';
  deletable: boolean;
  iamDetails?: CleanupIamDetails;
}

export interface CleanupScanResult {
  resources: CleanupResource[];
  warnings: string[];
  cutoff: string;
  windowDays: number;
}

export interface CleanupDeleteInput {
  type: Exclude<CleanupResourceType, 'S3'>;
  id: string;
  name?: string;
}

export interface CleanupDeleteResult {
  id: string;
  type: CleanupResourceType;
  name?: string;
  ok: boolean;
  error?: string;
  alreadyAbsent?: boolean;
  iamCleanup?: Record<string, number>;
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
    if (res.success) cacheSet('accounts', res, 60 * 1000); // 1 min client cache
    return res;
  },
  refreshAccounts: () => request('/aws/accounts/refresh', { method: 'POST' }),
  getAccountDetail: (id: string) => request(`/aws/accounts/${id}/detail`),
  // 敏感权限客户账户：收窄平台权限 + ExternalId
  getRestrictedAccounts: () => request('/aws/accounts/restricted'),
  markRestrictedAccounts: (accountIds: string[], note?: string) =>
    request('/aws/accounts/restricted', { method: 'POST', body: JSON.stringify({ accountIds, note }) }),
  unmarkRestrictedAccount: (accountId: string) =>
    request(`/aws/accounts/restricted/${accountId}`, { method: 'DELETE' }),
  getAccountExternalId: (accountId: string) => request(`/aws/accounts/restricted/${accountId}/external-id`),
  // 离场账户：已移出组织的账户记录
  getDepartedAccounts: () => request('/aws/accounts/departed'),
  backfillDepartedAccounts: () => request('/aws/accounts/departed/backfill', { method: 'POST' }),
  // 账户角色自愈：状态查询 + 手动触发检测/补齐
  getAccountRolesStatus: () => request('/aws/accounts/roles-status'),
  checkAccountRoles: (params?: { full?: boolean; accountIds?: string[]; probeOnly?: boolean }) =>
    request('/aws/accounts/roles-check', { method: 'POST', body: JSON.stringify(params || {}) }),
  getCostByAccount: (start: string, end: string) => request(`/aws/billing/by-account?start=${start}&end=${end}`),
  getCostByService: (accountId: string, start: string, end: string) => request(`/aws/billing/by-service/${accountId}?start=${start}&end=${end}`),
  // 账单分析：按服务 + 区域两个维度汇总（资源清理第一步）
  getBillingBreakdown: (accountId: string, start: string, end: string) => request(`/aws/billing/breakdown/${accountId}?start=${start}&end=${end}`),
  listServiceQuotas: (accountId: string, serviceCode: string, region?: string) =>
    request(`/aws/quotas/${accountId}/${serviceCode}?region=${region || ''}`),
  // 批量 payer 提额（需独立的批量提额权限）
  bulkQuotaPayers: () => request('/aws/bulk-quota/payers'),
  bulkQuotaAccounts: (payerAccountId: string) => request(`/aws/bulk-quota/accounts/${payerAccountId}`),
  // 只需传配额名 + 目标值，QuotaCode 由后端解析；已达标账户后端会自动跳过
  bulkQuotaSubmit: (body: { payerAccountId: string; regions: string[]; serviceCode: string; quotaName: string; desiredValue: number; scope: string }) =>
    request('/aws/bulk-quota/submit', { method: 'POST', body: JSON.stringify(body) }),
  bulkQuotaJob: (jobId: string) => request(`/aws/bulk-quota/job/${jobId}`),

  // Bedrock 配额（TPM/RPM/TPD），可一次查询多个区域
  getBedrockQuotas: (accountId: string, regions: string[]) =>
    request(`/aws/bedrock/quotas/${accountId}?regions=${encodeURIComponent(regions.join(','))}`),

  requestQuotaIncrease: (accountId: string, serviceCode: string, quotaCode: string, desiredValue: number, quotaName?: string, region?: string) =>
    request('/aws/quotas/increase', { method: 'POST', body: JSON.stringify({ accountId, serviceCode, quotaCode, desiredValue, quotaName, region }) }),
  listQuotaRequests: () => request('/aws/quotas/requests'),
  getQuotaStats: () => request('/aws/quotas/stats'),
  getDashboardSummary: () => request('/aws/dashboard/summary'),
  // 免登录控制台链接。access: 'support'(默认,只读) | 'admin'(完整管理员,需 root 权限)
  getConsoleUrl: (accountId: string, opts?: { caseId?: string; access?: 'support' | 'admin' }) => {
    const params = new URLSearchParams();
    if (opts?.caseId) params.set('caseId', opts.caseId);
    if (opts?.access) params.set('access', opts.access);
    const qs = params.toString();
    return request(`/aws/console-url/${accountId}${qs ? `?${qs}` : ''}`);
  },
  // List company profiles (for manual doc-generation UI)
  listCompanies: () => request('/aws/quotas/companies'),
  // Batch export AWS Console Billing → Bills PDFs, returns a zip
  exportBillingInvoices: async (params: { accountIds: string[]; months: string[]; concurrency?: number }) => {
    const token = getToken();
    const res = await fetch(`${BASE}/aws/billing/export-invoices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(params),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: '导出失败' }));
      throw new Error(err.error || '导出失败');
    }
    const summary = res.headers.get('X-Export-Summary') || '';
    const disposition = res.headers.get('Content-Disposition') || '';
    const match = disposition.match(/filename="(.+)"/);
    const filename = match ? match[1] : 'billing-invoices.zip';
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
    return summary;
  },
  // Generate quota increase PDF document — downloads the file
  generateQuotaDoc: async (params: { accountId?: string; accountName?: string; companyKey?: string; serviceCode: string; quotaName: string; region: string; requestedValue: number; currentValue?: number }) => {
    const token = getToken();
    const res = await fetch(`${BASE}/aws/quotas/generate-doc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(params),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: '生成失败' }));
      throw new Error(err.error || '生成失败');
    }
    const blob = await res.blob();
    const disposition = res.headers.get('Content-Disposition') || '';
    const match = disposition.match(/filename="(.+)"/);
    const filename = match ? match[1] : 'quota-doc.pdf';
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  },
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
  scanResources: (accountId: string, region: string) =>
    request(`/aws/resources/${encodeURIComponent(accountId)}/${encodeURIComponent(region)}`),
  deleteResources: (accountId: string, region: string, resources: CleanupDeleteInput[]) =>
    request(`/aws/resources/${encodeURIComponent(accountId)}/delete`, {
      method: 'POST',
      body: JSON.stringify({ region, resources }),
    }),
  getAuditLog: (limit = 5000) => request(`/aws/audit?limit=${Math.max(1, Math.min(5000, Math.floor(limit)))}`),
  // MAP 标签合规
  tagStatus: () => request('/aws/tag-compliance/status'),
  // 全自动组织接入：提交持久化任务、查询进度、按 payer 恢复、失败重试
  tagStartOnboarding: (payerAccountId: string, tagValue: string) =>
    request('/aws/tag-compliance/onboarding', { method: 'POST', body: JSON.stringify({ payerAccountId, tagValue }) }),
  tagOnboardingJob: (jobId: string) =>
    request(`/aws/tag-compliance/onboarding/${encodeURIComponent(jobId)}`),
  tagLatestOnboarding: (payerAccountId: string) =>
    request(`/aws/tag-compliance/onboarding?payer=${encodeURIComponent(payerAccountId)}`),
  tagRetryOnboarding: (jobId: string) =>
    request(`/aws/tag-compliance/onboarding/${encodeURIComponent(jobId)}/retry`, { method: 'POST' }),
  tagGetConfig: () => request('/aws/tag-compliance/config'),
  tagPutConfig: (orgs: any[], etag: string | null) =>
    request('/aws/tag-compliance/config', { method: 'PUT', body: JSON.stringify({ orgs, etag }) }),
  tagScan: () => request('/aws/tag-compliance/scan', {
    method: 'POST',
    body: JSON.stringify({ confirmation: 'TRIGGER_MAP_SCAN_WITH_CENTRAL_MODE' }),
  }),
  tagExecutions: () => request('/aws/tag-compliance/executions'),
  tagReport: () => request('/aws/tag-compliance/report'),
  tagPrecheck: (payer: string) => request(`/aws/tag-compliance/precheck?payer=${encodeURIComponent(payer)}`),
  // 报告通知邮箱（SNS 订阅）
  tagNotifyEmails: () => request('/aws/tag-compliance/notify-emails'),
  tagAddNotifyEmail: (email: string) =>
    request('/aws/tag-compliance/notify-emails', { method: 'POST', body: JSON.stringify({ email }) }),
  tagRemoveNotifyEmail: (subscriptionArn: string, endpoint?: string) =>
    request('/aws/tag-compliance/notify-emails', { method: 'DELETE', body: JSON.stringify({ subscriptionArn, endpoint }) }),
  // 一键接入：自动补齐该 payer 组织的前置资源
  tagProvision: (payerAccountId: string) =>
    request('/aws/tag-compliance/provision', { method: 'POST', body: JSON.stringify({ payerAccountId }) }),
  // Resource Explorer 索引：下发 StackSet（替代 Quick Setup）与查询进度
  tagDeployReIndexes: (payerAccountId: string, aggregatorRegion: string, localRegions: string[]) =>
    request('/aws/tag-compliance/re-indexes', { method: 'POST', body: JSON.stringify({ payerAccountId, aggregatorRegion, localRegions }) }),
  tagReIndexStatus: (payer: string) =>
    request(`/aws/tag-compliance/re-indexes/status?payer=${encodeURIComponent(payer)}`),
  tagEnabledRegions: (payer: string) =>
    request(`/aws/tag-compliance/enabled-regions?payer=${encodeURIComponent(payer)}`),
  exportAuditLog: async (format: 'csv' | 'json') => {
    const token = getToken();
    const res = await fetch(`${BASE}/aws/audit/export?format=${format}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (res.status === 401) {
      localStorage.removeItem('token');
      window.location.href = '/';
      throw new Error('登录已过期');
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: '导出审计日志失败' }));
      throw new Error(err.error || '导出审计日志失败');
    }

    const disposition = res.headers.get('Content-Disposition') || '';
    const filenameMatch = disposition.match(/filename="?([^";]+)"?/i);
    const filename = filenameMatch?.[1] || `audit-logs.${format}`;
    const exportedCount = Number(res.headers.get('X-Export-Count') || 0);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    return exportedCount;
  },
  // Regions
  getRegionStatus: () => request('/regions/status'),
  scanRegions: (accountIds?: string[]) => request('/regions/scan', { method: 'POST', body: JSON.stringify({ accountIds }) }),
  scanAccountRegions: (accountId: string) => request(`/regions/scan/${accountId}`, { method: 'POST' }),
  enableRegion: (accountId: string, region: string) => request('/regions/enable', { method: 'POST', body: JSON.stringify({ accountId, region }) }),
  enableRegionBatch: (accountIds: string[], region: string) => request('/regions/enable-batch', { method: 'POST', body: JSON.stringify({ accountIds, region }) }),
  getRootCredentials: (accountId: string) => request(`/aws/root-credentials/${accountId}`),
  // Generate temporary ADMIN credentials. Admin may request 1–12 hours; other root_access users remain at 1 hour.
  getTempCredentials: (accountId: string, durationHours = 1) =>
    request(`/aws/temp-credentials/${accountId}?durationHours=${encodeURIComponent(durationHours)}`, { cache: 'no-store' }),
  // Root user privileged tasks (via sts:AssumeRoot centralized root access)
  deleteRootMFA: (accountId: string) => request(`/aws/root-credentials/${accountId}/delete-mfa`, { method: 'POST' }),
  recoverRootPassword: (accountId: string) => request(`/aws/root-credentials/${accountId}/recover-password`, { method: 'POST' }),
  deleteRootAccessKey: (accountId: string, accessKeyId: string) =>
    request(`/aws/root-credentials/${accountId}/delete-access-key`, { method: 'POST', body: JSON.stringify({ accessKeyId }) }),
  changePassword: (currentPassword: string, newPassword: string) =>
    request('/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) }),
  // User management
  listUsers: () => request('/auth/users'),
  createUser: (username: string, password: string, role: string, allowedPages?: string[], rootAccess?: boolean, bulkQuotaAccess?: boolean) =>
    request('/auth/users', { method: 'POST', body: JSON.stringify({ username, password, role, allowedPages, rootAccess, bulkQuotaAccess }) }),
  updateUser: (id: number, patch: { role?: string; allowedPages?: string[]; rootAccess?: boolean; bulkQuotaAccess?: boolean }) =>
    request(`/auth/users/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
  deleteUser: (id: number) => request(`/auth/users/${id}`, { method: 'DELETE' }),
  resetUserPassword: (id: number, newPassword: string) =>
    request(`/auth/users/${id}/reset-password`, { method: 'POST', body: JSON.stringify({ newPassword }) }),
};
