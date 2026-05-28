import { Router, Request, Response } from 'express';
import * as aws from '../aws-service';
import { db } from '../db';

export const awsRouter = Router();

// RBAC: reject write operations for viewer role
const requireAdmin = (req: Request, res: Response, next: any) => {
  if ((req as any).user?.role === 'viewer') {
    return res.status(403).json({ error: '查看者角色无此权限' });
  }
  next();
};

// Test connection
awsRouter.get('/connection', async (_req: Request, res: Response) => {
  try {
    const results = await aws.testConnection();
    res.json({ success: true, data: results });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// List accounts
awsRouter.get('/accounts', async (_req: Request, res: Response) => {
  try {
    const accounts = await aws.listAccounts();
    res.json({ success: true, data: accounts });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Account detail
awsRouter.get('/accounts/:id/detail', async (req: Request, res: Response) => {
  try {
    const detail = await aws.getAccountDetail(req.params.id);
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

// Billing by service
awsRouter.get('/billing/by-service/:accountId', async (req: Request, res: Response) => {
  try {
    const { start, end } = req.query;
    const data = await aws.getCostByService(req.params.accountId, start as string, end as string);
    res.json({ success: true, data });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// List quotas
awsRouter.get('/quotas/:accountId/:serviceCode', async (req: Request, res: Response) => {
  try {
    const { region } = req.query;
    const quotas = await aws.listServiceQuotas(req.params.accountId, req.params.serviceCode, region as string);
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
    db.addAuditLog(user?.userId, 'QUOTA_INCREASE', `${accountId} ${serviceCode} ${quotaCode} ${targetRegion} → ${desiredValue}`, user?.username);

    res.json({ success: true, data: result });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// List quota requests (from local DB)
awsRouter.get('/quotas/requests', async (_req: Request, res: Response) => {
  try {
    const records = db.getQuotaRequests();
    res.json({ success: true, data: records });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Sync quota requests from AWS — queries all accounts across all regions
awsRouter.post('/quotas/sync', async (req: Request, res: Response) => {
  try {
    // Get all accounts from the payer mapping (already loaded)
    let { accountIds } = req.body;
    
    // If no accountIds provided or too few, get all from listAccounts
    if (!accountIds || accountIds.length < 50) {
      const allAccounts = await aws.listAccounts();
      accountIds = allAccounts.map((a: any) => a.Id);
    }

    // Process in batches of 10 (parallel within batch)
    const batchSize = 10;
    for (let i = 0; i < accountIds.length; i += batchSize) {
      const batch = accountIds.slice(i, i + batchSize);
      const results = await Promise.allSettled(batch.map(async (accountId: string) => {
        try {
          const requests = await aws.listQuotaRequests(accountId);
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
          return requests.length;
        } catch { return 0; }
      }));
    }

    res.json({ success: true, data: db.getQuotaRequests() });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Sync single account (quick refresh)
awsRouter.post('/quotas/sync-account/:accountId', async (req: Request, res: Response) => {
  try {
    const { accountId } = req.params;
    const requests = await aws.listQuotaRequests(accountId);
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
    const accountId = req.params.accountId;
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

// Scan resources
awsRouter.get('/resources/:accountId/:region', async (req: Request, res: Response) => {
  try {
    const resources = await aws.scanResources(req.params.accountId, req.params.region);
    res.json({ success: true, data: resources });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Audit log
awsRouter.get('/audit', async (_req: Request, res: Response) => {
  try {
    const logs = db.getAuditLog();
    res.json({ success: true, data: logs });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});
