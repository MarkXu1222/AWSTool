export type AuditOutcome = 'success' | 'error' | 'completed';

export interface AuditDisplay {
  category: string;
  operation: string;
  target: string;
  result: string;
  outcome: AuditOutcome;
}

interface TechnicalFields {
  method?: string;
  path?: string;
  status?: number;
  duration_ms?: number;
}

// 前端每次进入页面上报一次（POST /api/aws/audit/page-view），只接受这里列出的 key。
// 需与前端 MainLayout 的 navItems key 保持一致。
export const PAGE_VIEW_LABELS: Readonly<Record<string, string>> = {
  dashboard: '概览',
  accounts: '账户管理',
  quotas: '配额管理',
  bulkquota: '批量提额',
  rootreset: '批量设置 Root 密码',
  bedrock: 'Bedrock 工具',
  poccash: 'POC Cash',
  regions: '区域管理',
  billing: '账单导出',
  cleanup: '资源清理',
  tagcompliance: 'MAP 标签',
  audit: '审计日志',
  ops: '运维监控',
  settings: '系统设置',
};

const explicitActions: Record<string, Omit<AuditDisplay, 'target' | 'result' | 'outcome'>> = {
  PAGE_VIEW: { category: '页面访问', operation: '进入页面' },
  LOGIN: { category: '登录与安全', operation: '登录系统' },
  LOGOUT: { category: '登录与安全', operation: '退出登录' },
  MFA_SETUP: { category: '登录与安全', operation: '启用 MFA' },
  PASSWORD_CHANGE: { category: '登录与安全', operation: '修改自己的密码' },
  PASSWORD_RESET: { category: '用户管理', operation: '重置用户密码' },
  USER_CREATE: { category: '用户管理', operation: '创建用户' },
  USER_UPDATE: { category: '用户管理', operation: '修改用户资料与权限' },
  USER_DELETE: { category: '用户管理', operation: '删除用户' },
  QUOTA_INCREASE: { category: '配额管理', operation: '提交配额提升申请' },
  TEMP_CREDENTIALS: { category: '安全检查', operation: '生成账户 Admin 临时凭证' },
  ROOT_MFA_DELETE: { category: '安全检查', operation: '删除根用户 MFA' },
  ROOT_PASSWORD_RECOVER: { category: '安全检查', operation: '恢复根用户密码' },
  ROOT_ACCESSKEY_DELETE: { category: '安全检查', operation: '删除根用户访问密钥' },
  RESOURCE_DELETE: { category: '资源清理', operation: '删除资源' },
  REGION_ENABLE: { category: '区域管理', operation: '启用区域' },
  REGION_BATCH_ENABLE: { category: '区域管理', operation: '批量启用区域' },
  REGION_DISABLE: { category: '区域管理', operation: '禁用区域' },
  BILLING_EXPORT_SUBMIT: { category: '账单导出', operation: '提交账单 PDF 导出' },
  BILLING_EXPORT_CANCEL: { category: '账单导出', operation: '取消账单 PDF 导出' },
  BILLING_EXPORT_DOWNLOAD_START: { category: '账单导出', operation: '开始下载账单 PDF' },
  BILLING_EXPORT_DOWNLOAD: { category: '账单导出', operation: '完成下载账单 PDF' },
  ACCOUNT_RECLAIM_BATCH_CREATE: { category: '账户回收', operation: '创建账户回收批次' },
  ACCOUNT_RECLAIM_JOB_RETRY: { category: '账户回收', operation: '重试账户回收' },
  ACCOUNT_RECLAIM_BATCH_CANCEL: { category: '账户回收', operation: '停止未开始的回收账户' },
  ACCOUNT_RECLAIM_JOB_COMPLETED: { category: '账户回收', operation: '账户回收完成' },
  ACCOUNT_RECLAIM_JOB_FAILED: { category: '账户回收', operation: '账户回收失败' },
  ACCOUNT_RECLAIM_JOB_PARTIAL: { category: '账户回收', operation: '账户回收部分完成' },
  ACCOUNT_RECLAIM_CREDENTIALS_VIEW: { category: '账户回收', operation: '查看回收密码' },
  ACCOUNT_RECLAIM_MFA_FAILED: { category: '账户回收', operation: '账户回收二次验证失败' },
};

