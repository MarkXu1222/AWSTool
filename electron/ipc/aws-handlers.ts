import { ipcMain } from 'electron';
import { OrganizationsClient, ListAccountsCommand, DescribeAccountCommand } from '@aws-sdk/client-organizations';
import { STSClient, AssumeRoleCommand, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { ServiceQuotasClient, ListServiceQuotasCommand, RequestServiceQuotaIncreaseCommand, ListRequestedServiceQuotaChangeHistoryCommand, GetServiceQuotaCommand } from '@aws-sdk/client-service-quotas';
import { CostExplorerClient, GetCostAndUsageCommand } from '@aws-sdk/client-cost-explorer';
import { ResourceGroupsTaggingAPIClient, GetResourcesCommand } from '@aws-sdk/client-resource-groups-tagging-api';
import { EC2Client, DescribeRegionsCommand, DescribeInstancesCommand, DescribeVolumesCommand, DescribeSecurityGroupsCommand, DescribeVpcsCommand, TerminateInstancesCommand, DeleteVolumeCommand } from '@aws-sdk/client-ec2';
import { S3Client, ListBucketsCommand, DeleteBucketCommand, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { LambdaClient, ListFunctionsCommand, DeleteFunctionCommand } from '@aws-sdk/client-lambda';
import { RDSClient, DescribeDBInstancesCommand, DeleteDBInstanceCommand } from '@aws-sdk/client-rds';
import { IAMClient, ListMFADevicesCommand, GetAccountSummaryCommand, ListUsersCommand } from '@aws-sdk/client-iam';
import { storeGet, storeSet, storeDelete } from '../store';

interface PayerAccount {
  roleArn: string;     // e.g. arn:aws:iam::133354366329:role/tool
  name: string;        // e.g. yanhuang11
}

interface CredentialConfig {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  payers: PayerAccount[];
  childRoleName: string;
}

let baseCredentials: { accessKeyId: string; secretAccessKey: string } | null = null;
let defaultRegion = 'us-east-1';
let payers: PayerAccount[] = [];
let childRoleName = 'OrganizationAccountAccessRole';

// Cache admin credentials per payer (keyed by role ARN)
const adminCredsCache: Map<string, { creds: { accessKeyId: string; secretAccessKey: string; sessionToken: string }; expiry: number }> = new Map();

// Restore credentials: try config.json first, then local store
function restoreCredentials() {
  // Try shared config.json first
  try {
    const configPath = require('path').join(require('electron').app.getAppPath(), 'config.json');
    const fs = require('fs');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (config.credentials?.accessKeyId) {
        baseCredentials = { accessKeyId: config.credentials.accessKeyId, secretAccessKey: config.credentials.secretAccessKey };
        defaultRegion = config.region || 'us-east-1';
        payers = config.payers || [];
        childRoleName = config.childRoleName || 'OrganizationAccountAccessRole';
        console.log('✅ Loaded config from config.json');
        return;
      }
    }
  } catch {}

  // Fallback to local encrypted store
  const saved = storeGet('credentials') as CredentialConfig | undefined;
  if (saved) {
    baseCredentials = { accessKeyId: saved.accessKeyId, secretAccessKey: saved.secretAccessKey };
    defaultRegion = saved.region || 'us-east-1';
    payers = saved.payers || [];
    childRoleName = saved.childRoleName || 'OrganizationAccountAccessRole';
  }
}

// Assume role into a specific payer's admin role
async function getAdminCredentialsForPayer(payerRoleArn: string) {
  if (!baseCredentials) throw new Error('未配置基础凭证');

  // Check cache
  const cached = adminCredsCache.get(payerRoleArn);
  if (cached && Date.now() < cached.expiry) return cached.creds;

  const sts = new STSClient({ region: defaultRegion, credentials: baseCredentials });
  const response = await sts.send(new AssumeRoleCommand({
    RoleArn: payerRoleArn,
    RoleSessionName: 'aws-toolbox-admin',
    DurationSeconds: 3600,
  }));

  const creds = {
    accessKeyId: response.Credentials!.AccessKeyId!,
    secretAccessKey: response.Credentials!.SecretAccessKey!,
    sessionToken: response.Credentials!.SessionToken!,
  };

  // Cache for 50 minutes
  adminCredsCache.set(payerRoleArn, { creds, expiry: Date.now() + 50 * 60 * 1000 });
  return creds;
}

// Get admin credentials for the first (or only) payer — backward compatible
async function getAdminCredentials() {
  if (payers.length === 0) throw new Error('未配置任何 Payer 账户');
  return getAdminCredentialsForPayer(payers[0].roleArn);
}

// Find which payer an account belongs to (by trying each)
// This cache maps accountId → payerRoleArn
const accountPayerMap: Map<string, string> = new Map();

function getOrganizationsClient() {
  return new OrganizationsClient({
    region: 'us-east-1',
    credentials: baseCredentials || undefined,
  });
}

// Assume into a child account — tries the mapped payer first, then all payers
async function assumeRoleForAccount(accountId: string) {
  const roleArn = `arn:aws:iam::${accountId}:role/${childRoleName}`;

  // Try cached payer mapping first
  const knownPayer = accountPayerMap.get(accountId);
  if (knownPayer) {
    const admin = await getAdminCredentialsForPayer(knownPayer);
    const sts = new STSClient({ region: defaultRegion, credentials: admin });
    const response = await sts.send(new AssumeRoleCommand({
      RoleArn: roleArn, RoleSessionName: `aws-toolbox-${accountId}`, DurationSeconds: 3600,
    }));
    return { accessKeyId: response.Credentials!.AccessKeyId!, secretAccessKey: response.Credentials!.SecretAccessKey!, sessionToken: response.Credentials!.SessionToken! };
  }

  // Try each payer
  for (const payer of payers) {
    try {
      const admin = await getAdminCredentialsForPayer(payer.roleArn);
      const sts = new STSClient({ region: defaultRegion, credentials: admin });
      const response = await sts.send(new AssumeRoleCommand({
        RoleArn: roleArn, RoleSessionName: `aws-toolbox-${accountId}`, DurationSeconds: 3600,
      }));
      // Remember which payer owns this account
      accountPayerMap.set(accountId, payer.roleArn);
      return { accessKeyId: response.Credentials!.AccessKeyId!, secretAccessKey: response.Credentials!.SecretAccessKey!, sessionToken: response.Credentials!.SessionToken! };
    } catch (e) {
      continue; // Try next payer
    }
  }
  throw new Error(`无法切换到账户 ${accountId}，所有 Payer 均失败`);
}

// Scan resources across multiple AWS services
async function scanAccountResources(accountId: string, region: string) {
  const accountCreds = await assumeRoleForAccount(accountId);
  const resources: { type: string; id: string; name: string; arn: string; details: string }[] = [];

  // EC2 Instances
  try {
    const ec2 = new EC2Client({ region, credentials: accountCreds });
    const instances = await ec2.send(new DescribeInstancesCommand({}));
    for (const reservation of instances.Reservations || []) {
      for (const instance of reservation.Instances || []) {
        if (instance.State?.Name !== 'terminated') {
          const nameTag = instance.Tags?.find(t => t.Key === 'Name');
          resources.push({
            type: 'EC2',
            id: instance.InstanceId || '',
            name: nameTag?.Value || instance.InstanceId || '',
            arn: `arn:aws:ec2:${region}:${accountId}:instance/${instance.InstanceId}`,
            details: `${instance.InstanceType} | ${instance.State?.Name}`,
          });
        }
      }
    }
  } catch (e) { /* skip if no permission */ }

  // EBS Volumes
  try {
    const ec2 = new EC2Client({ region, credentials: accountCreds });
    const volumes = await ec2.send(new DescribeVolumesCommand({}));
    for (const vol of volumes.Volumes || []) {
      const nameTag = vol.Tags?.find(t => t.Key === 'Name');
      resources.push({
        type: 'EBS',
        id: vol.VolumeId || '',
        name: nameTag?.Value || vol.VolumeId || '',
        arn: `arn:aws:ec2:${region}:${accountId}:volume/${vol.VolumeId}`,
        details: `${vol.Size}GB | ${vol.State} | ${vol.VolumeType}`,
      });
    }
  } catch (e) { /* skip */ }

  // S3 Buckets (global, but listed once)
  if (region === 'us-east-1') {
    try {
      const s3 = new S3Client({ region, credentials: accountCreds });
      const buckets = await s3.send(new ListBucketsCommand({}));
      for (const bucket of buckets.Buckets || []) {
        resources.push({
          type: 'S3',
          id: bucket.Name || '',
          name: bucket.Name || '',
          arn: `arn:aws:s3:::${bucket.Name}`,
          details: `Created: ${bucket.CreationDate?.toISOString().split('T')[0]}`,
        });
      }
    } catch (e) { /* skip */ }
  }

  // Lambda Functions
  try {
    const lambda = new LambdaClient({ region, credentials: accountCreds });
    const functions = await lambda.send(new ListFunctionsCommand({}));
    for (const fn of functions.Functions || []) {
      resources.push({
        type: 'Lambda',
        id: fn.FunctionName || '',
        name: fn.FunctionName || '',
        arn: fn.FunctionArn || '',
        details: `${fn.Runtime} | ${fn.MemorySize}MB`,
      });
    }
  } catch (e) { /* skip */ }

  // RDS Instances
  try {
    const rds = new RDSClient({ region, credentials: accountCreds });
    const dbInstances = await rds.send(new DescribeDBInstancesCommand({}));
    for (const db of dbInstances.DBInstances || []) {
      resources.push({
        type: 'RDS',
        id: db.DBInstanceIdentifier || '',
        name: db.DBInstanceIdentifier || '',
        arn: db.DBInstanceArn || '',
        details: `${db.Engine} | ${db.DBInstanceClass} | ${db.DBInstanceStatus}`,
      });
    }
  } catch (e) { /* skip */ }

  return resources;
}

// Delete specific resources
async function deleteResources(accountId: string, region: string, resources: { type: string; id: string }[]) {
  const accountCreds = await assumeRoleForAccount(accountId);
  const results: { id: string; success: boolean; error?: string }[] = [];

  for (const resource of resources) {
    try {
      switch (resource.type) {
        case 'EC2': {
          const ec2 = new EC2Client({ region, credentials: accountCreds });
          await ec2.send(new TerminateInstancesCommand({ InstanceIds: [resource.id] }));
          results.push({ id: resource.id, success: true });
          break;
        }
        case 'EBS': {
          const ec2 = new EC2Client({ region, credentials: accountCreds });
          await ec2.send(new DeleteVolumeCommand({ VolumeId: resource.id }));
          results.push({ id: resource.id, success: true });
          break;
        }
        case 'Lambda': {
          const lambda = new LambdaClient({ region, credentials: accountCreds });
          await lambda.send(new DeleteFunctionCommand({ FunctionName: resource.id }));
          results.push({ id: resource.id, success: true });
          break;
        }
        case 'RDS': {
          const rds = new RDSClient({ region, credentials: accountCreds });
          await rds.send(new DeleteDBInstanceCommand({
            DBInstanceIdentifier: resource.id,
            SkipFinalSnapshot: true,
          }));
          results.push({ id: resource.id, success: true });
          break;
        }
        case 'S3': {
          const s3 = new S3Client({ region: 'us-east-1', credentials: accountCreds });
          // Empty bucket first
          let continuationToken: string | undefined;
          do {
            const objects = await s3.send(new ListObjectsV2Command({
              Bucket: resource.id,
              ContinuationToken: continuationToken,
            }));
            if (objects.Contents && objects.Contents.length > 0) {
              await s3.send(new DeleteObjectsCommand({
                Bucket: resource.id,
                Delete: { Objects: objects.Contents.map(o => ({ Key: o.Key! })) },
              }));
            }
            continuationToken = objects.NextContinuationToken;
          } while (continuationToken);
          await s3.send(new DeleteBucketCommand({ Bucket: resource.id }));
          results.push({ id: resource.id, success: true });
          break;
        }
        default:
          results.push({ id: resource.id, success: false, error: `Unsupported type: ${resource.type}` });
      }
    } catch (error: any) {
      results.push({ id: resource.id, success: false, error: error.message });
    }
  }

  return results;
}

export function registerAwsHandlers() {
  // Restore credentials on startup
  restoreCredentials();

  // Configure Credentials (multi-payer: AK/SK → multiple payer roles → child accounts)
  ipcMain.handle('aws:configure-credentials', async (_event, config) => {
    baseCredentials = {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    };
    defaultRegion = config.region || 'us-east-1';
    payers = config.payers || [];
    childRoleName = config.childRoleName || 'OrganizationAccountAccessRole';
    adminCredsCache.clear();
    accountPayerMap.clear();

    storeSet('credentials', {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      region: defaultRegion,
      payers,
      childRoleName,
    });

    return { success: true };
  });

  // Test connection (validates all payers)
  ipcMain.handle('aws:test-connection', async () => {
    try {
      adminCredsCache.clear();
      const results: { name: string; roleArn: string; account?: string; arn?: string; error?: string }[] = [];

      for (const payer of payers) {
        try {
          const creds = await getAdminCredentialsForPayer(payer.roleArn);
          const sts = new STSClient({ region: defaultRegion, credentials: creds });
          const identity = await sts.send(new GetCallerIdentityCommand({}));
          results.push({ name: payer.name, roleArn: payer.roleArn, account: identity.Account, arn: identity.Arn });
        } catch (err: any) {
          results.push({ name: payer.name, roleArn: payer.roleArn, error: err.message });
        }
      }

      const allFailed = results.every(r => r.error);
      if (allFailed) return { success: false, error: '所有 Payer 连接失败', data: results };
      return { success: true, data: results };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  // Check if credentials exist
  ipcMain.handle('aws:has-credentials', async () => {
    return { success: true, data: baseCredentials !== null && payers.length > 0 };
  });

  // Get saved config (for display in settings — masks secret key)
  ipcMain.handle('aws:get-saved-config', async () => {
    const saved = storeGet('credentials') as CredentialConfig | undefined;
    if (!saved) return { success: true, data: null };
    return {
      success: true,
      data: {
        accessKeyId: saved.accessKeyId,
        secretAccessKey: saved.secretAccessKey ? '••••••••' + saved.secretAccessKey.slice(-4) : '',
        region: saved.region,
        payers: saved.payers || [],
        childRoleName: saved.childRoleName,
      },
    };
  });

  // Clear credentials
  ipcMain.handle('aws:clear-credentials', async () => {
    baseCredentials = null;
    adminCredsCache.clear();
    accountPayerMap.clear();
    storeDelete('credentials');
    return { success: true };
  });

  // Cache for accounts list
  let accountsCache: { data: any[]; timestamp: number } | null = null;
  const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  // List all linked accounts (from ALL payers, with cache)
  ipcMain.handle('aws:list-accounts', async (_event, forceRefresh?: boolean) => {
    try {
      if (!forceRefresh && accountsCache && Date.now() - accountsCache.timestamp < CACHE_TTL) {
        return { success: true, data: accountsCache.data, cached: true };
      }

      const allAccounts: any[] = [];

      // Query each payer in parallel
      const results = await Promise.allSettled(payers.map(async (payer) => {
        const admin = await getAdminCredentialsForPayer(payer.roleArn);
        const client = new OrganizationsClient({ region: 'us-east-1', credentials: admin });
        const accounts: any[] = [];
        let nextToken: string | undefined;

        do {
          const response = await client.send(new ListAccountsCommand({ NextToken: nextToken }));
          if (response.Accounts) {
            accounts.push(...response.Accounts.map(a => ({
              ...a,
              _payer: payer.name,
              _payerRoleArn: payer.roleArn,
            })));
          }
          nextToken = response.NextToken;
        } while (nextToken);

        // Map all accounts to this payer
        accounts.forEach(a => { if (a.Id) accountPayerMap.set(a.Id, payer.roleArn); });
        return accounts;
      }));

      for (const result of results) {
        if (result.status === 'fulfilled') {
          allAccounts.push(...result.value);
        }
      }

      // Deduplicate by account ID (in case same account appears under multiple orgs)
      const seen = new Set<string>();
      const unique = allAccounts.filter(a => {
        if (seen.has(a.Id)) return false;
        seen.add(a.Id);
        return true;
      });

      accountsCache = { data: unique, timestamp: Date.now() };
      return { success: true, data: unique };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  // Get account info
  ipcMain.handle('aws:get-account-info', async (_event, accountId: string) => {
    try {
      // Use the payer that owns this account
      const payerRole = accountPayerMap.get(accountId) || payers[0]?.roleArn;
      if (!payerRole) throw new Error('No payer configured');
      const admin = await getAdminCredentialsForPayer(payerRole);
      const client = new OrganizationsClient({ region: 'us-east-1', credentials: admin });
      const response = await client.send(new DescribeAccountCommand({ AccountId: accountId }));
      return { success: true, data: response.Account };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  // Get account detail: cost, active services, MFA status
  ipcMain.handle('aws:get-account-detail', async (_event, accountId: string) => {
    const detail: any = { cost: null, services: [], mfa: null, iamSummary: null };

    try {
      // For IAM: try AssumeRole to child, or use admin creds if it's the management account itself
      let iamCreds: any;
      try {
        iamCreds = await assumeRoleForAccount(accountId);
      } catch (e) {
        // If AssumeRole fails (e.g., management account can't assume into itself), use admin creds
        iamCreds = await getAdminCredentials();
      }

      // Get recent cost by service (last 30 days)
      try {
        const admin = await getAdminCredentials();
        const ce = new CostExplorerClient({ region: 'us-east-1', credentials: admin });
        const now = new Date();
        const startDate = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate()).toISOString().split('T')[0];
        const endDate = now.toISOString().split('T')[0];

        const costResp = await ce.send(new GetCostAndUsageCommand({
          TimePeriod: { Start: startDate, End: endDate },
          Granularity: 'MONTHLY',
          Metrics: ['UnblendedCost'],
          GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
          Filter: { Dimensions: { Key: 'LINKED_ACCOUNT', Values: [accountId] } },
        }));

        let totalCost = 0;
        const services: { name: string; cost: number }[] = [];
        (costResp.ResultsByTime || []).forEach(period => {
          (period.Groups || []).forEach(group => {
            const name = group.Keys?.[0] || 'Other';
            const amount = parseFloat(group.Metrics?.UnblendedCost?.Amount || '0');
            if (amount > 0) {
              const existing = services.find(s => s.name === name);
              if (existing) existing.cost += amount;
              else services.push({ name, cost: amount });
              totalCost += amount;
            }
          });
        });

        services.sort((a, b) => b.cost - a.cost);
        detail.cost = { total: totalCost, period: `${startDate} ~ ${endDate}` };
        detail.services = services;
      } catch (e) { /* cost explorer might not be available */ }

      // Get IAM summary + MFA for root/users
      try {
        const iam = new IAMClient({ region: 'us-east-1', credentials: iamCreds });

        // Account summary (users count, mfa devices, etc.)
        const summary = await iam.send(new GetAccountSummaryCommand({}));
        detail.iamSummary = summary.SummaryMap;

        // Check MFA devices for root (list users first)
        const usersResp = await iam.send(new ListUsersCommand({ MaxItems: 10 }));
        const users = usersResp.Users || [];

        const mfaStatus: { user: string; hasMFA: boolean }[] = [];
        for (const user of users.slice(0, 10)) {
          const mfaResp = await iam.send(new ListMFADevicesCommand({ UserName: user.UserName }));
          mfaStatus.push({
            user: user.UserName || '',
            hasMFA: (mfaResp.MFADevices || []).length > 0,
          });
        }

        // Root MFA from account summary
        const rootMFA = (summary.SummaryMap?.AccountMFAEnabled || 0) > 0;
        detail.mfa = { root: rootMFA, users: mfaStatus };
      } catch (e) { /* IAM might not be accessible */ }

      return { success: true, data: detail };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  // List service quotas for an account
  ipcMain.handle('aws:list-service-quotas', async (_event, accountId: string, serviceCode: string, region?: string) => {
    try {
      const accountCreds = await assumeRoleForAccount(accountId);
      const client = new ServiceQuotasClient({
        region: region || defaultRegion,
        credentials: accountCreds,
      });

      const quotas: any[] = [];
      let nextToken: string | undefined;

      do {
        const response = await client.send(new ListServiceQuotasCommand({
          ServiceCode: serviceCode,
          NextToken: nextToken,
        }));
        if (response.Quotas) {
          quotas.push(...response.Quotas);
        }
        nextToken = response.NextToken;
      } while (nextToken);

      return { success: true, data: quotas };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  // === Local quota request history ===
  // Stored locally so records persist across devices/reinstalls

  ipcMain.handle('aws:get-local-quota-requests', async () => {
    const records = storeGet('quotaRequests') || [];
    return { success: true, data: records };
  });

  ipcMain.handle('aws:save-local-quota-requests', async (_event, records: any[]) => {
    storeSet('quotaRequests', records);
    return { success: true };
  });

  // Request quota increase (also saves to local history)
  ipcMain.handle('aws:request-quota-increase', async (_event, accountId: string, serviceCode: string, quotaCode: string, desiredValue: number, quotaName?: string) => {
    try {
      const accountCreds = await assumeRoleForAccount(accountId);
      const client = new ServiceQuotasClient({
        region: defaultRegion,
        credentials: accountCreds,
      });

      const response = await client.send(new RequestServiceQuotaIncreaseCommand({
        ServiceCode: serviceCode,
        QuotaCode: quotaCode,
        DesiredValue: desiredValue,
      }));

      // Save to local history
      const localRecords: any[] = storeGet('quotaRequests') || [];
      localRecords.unshift({
        id: response.RequestedQuota?.Id || `${accountId}-${Date.now()}`,
        accountId,
        serviceCode,
        quotaCode,
        quotaName: quotaName || response.RequestedQuota?.QuotaName || '',
        desiredValue,
        status: response.RequestedQuota?.Status || 'PENDING',
        currentValue: null,
        region: defaultRegion,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      storeSet('quotaRequests', localRecords);

      return { success: true, data: response.RequestedQuota };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  // Sync local records: imports new requests from AWS + updates statuses
  ipcMain.handle('aws:sync-quota-requests', async () => {
    try {
      let localRecords: any[] = storeGet('quotaRequests') || [];
      const existingIds = new Set(localRecords.map(r => r.id));

      // Get all accounts from cache
      const allAccounts = accountsCache?.data || [];
      const accountIds = allAccounts.map((a: any) => a.Id).filter(Boolean);

      if (accountIds.length === 0) {
        return { success: true, data: localRecords };
      }

      // Query each account (batch of 5)
      const batchSize = 5;
      for (let i = 0; i < accountIds.length; i += batchSize) {
        const batch = accountIds.slice(i, i + batchSize);
        const results = await Promise.allSettled(batch.map(async (accountId: string) => {
          const accountCreds = await assumeRoleForAccount(accountId);
          const client = new ServiceQuotasClient({ region: defaultRegion, credentials: accountCreds });
          const response = await client.send(new ListRequestedServiceQuotaChangeHistoryCommand({}));
          return { accountId, requests: response.RequestedQuotas || [] };
        }));

        for (const result of results) {
          if (result.status !== 'fulfilled') continue;
          const { accountId, requests } = result.value;

          for (const r of requests) {
            const id = r.Id || `${accountId}-${r.QuotaCode}-${r.DesiredValue}`;

            if (existingIds.has(id)) {
              // Update existing record
              const existing = localRecords.find(lr => lr.id === id);
              if (existing) {
                existing.status = r.Status || existing.status;
                existing.updatedAt = new Date().toISOString();
              }
            } else {
              // Import new record
              localRecords.push({
                id,
                accountId,
                serviceCode: r.ServiceCode || '',
                quotaCode: r.QuotaCode || '',
                quotaName: r.QuotaName || '',
                desiredValue: r.DesiredValue || 0,
                status: r.Status || 'UNKNOWN',
                currentValue: null,
                region: defaultRegion,
                createdAt: r.Created ? new Date(r.Created).toISOString() : new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              });
              existingIds.add(id);
            }
          }

          // Update current values for this account's records
          const accountRecords = localRecords.filter(lr => lr.accountId === accountId);
          const client = new ServiceQuotasClient({ region: defaultRegion, credentials: await assumeRoleForAccount(accountId).catch(() => null) as any });
          if (client) {
            for (const rec of accountRecords.slice(0, 10)) {
              try {
                const quotaResp = await client.send(new GetServiceQuotaCommand({ ServiceCode: rec.serviceCode, QuotaCode: rec.quotaCode }));
                rec.currentValue = quotaResp.Quota?.Value ?? null;
              } catch (e) { /* skip */ }
            }
          }
        }
      }

      // Sort by date descending
      localRecords.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

      storeSet('quotaRequests', localRecords);
      return { success: true, data: localRecords };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  // List quota change requests for a single account (enriched with current value)
  ipcMain.handle('aws:list-quota-requests', async (_event, accountId: string) => {
    try {
      const accountCreds = await assumeRoleForAccount(accountId);
      const client = new ServiceQuotasClient({
        region: defaultRegion,
        credentials: accountCreds,
      });

      const requests: any[] = [];
      let nextToken: string | undefined;

      do {
        const response = await client.send(new ListRequestedServiceQuotaChangeHistoryCommand({
          NextToken: nextToken,
        }));
        if (response.RequestedQuotas) {
          requests.push(...response.RequestedQuotas.map(r => ({ ...r, _accountId: accountId })));
        }
        nextToken = response.NextToken;
      } while (nextToken);

      // Enrich with current quota values (batch, max 10 to avoid rate limit)
      for (const req of requests.slice(0, 20)) {
        try {
          const quotaResp = await client.send(new GetServiceQuotaCommand({
            ServiceCode: req.ServiceCode,
            QuotaCode: req.QuotaCode,
          }));
          req.QuotaValue = quotaResp.Quota?.Value;
        } catch (e) { /* skip if not found */ }
      }

      return { success: true, data: requests };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  // List ALL quota requests across multiple accounts (local history + live query)
  ipcMain.handle('aws:list-all-quota-requests', async (_event, accountIds: string[]) => {
    try {
      const allRequests: any[] = [];

      // Query each account in parallel (limit concurrency)
      const batchSize = 5;
      for (let i = 0; i < accountIds.length; i += batchSize) {
        const batch = accountIds.slice(i, i + batchSize);
        const results = await Promise.allSettled(batch.map(async (accountId) => {
          const accountCreds = await assumeRoleForAccount(accountId);
          const client = new ServiceQuotasClient({ region: defaultRegion, credentials: accountCreds });
          const response = await client.send(new ListRequestedServiceQuotaChangeHistoryCommand({}));
          const reqs = (response.RequestedQuotas || []).map(r => ({ ...r, _accountId: accountId }));

          // Enrich with current values (limit to first 5 per account to avoid throttling)
          for (const req of reqs.slice(0, 5)) {
            try {
              const quotaResp = await client.send(new GetServiceQuotaCommand({ ServiceCode: req.ServiceCode, QuotaCode: req.QuotaCode }));
              (req as any).QuotaValue = quotaResp.Quota?.Value;
            } catch (e) { /* skip */ }
          }

          return reqs;
        }));

        for (const result of results) {
          if (result.status === 'fulfilled') allRequests.push(...result.value);
        }
      }

      // Sort by creation date descending
      allRequests.sort((a, b) => {
        const dateA = a.Created ? new Date(a.Created).getTime() : 0;
        const dateB = b.Created ? new Date(b.Created).getTime() : 0;
        return dateB - dateA;
      });

      return { success: true, data: allRequests };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  // Scan resources in an account (multi-service)
  ipcMain.handle('aws:scan-resources', async (_event, accountId: string, region: string) => {
    try {
      const resources = await scanAccountResources(accountId, region);
      return { success: true, data: resources };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  // Cleanup specific resources
  ipcMain.handle('aws:cleanup-resources', async (_event, accountId: string, region: string, resources: { type: string; id: string }[]) => {
    try {
      const results = await deleteResources(accountId, region, resources);
      const failed = results.filter(r => !r.success);
      if (failed.length === 0) {
        return { success: true, data: results };
      } else {
        return { success: true, data: results, warning: `${failed.length} 个资源删除失败` };
      }
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  // Cost summary (queries all payers)
  ipcMain.handle('aws:get-cost-summary', async (_event, startDate: string, endDate: string) => {
    try {
      const allResults: any[] = [];
      for (const payer of payers) {
        try {
          const admin = await getAdminCredentialsForPayer(payer.roleArn);
          const client = new CostExplorerClient({ region: 'us-east-1', credentials: admin });
          const response = await client.send(new GetCostAndUsageCommand({
            TimePeriod: { Start: startDate, End: endDate },
            Granularity: 'MONTHLY',
            Metrics: ['UnblendedCost'],
            GroupBy: [{ Type: 'DIMENSION', Key: 'LINKED_ACCOUNT' }],
          }));
          if (response.ResultsByTime) allResults.push(...response.ResultsByTime);
        } catch (e) { /* skip failed payer */ }
      }
      return { success: true, data: allResults };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  // Cost by account (queries all payers)
  ipcMain.handle('aws:get-cost-by-account', async (_event, startDate: string, endDate: string) => {
    try {
      const allResults: any[] = [];
      for (const payer of payers) {
        try {
          const admin = await getAdminCredentialsForPayer(payer.roleArn);
          const client = new CostExplorerClient({ region: 'us-east-1', credentials: admin });
          const response = await client.send(new GetCostAndUsageCommand({
            TimePeriod: { Start: startDate, End: endDate },
            Granularity: 'MONTHLY',
            Metrics: ['UnblendedCost'],
            GroupBy: [{ Type: 'DIMENSION', Key: 'LINKED_ACCOUNT' }],
          }));
          if (response.ResultsByTime) allResults.push(...response.ResultsByTime);
        } catch (e) { /* skip failed payer */ }
      }
      return { success: true, data: allResults };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  // Cost by service for a specific account
  ipcMain.handle('aws:get-cost-by-service', async (_event, accountId: string, startDate: string, endDate: string) => {
    try {
      // Use the payer that owns this account
      const payerRole = accountPayerMap.get(accountId) || payers[0]?.roleArn;
      if (!payerRole) throw new Error('No payer configured');
      const admin = await getAdminCredentialsForPayer(payerRole);
      const client = new CostExplorerClient({ region: 'us-east-1', credentials: admin });

      const response = await client.send(new GetCostAndUsageCommand({
        TimePeriod: { Start: startDate, End: endDate },
        Granularity: 'MONTHLY',
        Metrics: ['UnblendedCost'],
        GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
        Filter: { Dimensions: { Key: 'LINKED_ACCOUNT', Values: [accountId] } },
      }));

      return { success: true, data: response.ResultsByTime };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });
}
