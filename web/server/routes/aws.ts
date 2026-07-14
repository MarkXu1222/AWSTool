import { Router, Request, Response } from 'express';
import * as aws from '../aws-service';
import { db } from '../db';
import { generateQuotaDoc, getCompanyForAccount } from '../doc-generator';
import { COMPANY_PROFILES } from '../doc-templates';
import { exportBillingInvoices, cleanupWorkDir, ExportTask } from '../billing-exporter';
import { auditLogsToCsv, enrichAuditLog } from '../audit-presentation';
import fs from 'fs';
import path from 'path';

export const awsRouter = Router();

// RBAC: reject write operations for viewer role
const requireAdmin = (req: Request, res: Response, next: any) => {
  if ((req as any).user?.role === 'viewer') {
    return res.status(403).json({ error: '查看者角色无此权限' });
  }
  next();
};

// RBAC: 仅超级管理员(admin)。用于高敏感操作，如生成账户级 Admin 临时凭证。
// partadmin/viewer 一律拒绝，避免权限提升（partadmin 拿到完整 AdministratorAccess 凭证）。
const requireFullAdmin = (req: Request, res: Response, next: any) => {
  if ((req as any).user?.role !== 'admin') {
    return res.status(403).json({ error: '仅超级管理员(admin)可执行此操作' });
  }
  next();
};

// Audit logs contain sensitive operational data. Enforce the current database
// permission instead of trusting the potentially stale role/pages in the JWT.
const requireAuditAccess = (req: Request, res: Response, next: any) => {
  const tokenUser = (req as any).user;
  const currentUser = tokenUser?.username ? db.getUser(tokenUser.username) : null;
  if (!currentUser) return res.status(401).json({ error: '用户不存在或登录已失效' });
  if (currentUser.role === 'admin') return next();

  const allowedPages = (currentUser as any).allowed_pages;
  // Backward compatibility is limited to legacy null/undefined values.
  if (allowedPages == null) return next();
  if (Array.isArray(allowedPages) && allowedPages.includes('audit')) return next();
  // Corrupt or unexpected permission values must fail closed.
  return res.status(403).json({ error: '无权访问审计日志' });
};

