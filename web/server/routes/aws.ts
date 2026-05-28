import { Router, Request, Response } from 'express';
import * as aws from '../aws-service';
import { db } from '../db';

export const awsRouter = Router();

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
awsRouter.post('/quotas/increase', async (req: Request, res: Response) => {
  try {
    const { accountId, serviceCode, quotaCode, desiredValue, quotaName } = req.body;
    const result = await aws.requestQuotaIncrease(accountId, serviceCode, quotaCode, desiredValue);
    const user = (req as any).user;

    db.upsertQuotaRequest({
      id: result?.Id || `${accountId}-${Date.now()}`,
      account_id: accountId, service_code: serviceCode, quota_code: quotaCode,
      quota_name: quotaName || '', desired_value: desiredValue,
      status: result?.Status || 'PENDING', region: aws.DEFAULT_REGION, submitted_by: user?.username,
    });
    db.addAuditLog(user?.userId, 'QUOTA_INCREASE', `${accountId} ${serviceCode} ${quotaCode} → ${desiredValue}`);

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

// Sync quota requests from AWS
awsRouter.post('/quotas/sync', async (req: Request, res: Response) => {
  try {
    const { accountIds } = req.body;
    for (const accountId of (accountIds || []).slice(0, 20)) {
      try {
        const requests = await aws.listQuotaRequests(accountId);
        for (const r of requests) {
          db.upsertQuotaRequest({
            id: r.Id, account_id: accountId, service_code: r.ServiceCode,
            quota_code: r.QuotaCode, quota_name: r.QuotaName, desired_value: r.DesiredValue,
            status: r.Status,
          });
        }
      } catch { /* skip */ }
    }
    res.json({ success: true, data: db.getQuotaRequests() });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
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
