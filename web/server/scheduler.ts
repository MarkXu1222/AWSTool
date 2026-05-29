/**
 * Background scheduler — auto-syncs data periodically
 * 
 * Schedule:
 * - Accounts list: every 30 minutes
 * - Quota requests + current values: every 4 hours (rolling batches)
 * - Region status: every 24 hours (at 03:00)
 */
import * as aws from './aws-service';
import { db } from './db';

let quotaSyncRunning = false;
let regionSyncRunning = false;
let lastQuotaSync = '';
let lastAccountsSync = '';
let lastRegionSync = '';

export function getSchedulerStatus() {
  return {
    quotaSyncRunning,
    regionSyncRunning,
    lastQuotaSync,
    lastAccountsSync,
    lastRegionSync,
  };
}

// === Accounts sync (fast, ~10s) ===
async function syncAccounts() {
  try {
    console.log('[Scheduler] Syncing accounts...');
    const accounts = await aws.listAccounts();
    db.setAccountsCache(accounts);
    lastAccountsSync = new Date().toISOString();
    console.log(`[Scheduler] Accounts synced: ${accounts.length} accounts`);
  } catch (e: any) {
    console.error('[Scheduler] Accounts sync failed:', e.message);
  }
}

// === Quota requests sync (slow, rolling batches) ===
async function syncQuotaRequests() {
  if (quotaSyncRunning) {
    console.log('[Scheduler] Quota sync already running, skipping');
    return;
  }
  quotaSyncRunning = true;
  console.log('[Scheduler] Starting quota sync...');

  try {
    const { accounts } = db.getAccountsCache();
    if (accounts.length === 0) {
      // No cached accounts, fetch first
      await syncAccounts();
    }
    const { accounts: accts } = db.getAccountsCache();
    const accountIds = accts.map((a: any) => a.Id);
    const total = accountIds.length;
    let done = 0;
    let totalRecords = 0;

    // Process in batches of 8, with 2s delay between batches to avoid throttling
    const batchSize = 8;
    for (let i = 0; i < accountIds.length; i += batchSize) {
      const batch = accountIds.slice(i, i + batchSize);
      
      const results = await Promise.allSettled(batch.map(async (accountId: string) => {
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
          return requests.length;
        } catch { return 0; }
      }));

      done += batch.length;
      const batchTotal = results.reduce((sum, r) => sum + (r.status === 'fulfilled' ? r.value : 0), 0);
      totalRecords += batchTotal;

      // Log progress every 5 batches
      if ((i / batchSize) % 5 === 0 || done >= total) {
        console.log(`[Scheduler] Quota sync progress: ${done}/${total} accounts, ${totalRecords} records`);
      }

      // Delay between batches to avoid AWS throttling
      if (i + batchSize < accountIds.length) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    lastQuotaSync = new Date().toISOString();
    console.log(`[Scheduler] Quota sync complete: ${total} accounts, ${totalRecords} records`);
  } catch (e: any) {
    console.error('[Scheduler] Quota sync failed:', e.message);
  } finally {
    quotaSyncRunning = false;
  }
}

// === Region status sync ===
async function syncRegions() {
  if (regionSyncRunning) return;
  regionSyncRunning = true;
  console.log('[Scheduler] Starting region sync...');

  try {
    const { accounts } = db.getAccountsCache();
    const accountIds = accounts.map((a: any) => a.Id);
    
    // Import the scan function from regions route logic
    const { AccountClient, GetRegionOptStatusCommand } = require('@aws-sdk/client-account');
    const OPT_IN_REGIONS = [
      'af-south-1', 'ap-east-1', 'ap-south-2', 'ap-southeast-3',
      'ap-southeast-4', 'ap-southeast-5', 'ap-southeast-6', 'ap-southeast-7',
      'ca-west-1', 'eu-central-2', 'eu-south-1', 'eu-south-2',
      'il-central-1', 'me-central-1', 'me-south-1', 'mx-central-1',
    ];

    const batchSize = 5;
    let done = 0;
    for (let i = 0; i < accountIds.length; i += batchSize) {
      const batch = accountIds.slice(i, i + batchSize);
      await Promise.allSettled(batch.map(async (accountId: string) => {
        try {
          const creds = await aws.assumeToAccount(accountId);
          const client = new AccountClient({ region: 'us-east-1', credentials: creds });
          const regions: { region: string; status: string }[] = [];
          const results = await Promise.allSettled(OPT_IN_REGIONS.map(async (region) => {
            try {
              const resp = await client.send(new GetRegionOptStatusCommand({ RegionName: region }));
              return { region, status: resp.RegionOptStatus || 'UNKNOWN' };
            } catch { return { region, status: 'ERROR' }; }
          }));
          for (const r of results) {
            if (r.status === 'fulfilled') regions.push(r.value);
          }
          if (regions.length > 0) db.upsertRegionData(accountId, regions);
        } catch {}
      }));
      done += batch.length;
      if (done % 50 === 0) console.log(`[Scheduler] Region sync: ${done}/${accountIds.length}`);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    lastRegionSync = new Date().toISOString();
    console.log(`[Scheduler] Region sync complete: ${accountIds.length} accounts`);
  } catch (e: any) {
    console.error('[Scheduler] Region sync failed:', e.message);
  } finally {
    regionSyncRunning = false;
  }
}

// === Start scheduler ===
export function startScheduler() {
  console.log('[Scheduler] Starting background sync scheduler');

  // Initial sync after 10s delay (let server boot up)
  setTimeout(() => {
    syncAccounts();
  }, 10 * 1000);

  // Accounts: every 30 minutes
  setInterval(() => {
    syncAccounts();
  }, 30 * 60 * 1000);

  // Quota requests: every 4 hours
  // First run after 2 minutes (give accounts time to cache)
  setTimeout(() => {
    syncQuotaRequests();
  }, 2 * 60 * 1000);

  setInterval(() => {
    syncQuotaRequests();
  }, 4 * 60 * 60 * 1000);

  // Region status: every 24 hours
  // First run after 5 minutes
  setTimeout(() => {
    syncRegions();
  }, 5 * 60 * 1000);

  setInterval(() => {
    syncRegions();
  }, 24 * 60 * 60 * 1000);
}