// Test connection
awsRouter.get('/connection', async (_req: Request, res: Response) => {
  try {
    const results = await aws.testConnection();
    res.json({ success: true, data: results });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// List accounts — returns cached data instantly, refreshes in background
awsRouter.get('/accounts', async (_req: Request, res: Response) => {
  try {
    const { accounts: cached, cachedAt } = db.getAccountsCache();
    
    // If cache exists and is less than 10 minutes old, return it instantly
    if (cached.length > 0) {
      res.json({ success: true, data: cached, cachedAt });
      // Refresh in background if cache is older than 5 minutes
      const age = Date.now() - new Date(cachedAt).getTime();
      if (age > 5 * 60 * 1000) {
        aws.listAccounts().then(accounts => db.setAccountsCache(accounts)).catch(() => {});
      }
      return;
    }
    
    // No cache — must fetch (first time)
    const accounts = await aws.listAccounts();
    db.setAccountsCache(accounts);
    res.json({ success: true, data: accounts });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Force refresh accounts from AWS
awsRouter.post('/accounts/refresh', async (_req: Request, res: Response) => {
  try {
    const accounts = await aws.listAccounts();
    db.setAccountsCache(accounts);
    res.json({ success: true, data: accounts });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Account detail
awsRouter.get('/accounts/:id/detail', async (req: Request, res: Response) => {
  try {
    const detail = await aws.getAccountDetail(String(req.params.id));
    res.json({ success: true, data: detail });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Billing by account
awsRouter.get('/billing/by-account', async (req: Request, res: Response) => {
  try {
    const { start, end } = req.query;
    const data = await aws.getCostByAccount(start as string, end as string);
    res.json({ success: true, data });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Dashboard summary — cached, instant
awsRouter.get('/dashboard/summary', async (_req: Request, res: Response) => {
  try {
    const cached = db.getDashboardCache();
    if (cached) {
      res.json({ success: true, data: cached });
      // Refresh in background if older than 1 hour
      const age = cached.cachedAt ? Date.now() - new Date(cached.cachedAt).getTime() : Infinity;
      if (age > 60 * 60 * 1000) {
        refreshDashboardCache().catch(() => {});
      }
      return;
    }
    // No cache — compute now
    const summary = await refreshDashboardCache();
    res.json({ success: true, data: summary });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Helper: compute and cache dashboard summary
export async function refreshDashboardCache() {
  const dayjs = require('dayjs');
  const start = dayjs().startOf('month').format('YYYY-MM-DD');
  const end = dayjs().format('YYYY-MM-DD');
  const data = await aws.getCostByAccount(start, end);
  let totalCost = 0;
  const accountCostMap: Record<string, number> = {};
  (data || []).forEach((period: any) => {
    (period.Groups || []).forEach((g: any) => {
      const amount = parseFloat(g.Metrics?.UnblendedCost?.Amount || '0');
      totalCost += amount;
      const acctId = g.Keys[0];
      accountCostMap[acctId] = (accountCostMap[acctId] || 0) + amount;
    });
  });
  const topAccounts = Object.entries(accountCostMap)
    .map(([accountId, cost]) => ({ key: accountId, accountId, cost }))
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 10);
  const summary = { totalCost, topAccounts };
  db.setDashboardCache(summary);
  return { ...summary, cachedAt: new Date().toISOString() };
}


// Federated console sign-in URL — open a child account's console (e.g. Support case) without login
awsRouter.get('/console-url/:accountId', async (req: Request, res: Response) => {
  try {
    const accountId = String(req.params.accountId);
    const { caseId, destination } = req.query;
    // Default destination: Support case page (or custom)
    let dest = destination as string;
    if (!dest && caseId) {
      dest = `https://support.console.aws.amazon.com/support/home#/case/?displayId=${caseId}`;
    }
    if (!dest) {
      dest = 'https://console.aws.amazon.com/';
    }
    const url = await aws.getConsoleSigninUrl(accountId, dest);
    res.json({ success: true, url });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Generate quota increase document (PDF)
awsRouter.post('/quotas/generate-doc', async (req: Request, res: Response) => {
  try {
    const { accountId, accountName, companyKey, serviceCode, quotaName, region, requestedValue, currentValue } = req.body;
    // 必需：quotaName + region + requestedValue，且 accountId / companyKey 至少一个
    if (!quotaName || !region || !requestedValue) {
      return res.status(400).json({ error: '缺少必要参数（quotaName / region / requestedValue）' });
    }
    if (!accountId && !companyKey) {
      return res.status(400).json({ error: '需要指定 accountId 或 companyKey' });
    }
    const pdf = await generateQuotaDoc({
      accountId, accountName, companyKey, serviceCode,
      quotaName, region, requestedValue: Number(requestedValue),
      currentValue: currentValue != null ? Number(currentValue) : undefined,
    });
    const company = companyKey || (accountId ? getCompanyForAccount(accountId)?.key : null) || 'doc';
    const filename = `${company}-${(quotaName || 'quota').replace(/[^a-zA-Z0-9]/g, '_').slice(0, 30)}-${requestedValue}-${region}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(pdf);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Get company profile for an account (for doc generation UI)
awsRouter.get('/quotas/company/:accountId', async (req: Request, res: Response) => {
  try {
    const company = getCompanyForAccount(String(req.params.accountId));
    res.json({ success: true, data: company });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Batch export AWS Console Billing → Bills PDFs (zip)
// Body: { accountIds: string[], months: string[] "YYYY-MM", concurrency?: number }
awsRouter.post('/billing/export-invoices', async (req: Request, res: Response) => {
  try {
    const { accountIds, months, concurrency } = req.body as {
      accountIds: string[]; months: string[]; concurrency?: number;
    };
    if (!Array.isArray(accountIds) || accountIds.length === 0) {
      return res.status(400).json({ error: '请选择至少一个账号' });
    }
    if (!Array.isArray(months) || months.length === 0) {
      return res.status(400).json({ error: '请选择至少一个月份' });
    }
    // 拿 accountName 用于文件名
    const { accounts } = db.getAccountsCache();
    const nameById: Record<string, string> = {};
    for (const a of accounts) nameById[a.Id] = a.Name || '';

    // 展开为 (账号 × 月份) 任务
    const tasks: ExportTask[] = [];
    for (const aid of accountIds) {
      for (const m of months) {
        const match = /^(\d{4})-(\d{1,2})$/.exec(m);
        if (!match) continue;
        tasks.push({
          accountId: aid,
          accountName: nameById[aid] || undefined,
          year: parseInt(match[1], 10),
          month: parseInt(match[2], 10),
        });
      }
    }
    if (!tasks.length) return res.status(400).json({ error: '月份格式错误' });

    // 上限保护：避免一次跑太多
    if (tasks.length > 200) {
      return res.status(400).json({ error: `任务过多 (${tasks.length})，请分批（≤200）` });
    }

    const { zipPath, results, workDir } = await exportBillingInvoices(
      tasks,
      concurrency || 10,
    );

    // 附加一个 summary.txt 到 zip 里（方便用户对账，看哪些失败）
    const okCount = results.filter(r => r.ok).length;
    const failCount = results.length - okCount;
    const filename = `billing-invoices-${Date.now()}-${okCount}ok-${failCount}fail.zip`;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Export-Summary', `total=${tasks.length};ok=${okCount};fail=${failCount}`);

    const stream = fs.createReadStream(zipPath);
    stream.pipe(res);
    stream.on('close', () => cleanupWorkDir(workDir));
    stream.on('error', () => cleanupWorkDir(workDir));
  } catch (e: any) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// List all company profiles (for manual doc generation UI)
awsRouter.get('/quotas/companies', async (_req: Request, res: Response) => {
  try {
    const list = Object.values(COMPANY_PROFILES).map(c => ({
      key: c.key,
      displayName: c.displayName,
      industry: c.industry,
    }));
    // 按名字排序，便于下拉查找
    list.sort((a, b) => a.displayName.localeCompare(b.displayName));
    res.json({ success: true, data: list });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Billing by service
awsRouter.get('/billing/by-service/:accountId', async (req: Request, res: Response) => {
  try {
    const { start, end } = req.query;
    const data = await aws.getCostByService(String(req.params.accountId), start as string, end as string);
    res.json({ success: true, data });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// List quotas
awsRouter.get('/quotas/:accountId/:serviceCode', async (req: Request, res: Response) => {
  try {
    const { region } = req.query;
    const quotas = await aws.listServiceQuotas(String(req.params.accountId), String(req.params.serviceCode), region as string);
    res.json({ success: true, data: quotas });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Request quota increase
awsRouter.post('/quotas/increase', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { accountId, serviceCode, quotaCode, desiredValue, quotaName, region } = req.body;
    const targetRegion = region || aws.DEFAULT_REGION;
    const result = await aws.requestQuotaIncrease(accountId, serviceCode, quotaCode, desiredValue, targetRegion);
    const user = (req as any).user;

    db.upsertQuotaRequest({
      id: result?.Id || `${accountId}-${Date.now()}`,
      account_id: accountId, service_code: serviceCode, quota_code: quotaCode,
      quota_name: quotaName || '', desired_value: desiredValue,
      status: result?.Status || 'PENDING', region: targetRegion, submitted_by: user?.username,
      case_id: (result as any)?.CaseId || null,
      created_at: new Date().toISOString(),
    });
    db.addAuditLog(user?.userId, 'QUOTA_INCREASE', `账户 ${accountId} | ${quotaName || quotaCode} | ${serviceCode} | ${targetRegion} | 提升至 ${desiredValue}`, user?.username, req.ip);
    (res.locals as any).audited = true;

    res.json({ success: true, data: result });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Quota stats from DB (no AWS call — instant)
awsRouter.get('/quotas/stats', async (_req: Request, res: Response) => {
  try {
    const records = db.getQuotaRequests();
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const caseOpened7d = records.filter(r =>
      (r.status === 'CASE_OPENED' || r.status === 'PENDING') &&
      r.created_at && r.created_at >= sevenDaysAgo
    );
    res.json({ success: true, data: { total: records.length, caseOpened7d: caseOpened7d.length, records: caseOpened7d } });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// List quota requests (from local DB)
awsRouter.get('/quotas/requests', async (_req: Request, res: Response) => {
  try {
    const records = db.getQuotaRequests();
    res.json({ success: true, data: records });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Sync status — check if a background sync is running
let syncState = { running: false, total: 0, done: 0, startedAt: '' };

awsRouter.get('/quotas/sync-status', async (_req: Request, res: Response) => {
  res.json({ success: true, data: syncState });
});

// Sync quota requests — SSE streaming (data arrives as each account completes)
awsRouter.get('/quotas/sync-stream', async (req: Request, res: Response) => {
  // SSE headers — disable compression for streaming
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  (res as any).flush = (res as any).flush || (() => {});
  // Disable compression for this response
  (req as any).headers['accept-encoding'] = '';
  res.flushHeaders();

  try {
    const allAccounts = await aws.listAccounts();
    const accountIds = allAccounts.map((a: any) => a.Id);
    const total = accountIds.length;

    syncState = { running: true, total, done: 0, startedAt: new Date().toISOString() };
    res.write(`data: ${JSON.stringify({ type: 'start', total })}\n\n`);
    if (typeof (res as any).flush === 'function') (res as any).flush();

    // Process in batches of 15 (parallel within batch, with enrichment)
    const batchSize = 10;
    for (let i = 0; i < accountIds.length; i += batchSize) {
      const batch = accountIds.slice(i, i + batchSize);
      const results = await Promise.allSettled(batch.map(async (accountId: string) => {
        try {
          let requests = await aws.listQuotaRequests(accountId);
          // Enrich with current values
          if (requests.length > 0) {
            requests = await aws.enrichCurrentValues(accountId, requests);
          }
          for (const r of requests) {
            db.upsertQuotaRequest({
              id: r.Id,
              account_id: accountId,
              service_code: r.ServiceCode,
              quota_code: r.QuotaCode,
              quota_name: r.QuotaName,
              desired_value: r.DesiredValue,
              current_value: r._currentValue,
              status: r.Status,
              case_id: r.CaseId || null,
              region: r.QuotaArn ? r.QuotaArn.split(':')[3] : (r._region || 'us-east-1'),
              created_at: r.Created ? new Date(r.Created).toISOString() : undefined,
            });
          }
          return { accountId, count: requests.length };
        } catch { return { accountId, count: 0 }; }
      }));

      // Send progress update
      syncState.done = Math.min(i + batchSize, total);
      const batchResults = results.map(r => r.status === 'fulfilled' ? r.value : { accountId: '', count: 0 });
      res.write(`data: ${JSON.stringify({ type: 'progress', done: syncState.done, total, batch: batchResults })}\n\n`);
      if (typeof (res as any).flush === 'function') (res as any).flush();
    }

    syncState = { running: false, total, done: total, startedAt: syncState.startedAt };
    const allRecords = db.getQuotaRequests();
    res.write(`data: ${JSON.stringify({ type: 'done', total: allRecords.length })}\n\n`);
    res.end();
  } catch (e: any) {
    syncState.running = false;
    res.write(`data: ${JSON.stringify({ type: 'error', message: e.message })}\n\n`);
    res.end();
  }
});

// Legacy sync endpoint (for backward compat / small account lists)
awsRouter.post('/quotas/sync', async (req: Request, res: Response) => {
  try {
    let { accountIds } = req.body;
    
    if (!accountIds || accountIds.length === 0) {
      const allAccounts = await aws.listAccounts();
      accountIds = allAccounts.map((a: any) => a.Id);
    }

    // If large set, return DB data immediately and suggest streaming
    if (accountIds.length > 20) {
      return res.json({ success: true, data: db.getQuotaRequests(), message: 'Use /quotas/sync-stream for large sync' });
    }

    // Small set — sync directly with enrichment
    const batchSize = 5;
    for (let i = 0; i < accountIds.length; i += batchSize) {
      const batch = accountIds.slice(i, i + batchSize);
      await Promise.allSettled(batch.map(async (accountId: string) => {
        try {
          let requests = await aws.listQuotaRequests(accountId);
          if (requests.length > 0) {
            requests = await aws.enrichCurrentValues(accountId, requests);
          }
          for (const r of requests) {
            db.upsertQuotaRequest({
              id: r.Id,
              account_id: accountId,
              service_code: r.ServiceCode,
              quota_code: r.QuotaCode,
              quota_name: r.QuotaName,
              desired_value: r.DesiredValue,
              current_value: r._currentValue,
              status: r.Status,
              case_id: r.CaseId || null,
              region: r.QuotaArn ? r.QuotaArn.split(':')[3] : (r._region || 'us-east-1'),
              created_at: r.Created ? new Date(r.Created).toISOString() : undefined,
            });
          }
        } catch {}
      }));
    }

    res.json({ success: true, data: db.getQuotaRequests() });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Sync single account (quick refresh — with current value enrichment)
awsRouter.post('/quotas/sync-account/:accountId', async (req: Request, res: Response) => {
  try {
    const accountId = String(req.params.accountId);
    let requests = await aws.listQuotaRequests(accountId);
    // Enrich with current values (acceptable for single account)
    requests = await aws.enrichCurrentValues(accountId, requests);
    for (const r of requests) {
      db.upsertQuotaRequest({
        id: r.Id,
        account_id: accountId,
        service_code: r.ServiceCode,
        quota_code: r.QuotaCode,
        quota_name: r.QuotaName,
        desired_value: r.DesiredValue,
        current_value: r._currentValue,
        status: r.Status,
        case_id: r.CaseId || null,
        region: r.QuotaArn ? r.QuotaArn.split(':')[3] : (r._region || 'us-east-1'),
        created_at: r.Created ? new Date(r.Created).toISOString() : undefined,
      });
    }
    res.json({ success: true, data: db.getQuotaRequests(), synced: requests.length });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Root credentials status (via Credential Report)
awsRouter.get('/root-credentials/:accountId', async (req: Request, res: Response) => {
  try {
    const accountId = String(req.params.accountId);
    const { IAMClient, GenerateCredentialReportCommand, GetCredentialReportCommand } = require('@aws-sdk/client-iam');
    const creds = await (aws as any).assumeToAccount(accountId);
    const iam = new IAMClient({ region: 'us-east-1', credentials: creds });

    await iam.send(new GenerateCredentialReportCommand({}));
    // Wait for report to be ready
    await new Promise(r => setTimeout(r, 2000));

    let report;
    try { report = await iam.send(new GetCredentialReportCommand({})); }
    catch {
      await new Promise(r => setTimeout(r, 3000));
      report = await iam.send(new GetCredentialReportCommand({}));
    }

    const csv = Buffer.from(report.Content).toString('utf-8');
    const lines = csv.split('\n');
    const headers = lines[0].split(',');
    const rootData = lines[1]?.split(',') || [];

    const getField = (name: string) => {
      const idx = headers.indexOf(name);
      return idx >= 0 ? rootData[idx] : null;
    };

    const result = {
      accountId,
      passwordEnabled: getField('password_enabled') === 'true',
      passwordLastUsed: getField('password_last_used'),
      mfaActive: getField('mfa_active') === 'true',
      accessKey1Active: getField('access_key_1_active') === 'true',
      accessKey1LastUsed: getField('access_key_1_last_used_date'),
      accessKey2Active: getField('access_key_2_active') === 'true',
      accessKey2LastUsed: getField('access_key_2_last_used_date'),
    };

    res.json({ success: true, data: result });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Delete root access key (requires root login — cannot be done via role)
awsRouter.post('/root-credentials/:accountId/delete-key', requireAdmin, async (req: Request, res: Response) => {
  res.status(400).json({ error: '删除根用户 Access Key 需要使用根用户登录 AWS Console 操作，无法通过 IAM Role 完成。请登录对应账户的 AWS Console 手动删除。' });
});

// Generate temporary ADMIN credentials for an account (valid ~1 hour) — for copy into AWS CLI / SDK.
// Highly privileged (AdministratorAccess): restricted to full-admin role and always audited.
awsRouter.get('/temp-credentials/:accountId', requireFullAdmin, async (req: Request, res: Response) => {
  try {
    const accountId = String(req.params.accountId);
    if (!/^\d{12}$/.test(accountId)) {
      return res.status(400).json({ error: '无效的账户 ID' });
    }
    const creds = await aws.getTempAdminCredentials(accountId);
    const user = (req as any).user;
    db.addAuditLog(
      user?.userId,
      'TEMP_CREDENTIALS',
      `AWS 账户 ${accountId} · 生成 Admin 临时凭证 (有效期 1 小时)`,
      user?.username,
      req.ip,
    );
    (res.locals as any).audited = true;
    res.json({ success: true, data: creds });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Delete member account root user MFA via centralized root access (sts:AssumeRoot).
// Highly privileged & destructive: full-admin only, always audited.
awsRouter.post('/root-credentials/:accountId/delete-mfa', requireFullAdmin, async (req: Request, res: Response) => {
  try {
    const accountId = String(req.params.accountId);
    if (!/^\d{12}$/.test(accountId)) {
      return res.status(400).json({ error: '无效的账户 ID' });
    }
    const result = await aws.deleteRootMFA(accountId);
    const user = (req as any).user;
    db.addAuditLog(
      user?.userId,
      'ROOT_MFA_DELETE',
      `AWS 账户 ${accountId} · 删除根用户 MFA（${result.removed.length} 个设备）`,
      user?.username,
      req.ip,
    );
    (res.locals as any).audited = true;
    res.json({ success: true, data: result });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Recover (re-enable) member account root user password via centralized root access (sts:AssumeRoot).
// Triggers AWS password recovery flow (reset email to the account's root address). Full-admin only, audited.
awsRouter.post('/root-credentials/:accountId/recover-password', requireFullAdmin, async (req: Request, res: Response) => {
  try {
    const accountId = String(req.params.accountId);
    if (!/^\d{12}$/.test(accountId)) {
      return res.status(400).json({ error: '无效的账户 ID' });
    }
    const result = await aws.recoverRootPassword(accountId);
    const user = (req as any).user;
    db.addAuditLog(
      user?.userId,
      'ROOT_PASSWORD_RECOVER',
      `AWS 账户 ${accountId} · 恢复根用户密码`,
      user?.username,
      req.ip,
    );
    (res.locals as any).audited = true;
    res.json({ success: true, data: result });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Scan resources
awsRouter.get('/resources/:accountId/:region', async (req: Request, res: Response) => {
  try {
    const resources = await aws.scanResources(String(req.params.accountId), String(req.params.region));
    res.json({ success: true, data: resources });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Export full audit log (up to the 5,000 retained records)
awsRouter.get('/audit/export', requireAuditAccess, async (req: Request, res: Response) => {
  try {
    const format = String(req.query.format || 'csv').toLowerCase();
    if (format !== 'csv' && format !== 'json') {
      return res.status(400).json({ error: '仅支持 csv 或 json 格式' });
    }

    const logs = db.getAuditLog(5000);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `audit-logs-${timestamp}.${format}`;

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Export-Count', String(logs.length));
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    if (format === 'json') {
      res.type('application/json; charset=utf-8');
      return res.send(JSON.stringify({
        exported_at: new Date().toISOString(),
        total: logs.length,
        data: logs.map(enrichAuditLog),
      }, null, 2));
    }

    res.type('text/csv; charset=utf-8');
    return res.send(auditLogsToCsv(logs));
  } catch (e: any) {
    return res.status(500).json({ error: e.message || '导出审计日志失败' });
  }
});

// Audit log — default 500 rows for the UI; max 1,000 per request
awsRouter.get('/audit', requireAuditAccess, async (req: Request, res: Response) => {
  try {
    const requested = Number(req.query.limit || 500);
    const limit = Number.isFinite(requested) ? Math.min(1000, Math.max(1, Math.floor(requested))) : 500;
    const logs = db.getAuditLog(limit).map(enrichAuditLog);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ success: true, data: logs, total: logs.length });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});