function parseTechnicalFields(log: any): TechnicalFields {
  const parsed: TechnicalFields = {
    method: log.method,
    path: log.path,
    status: typeof log.status === 'number' ? log.status : undefined,
    duration_ms: typeof log.duration_ms === 'number' ? log.duration_ms : undefined,
  };

  if ((!parsed.method || !parsed.path) && typeof log.detail === 'string') {
    const match = log.detail.match(/^([A-Z]+)\s+(\S+)\s+→\s+(\d+)(?:\s+\((\d+)ms\))?/);
    if (match) {
      parsed.method = parsed.method || match[1];
      parsed.path = parsed.path || match[2];
      if (parsed.status === undefined) parsed.status = Number(match[3]);
      if (parsed.duration_ms === undefined && match[4]) parsed.duration_ms = Number(match[4]);
    }
  }

  return parsed;
}

function resultFromStatus(status?: number): Pick<AuditDisplay, 'result' | 'outcome'> {
  if (status === undefined) return { result: '已完成', outcome: 'completed' };
  if (status < 400) return { result: '成功', outcome: 'success' };
  return { result: '失败', outcome: 'error' };
}

function accountTarget(accountId?: unknown): string {
  return typeof accountId === 'string' && accountId ? `AWS 账户 ${accountId}` : '';
}

function safeDecodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function dateRangeTarget(query: any): string {
  if (!query || typeof query !== 'object') return '';
  const start = typeof query.start === 'string' ? query.start : '';
  const end = typeof query.end === 'string' ? query.end : '';
  return start || end ? `${start || '起始日期'} 至 ${end || '结束日期'}` : '';
}

