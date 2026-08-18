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
import { notifyQuotaChanged } from './notify';
import { refreshDashboardCache } from './routes/aws';
import { syncAccountRoles } from './account-roles';
import { recordDepartures, backfillDepartures } from './account-lifecycle';

let quotaSyncRunning = false;
let regionSyncRunning = false;
let roleSyncRunning = false;
let lastQuotaSync = '';
let lastAccountsSync = '';
let lastRegionSync = '';
let lastRoleSync = '';
const REGION_SYNC_ACCOUNT_TIMEOUT_MS = 30_000;

export function getSchedulerStatus() {
  return {
    quotaSyncRunning,
    regionSyncRunning,
    roleSyncRunning,
    lastQuotaSync,
    lastAccountsSync,
    lastRegionSync,
    lastRoleSync,
  };
}

// === Accounts sync (fast, ~10s) ===
async function syncAccounts() {
  try {
    console.log('[Scheduler] Syncing accounts...');
    // 必须在覆盖缓存之前取旧快照，否则无从判断哪些账户消失了
    const { accounts: prev } = db.getAccountsCache();
    const accounts = await aws.listAccounts();
    try {
      recordDepartures(prev || [], accounts);
    } catch (e: any) {
      console.error('[Lifecycle] 离场检测失败:', e.message);
    }
    db.setAccountsCache(accounts);
    lastAccountsSync = new Date().toISOString();
    console.log(`[Scheduler] Accounts synced: ${accounts.length} accounts`);
  } catch (e: any) {
    console.error('[Scheduler] Accounts sync failed:', e.message);
  }
  // 账户列表刷新后紧跟一次角色自愈（增量：只看新账户和上轮待重试的）
  await syncRoles(false);
}

/**
 * 账户角色自愈。full=false 只处理新账户/待重试，成本很低；full=true 为每日全量复检。
 */
async function syncRoles(full: boolean) {
  if (roleSyncRunning) {
    console.log('[Scheduler] Role sync already running, skipping');
    return;
  }
  roleSyncRunning = true;
  try {
    const r = await syncAccountRoles({ full });
    if (r.scanned > 0) {
      console.log(`[Scheduler] Role sync (${full ? 'full' : 'incremental'}): `
        + `scanned=${r.scanned} ok=${r.ok} remediated=${r.remediated} pending=${r.pending} unreachable=${r.unreachable}`);
    }
    lastRoleSync = new Date().toISOString();
  } catch (e: any) {
    console.error('[Scheduler] Role sync failed:', e.message);
  } finally {
    roleSyncRunning = false;
  }
}

