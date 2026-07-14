import { Router, Request, Response } from 'express';
import { AccountClient, ListRegionsCommand, EnableRegionCommand } from '@aws-sdk/client-account';
import { db } from '../db';
import * as aws from '../aws-service';

export const regionsRouter = Router();

// All opt-in regions that can be enabled/disabled
const OPT_IN_REGIONS = [
  'af-south-1', 'ap-east-1', 'ap-east-2', 'ap-south-2', 'ap-southeast-3',
  'ap-southeast-4', 'ap-southeast-5', 'ap-southeast-6', 'ap-southeast-7',
  'ca-west-1', 'eu-central-2', 'eu-south-1', 'eu-south-2',
  'il-central-1', 'me-central-1', 'me-south-1', 'mx-central-1',
];

// Get region status for a single account
async function getAccountRegions(accountId: string) {
  const creds = await (aws as any).assumeToAccount(accountId);
  const client = new AccountClient({ region: 'us-east-1', credentials: creds });
  const resp = await client.send(new ListRegionsCommand({
    RegionOptStatusContains: ['ENABLED', 'ENABLING', 'DISABLED', 'DISABLING'],
  }));
  return (resp.Regions || [])
    .filter(r => Boolean(r.RegionName && r.RegionOptStatus))
    .map(r => ({
      region: r.RegionName!,
      status: String(r.RegionOptStatus), // ENABLED | ENABLING | DISABLED | DISABLING
    }));
}

// Enable a region for an account
async function enableRegion(accountId: string, region: string) {
  const creds = await (aws as any).assumeToAccount(accountId);
  const client = new AccountClient({ region: 'us-east-1', credentials: creds });
  await client.send(new EnableRegionCommand({ RegionName: region }));
}

// List region status for multiple accounts (cached in DB)
regionsRouter.get('/status', async (req: Request, res: Response) => {
  try {
    // Return cached data from DB
    const cached = db.getRegionData();
    res.json({ success: true, data: cached });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Scan region status for all accounts (or specific ones)
regionsRouter.post('/scan', async (req: Request, res: Response) => {
  try {
    const { accountIds } = req.body;
    let ids = accountIds;
    if (!ids || ids.length === 0) {
      const accounts = await aws.listAccounts();
      ids = accounts.map((a: any) => a.Id);
    }

    const results: any[] = [];
    const batchSize = 5;

    for (let i = 0; i < ids.length; i += batchSize) {
      const batch = ids.slice(i, i + batchSize);
      const batchResults = await Promise.allSettled(batch.map(async (accountId: string) => {
        const regions = await getAccountRegions(accountId);
        return { accountId, regions };
      }));

      for (const result of batchResults) {
        if (result.status === 'fulfilled') {
          results.push(result.value);
          // Save to DB
          db.upsertRegionData(result.value.accountId, result.value.regions);
        }
      }
    }

    res.json({ success: true, data: db.getRegionData(), scanned: results.length });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Scan single account
regionsRouter.post('/scan/:accountId', async (req: Request, res: Response) => {
  try {
    const accountId = String(req.params.accountId);
    const regions = await getAccountRegions(accountId);
    db.upsertRegionData(accountId, regions);
    res.json({ success: true, data: { accountId, regions } });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Enable region for single account
regionsRouter.post('/enable', async (req: Request, res: Response) => {
  try {
    const { accountId, region } = req.body;
    await enableRegion(accountId, region);
    const user = (req as any).user;
    db.addAuditLog(user?.userId, 'REGION_ENABLE', `${accountId} 启用区域 ${region}`, user?.username, req.ip);
    (res.locals as any).audited = true;
    // Update cached status
    db.upsertRegionData(accountId, [{ region, status: 'ENABLING' }]);
    res.json({ success: true, message: `${region} 启用中` });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Batch enable region for multiple accounts
regionsRouter.post('/enable-batch', async (req: Request, res: Response) => {
  try {
    const { accountIds, region } = req.body;
    const results: { accountId: string; success: boolean; error?: string }[] = [];
    const user = (req as any).user;

    for (const accountId of accountIds) {
      try {
        await enableRegion(accountId, region);
        db.upsertRegionData(accountId, [{ region, status: 'ENABLING' }]);
        results.push({ accountId, success: true });
      } catch (e: any) {
        results.push({ accountId, success: false, error: e.message });
      }
    }

    db.addAuditLog(user?.userId, 'REGION_BATCH_ENABLE', `批量启用 ${region} (${accountIds.length} 账户)`, user?.username, req.ip);
    (res.locals as any).audited = true;
    res.json({ success: true, data: results });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export { OPT_IN_REGIONS };