function describeApiCall(method: string, path: string, params: any): Omit<AuditDisplay, 'result' | 'outcome'> {
  const body = params?.body || {};
  const query = params?.query || {};
  let match: RegExpMatchArray | null;

  if (path === '/api/aws/dashboard/summary') {
    return { category: '系统概览', operation: '查看概览数据', target: '运营状态汇总' };
  }
  if (path === '/api/aws/accounts') {
    return { category: '账户管理', operation: '查看账户列表', target: '全部 AWS 账户' };
  }
  if (path === '/api/aws/accounts/refresh') {
    return { category: '账户管理', operation: '刷新账户列表', target: '全部 AWS 账户' };
  }
  match = path.match(/^\/api\/aws\/accounts\/(\d{12})\/detail$/);
  if (match) {
    return { category: '账户管理', operation: '查看账户详情', target: accountTarget(match[1]) };
  }
  match = path.match(/^\/api\/aws\/console-url\/(\d{12})$/);
  if (match) {
    return { category: '账户管理', operation: '打开 AWS 控制台', target: accountTarget(match[1]) };
  }

  // 仅用于展示历史审计记录；这些 CE 查询路由已下线，不会恢复运行时调用。
  if (path === '/api/aws/billing/by-account') {
    return { category: '账单分析', operation: '查询账户账单', target: dateRangeTarget(query) || '全部账户' };
  }
  match = path.match(/^\/api\/aws\/billing\/by-service\/(\d{12})$/);
  if (match) {
    const range = dateRangeTarget(query);
    return { category: '账单分析', operation: '查询服务账单', target: [accountTarget(match[1]), range].filter(Boolean).join(' · ') };
  }
  match = path.match(/^\/api\/aws\/billing\/breakdown\/(\d{12})$/);
  if (match) {
    const range = dateRangeTarget(query);
    return { category: '账单分析', operation: '查询账单服务与区域明细', target: [accountTarget(match[1]), range].filter(Boolean).join(' · ') };
  }

  if (path === '/api/aws/billing/export-jobs') {
    const accountCount = Array.isArray(body.accountIds) ? body.accountIds.length : 0;
    const monthCount = Array.isArray(body.months) ? body.months.length : 0;
    return {
      category: '账单导出',
      operation: method === 'POST' ? '提交账单 PDF 导出' : '查看账单导出任务',
      target: accountCount || monthCount ? `${accountCount} 个账户 · ${monthCount} 个月份` : '账单导出任务',
    };
  }
  match = path.match(/^\/api\/aws\/billing\/export-jobs\/([^/]+)\/(cancel|download)$/);
  if (match) {
    return {
      category: '账单导出',
      operation: match[2] === 'cancel' ? '取消账单 PDF 导出' : '下载账单 PDF',
      target: `任务 ${match[1]}`,
    };
  }

  if (path === '/api/aws/quotas/stats') {
    return { category: '配额管理', operation: '查看配额统计', target: '配额申请汇总' };
  }
  if (path === '/api/aws/quotas/requests') {
    return { category: '配额管理', operation: '查看提额记录', target: '全部配额申请' };
  }
  if (path === '/api/aws/quotas/sync-status') {
    return { category: '配额管理', operation: '查看同步进度', target: '配额申请同步任务' };
  }
  if (path === '/api/aws/quotas/sync') {
    const count = Array.isArray(body.accountIds) ? body.accountIds.length : 0;
    return { category: '配额管理', operation: '同步提额记录', target: count ? `${count} 个 AWS 账户` : '全部 AWS 账户' };
  }
  match = path.match(/^\/api\/aws\/quotas\/sync-account\/(\d{12})$/);
  if (match) {
    return { category: '配额管理', operation: '同步单个账户提额记录', target: accountTarget(match[1]) };
  }
  if (path === '/api/aws/quotas/generate-doc') {
    return {
      category: '配额管理',
      operation: '生成提额文档',
      target: [accountTarget(body.accountId), body.quotaName, body.region].filter(Boolean).join(' · '),
    };
  }
  if (path === '/api/aws/quotas/companies') {
    return { category: '配额管理', operation: '查看公司模板', target: '全部公司模板' };
  }
  match = path.match(/^\/api\/aws\/quotas\/company\/(\d{12})$/);
  if (match) {
    return { category: '配额管理', operation: '匹配公司模板', target: accountTarget(match[1]) };
  }
  if (path === '/api/aws/quotas/increase') {
    return {
      category: '配额管理',
      operation: '提交配额提升申请',
      target: [accountTarget(body.accountId), body.quotaName || body.quotaCode, body.region].filter(Boolean).join(' · '),
    };
  }
  match = path.match(/^\/api\/aws\/quotas\/(\d{12})\/([^/]+)$/);
  if (match) {
    return {
      category: '配额管理',
      operation: '查询服务配额',
      target: `${accountTarget(match[1])} · 服务 ${safeDecodePathSegment(match[2])}${query.region ? ` · ${query.region}` : ''}`,
    };
  }

  if (path === '/api/regions/status') {
    return { category: '区域管理', operation: '查看区域状态', target: '全部 AWS 账户' };
  }
  if (path === '/api/regions/scan') {
    const count = Array.isArray(body.accountIds) ? body.accountIds.length : 0;
    return { category: '区域管理', operation: '扫描区域状态', target: count ? `${count} 个 AWS 账户` : '全部 AWS 账户' };
  }
  match = path.match(/^\/api\/regions\/scan\/(\d{12})$/);
  if (match) {
    return { category: '区域管理', operation: '扫描单个账户区域', target: accountTarget(match[1]) };
  }
  if (path === '/api/regions/enable') {
    return { category: '区域管理', operation: '启用区域', target: [accountTarget(body.accountId), body.region].filter(Boolean).join(' · ') };
  }
  if (path === '/api/regions/enable-batch') {
    const count = Array.isArray(body.accountIds) ? body.accountIds.length : 0;
    return { category: '区域管理', operation: '批量启用区域', target: `${count} 个账户 · ${body.region || '未指定区域'}` };
  }

  match = path.match(/^\/api\/aws\/root-credentials\/(\d{12})\/delete-mfa$/);
  if (match) {
    return { category: '安全检查', operation: '删除根用户 MFA', target: accountTarget(match[1]) };
  }
  match = path.match(/^\/api\/aws\/root-credentials\/(\d{12})\/recover-password$/);
  if (match) {
    return { category: '安全检查', operation: '恢复根用户密码', target: accountTarget(match[1]) };
  }
  match = path.match(/^\/api\/aws\/root-credentials\/(\d{12})\/delete-access-key$/);
  if (match) {
    return { category: '安全检查', operation: '删除根用户访问密钥', target: accountTarget(match[1]) };
  }
  match = path.match(/^\/api\/aws\/root-credentials\/(\d{12})(?:\/delete-key)?$/);
  if (match) {
    return {
      category: '安全检查',
      operation: path.endsWith('/delete-key') ? '尝试删除根用户访问密钥' : '检查根用户凭证',
      target: accountTarget(match[1]),
    };
  }
  match = path.match(/^\/api\/aws\/temp-credentials\/(\d{12})$/);
  if (match) {
    return { category: '安全检查', operation: '生成账户 Admin 临时凭证', target: accountTarget(match[1]) };
  }
  match = path.match(/^\/api\/aws\/resources\/(\d{12})\/delete$/);
  if (match) {
    return { category: '资源清理', operation: '删除资源', target: accountTarget(match[1]) };
  }
  match = path.match(/^\/api\/aws\/resources\/(\d{12})\/([^/]+)$/);
  if (match) {
    return { category: '资源清理', operation: '扫描账户资源', target: `${accountTarget(match[1])} · ${safeDecodePathSegment(match[2])}` };
  }

  if (path === '/api/aws/audit/export') {
    return { category: '审计日志', operation: '导出审计日志', target: String(query.format || 'csv').toUpperCase() };
  }

  const category = path.startsWith('/api/regions') ? '区域管理'
    : path.includes('/billing/') ? '账单导出'
    : path.includes('/quotas/') ? '配额管理'
    : path.includes('/accounts') ? '账户管理'
    : path.includes('/resources/') ? '资源清理'
    : '系统操作';
  const operation = method === 'GET' ? '查看数据'
    : method === 'DELETE' ? '删除数据'
    : method === 'PUT' || method === 'PATCH' ? '更新数据'
    : '执行操作';

  return { category, operation, target: path };
}