// === Dashboard cost summary cache (every 2 hours) ===
async function syncDashboard() {
  try {
    console.log('[Scheduler] Refreshing dashboard cost cache...');
    await refreshDashboardCache();
    console.log('[Scheduler] Dashboard cache refreshed');
  } catch (e: any) {
    console.error('[Scheduler] Dashboard cache failed:', e.message);
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

    // 一次性快照所有现有记录（在任何写入前），用于对比变动
    const snapshot = new Map<string, any>();
    for (const r of db.getQuotaRequests()) {
      snapshot.set(r.id, { current_value: r.current_value, status: r.status });
    }

    // Process in batches of 8, with 2s delay between batches to avoid throttling
    const batchSize = 8;
    const changedRecords: any[] = []; // Track quotas whose current_value changed
    for (let i = 0; i < accountIds.length; i += batchSize) {
      const batch = accountIds.slice(i, i + batchSize);
      
      const results = await Promise.allSettled(batch.map(async (accountId: string) => {
        try {
          let requests = await aws.listQuotaRequests(accountId);
          if (requests.length > 0) {
            requests = await aws.enrichCurrentValues(accountId, requests);
          }
          // Snapshot existing records to detect changes (use upfront snapshot, not live DB)
          for (const r of requests) {
            const prev = snapshot.get(r.Id);
            const newCurrent = r._currentValue ?? prev?.current_value ?? null;
            const newStatus = r.Status?.Value || r.Status;
            const region = r.QuotaArn ? r.QuotaArn.split(':')[3] : (r._region || 'us-east-1');

            if (!prev) {
              // 全新记录（新提交的提升请求）— 不通知，等额度真正变动再通知
            } else {
              // 仅当"当前值"实际变化时通知（提交、状态变化不通知）
              const curChanged = prev.current_value != null && newCurrent != null && prev.current_value !== newCurrent;
              if (curChanged) {
                changedRecords.push({
                  accountId, quotaName: r.QuotaName, region,
                  oldValue: prev.current_value,
                  newValue: newCurrent,
                  desiredValue: r.DesiredValue,
                });
              }
            }
            db.upsertQuotaRequest({
              id: r.Id,
              account_id: accountId,
              service_code: r.ServiceCode,
              quota_code: r.QuotaCode,
              quota_name: r.QuotaName,
              desired_value: r.DesiredValue,
              current_value: newCurrent,
              status: r.Status,
              case_id: r.CaseId || null,
              region,
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

    // Notify for any quota change — but skip if this was the first-ever sync (empty snapshot = avoid flooding)
    try {
      if (changedRecords.length > 0 && snapshot.size > 0) {
        const { accounts: accts2 } = db.getAccountsCache();
        const toNotify = changedRecords.map(r => {
          const acct = accts2.find((a: any) => a.Id === r.accountId);
          return {
            accountId: r.accountId,
            accountName: acct?.Name || r.accountId,
            payer: acct?._payer || '',
            quotaName: r.quotaName,
            region: r.region,
            oldValue: r.oldValue,
            newValue: r.newValue,
            desiredValue: r.desiredValue,
          };
        });
        await notifyQuotaChanged(toNotify);
        console.log(`[Scheduler] Notified ${toNotify.length} quota changes to Feishu`);
      } else if (changedRecords.length > 0) {
        console.log(`[Scheduler] Skipped notification (first sync, ${changedRecords.length} records)`);
      }
    } catch (e: any) {
      console.error('[Scheduler] Notification check failed:', e.message);
    }
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
      'af-south-1', 'ap-east-1', 'ap-east-2', 'ap-south-2', 'ap-southeast-3',
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
          try {
            const regions: { region: string; status: string }[] = [];
            const results = await Promise.allSettled(OPT_IN_REGIONS.map(async (region) => {
              const controller = new AbortController();
              const timer = setTimeout(() => controller.abort(), REGION_SYNC_ACCOUNT_TIMEOUT_MS);
              try {
                const resp = await client.send(
                  new GetRegionOptStatusCommand({ RegionName: region }),
                  { abortSignal: controller.signal },
                );
                return { region, status: resp.RegionOptStatus || 'UNKNOWN' };
              } catch {
                return { region, status: 'ERROR' };
              } finally {
                clearTimeout(timer);
              }
            }));
            for (const r of results) {
              if (r.status === 'fulfilled') regions.push(r.value);
            }
            if (regions.length > 0) db.upsertRegionData(accountId, regions);
          } finally {
            client.destroy();
          }
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

  // 补录历史离场账户（本模块上线前已离开的，不会再触发 diff 检测）。
  // 只依赖现有缓存与遗留数据，不调 AWS，可以立即执行。
  try {
    backfillDepartures();
  } catch (e: any) {
    console.error('[Lifecycle] 补录失败:', e.message);
  }

  // Initial sync after 10s delay (let server boot up)
  setTimeout(() => {
    syncAccounts();
  }, 10 * 1000);

  // Dashboard cost cache: first run after 30s, then every 2 hours
  setTimeout(() => {
    syncDashboard();
  }, 30 * 1000);

  setInterval(() => {
    syncDashboard();
  }, 2 * 60 * 60 * 1000);

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

  // 账户角色全量复检：每 24 小时一次，用于发现被人为删除的角色
  // （增量检查跟在每次 syncAccounts 之后，这里只负责兜底复检）
  setInterval(() => {
    syncRoles(true);
  }, 24 * 60 * 60 * 1000);
}