export function enrichAuditLog(log: any): any {
  const technical = parseTechnicalFields(log);
  const result = resultFromStatus(technical.status);
  let display: AuditDisplay;

  const explicit = explicitActions[log.action];
  if (explicit) {
    display = {
      ...explicit,
      target: typeof log.detail === 'string' ? log.detail : '',
      ...result,
    };
  } else {
    const method = technical.method || 'GET';
    const path = technical.path || '';
    let description: Omit<AuditDisplay, 'result' | 'outcome'>;
    try {
      description = describeApiCall(method, path, log.params);
    } catch {
      // A malformed historical record must never make the entire list/export fail.
      description = { category: '系统操作', operation: '访问系统功能', target: path || String(log.detail || '') };
    }
    display = {
      ...description,
      ...result,
    };
  }

  return {
    ...log,
    method: technical.method,
    path: technical.path,
    status: technical.status,
    duration_ms: technical.duration_ms,
    display,
  };
}

function csvCell(value: unknown): string {
  let text = value === null || value === undefined
    ? ''
    : typeof value === 'object' ? JSON.stringify(value) : String(value);
  // Strip control characters that can create hidden spreadsheet formula prefixes.
  text = text
    .replace(/[\t\r\n]+/g, ' ')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ');
  // Prevent CSV formula injection even when an attacker adds leading whitespace.
  if (/^\s*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function auditLogsToCsv(logs: any[]): string {
  const headers = [
    '时间 (UTC)', '用户', '分类', '操作', '对象/范围', '结果',
    'HTTP 方法', 'API 路径', '状态码', '耗时 (ms)', 'IP', '参数', '原始详情',
  ];
  const rows = logs.map(log => {
    const enriched = enrichAuditLog(log);
    return [
      enriched.created_at,
      enriched.username,
      enriched.display.category,
      enriched.display.operation,
      enriched.display.target,
      enriched.display.result,
      enriched.method,
      enriched.path,
      enriched.status,
      enriched.duration_ms,
      enriched.ip,
      enriched.params,
      enriched.detail,
    ].map(csvCell).join(',');
  });

  return `\uFEFF${headers.map(csvCell).join(',')}\n${rows.join('\n')}`;
}
