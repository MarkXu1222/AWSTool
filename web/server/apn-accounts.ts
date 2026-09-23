/**
 * APN 账户（AWS Partner Network 合作伙伴主体账户）。
 *
 * 这些账户**不是 payer，也不是任何组织的成员**，平台对它们只有
 * Partner Central 一条通路：`partner-central-tool` 这个带 ExternalId 的
 * 跨账户 role，权限被限定在 `partnercentral:*`。
 *
 * ⚠️ 为什么不放进 config.payers / accounts_cache（两者都试过，都不行）：
 *
 *  1. `aws-service.listAccounts()` 用的是无 ExternalId 的 AssumeRole +
 *     Organizations `ListAccounts`。实测这两个账户两步都被拒：
 *       AssumeRole role/tool|OAAR|support-quota|admin-console → AccessDenied
 *       DescribeOrganization / ListAccounts                   → AccessDeniedException
 *     而该函数的 payer 循环是 `catch { skip }`，失败会被**静默吞掉** ——
 *     账户永远不出现，且没有任何地方报错。
 *
 *  2. `accounts_cache` 被角色自愈、离场检测、Root 邮件批次、配额、账单、
 *     MAP 标签共用。塞进两个不可达账户会让这些功能各自去 assume 一个
 *     根本进不去的账户，产生连锁误报（尤其离场检测会把它们判为「已移出组织」）。
 *
 * 所以这里独立成一份**只读目录**，由前端在展示层合并进账户表格。
 * 不写缓存、不参与任何批量操作的候选集。
 */
import fs from 'fs';
import path from 'path';
import { PARTNERS } from './poc-cash';

const CONFIG_PATH = path.join(__dirname, '../../config.json');

function readConfig(): any {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

/** 平台对 APN 账户不可用的功能。前端据此给出禁用理由，避免点了才报错。 */
export const APN_UNAVAILABLE = [
  '控制台登录（无 support-quota / admin-console 角色）',
  'Root 凭证与密码重置',
  '配额查询与提额',
  'MAP 标签接入',
  '账单与区域数据',
];

export interface ApnAccountView {
  Id: string;
  Name: string;
  Email: string;
  Status: string;
  /** 与主账户表格对齐的展示字段 */
  _payer: string;
  _isPayer: false;
  _isApn: true;
  _consoleDual: false;
  _adminRoleExcluded: true;
  /** POC Cash 里的主体 key，前端可据此跳转 */
  partnerKey: string;
  /** role 是否已配置（roleArn 非空） */
  configured: boolean;
  externalIdConfigured: boolean;
  unavailable: string[];
}

/**
 * 列出已配置的 APN 账户。纯读配置，不发起任何 AWS 调用 ——
 * 账户页首屏不能被一次跨账户 AssumeRole 拖慢。
 * 连通性另由 /apn-accounts/probe 按需触发。
 */
export function listApnAccounts(): ApnAccountView[] {
  const cfg = readConfig();
  const pc = cfg.partnerCentral || {};

  return PARTNERS.map(p => {
    const nested = p.configKey ? pc[p.configKey] : null;
    // 兼容旧的扁平结构：只对 webby 生效，理由同 poc-cash.roleConfigFor
    const flat = p.key === 'webby' && pc.roleArn ? pc : null;
    const entry = (nested && nested.roleArn) ? nested : flat;

    return {
      Id: p.apnAccountId,
      Name: p.label,
      Email: p.owner.email,
      // 配置齐全即视为可用；真实连通性走 probe，不在列表里假装已验证
      Status: entry?.roleArn ? 'ACTIVE' : 'UNCONFIGURED',
      _payer: 'APN 合作伙伴账户',
      _isPayer: false as const,
      _isApn: true as const,
      _consoleDual: false as const,
      _adminRoleExcluded: true as const,
      partnerKey: p.key,
      configured: Boolean(entry?.roleArn),
      externalIdConfigured: Boolean(entry?.externalId),
      unavailable: APN_UNAVAILABLE,
    };
  });
}

/**
 * 实测某个 APN 账户的连通性：AssumeRole 后 GetCallerIdentity，
 * 并校验拿到的账户 ID 与配置一致。
 *
 * 校验账户 ID 是关键一步 —— role ARN 填错主体时 AssumeRole 一样会成功，
 * 只是进错了账户。不比对就会把「商机建到错误主体」当成连通正常。
 */
export async function probeApnAccount(partnerKey: string): Promise<{
  partnerKey: string;
  accountId: string;
  ok: boolean;
  actualAccountId?: string;
  error?: string;
}> {
  const view = listApnAccounts().find(a => a.partnerKey === partnerKey);
  if (!view) throw new Error(`未知的 APN 主体: ${partnerKey}`);
  if (!view.configured) {
    return { partnerKey, accountId: view.Id, ok: false, error: '未配置 roleArn' };
  }

  const cfg = readConfig();
  const pc = cfg.partnerCentral || {};
  const partner = PARTNERS.find(p => p.key === partnerKey)!;
  const nested = partner.configKey ? pc[partner.configKey] : null;
  const entry = (nested && nested.roleArn) ? nested : pc;

  const base = {
    accessKeyId: cfg.credentials?.accessKeyId || process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: cfg.credentials?.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY || '',
  };
  if (!base.accessKeyId || !base.secretAccessKey) {
    return { partnerKey, accountId: view.Id, ok: false, error: '平台基础凭证未配置' };
  }

  try {
    const { STSClient, AssumeRoleCommand, GetCallerIdentityCommand } =
      await import('@aws-sdk/client-sts');
    const sts = new STSClient({ region: 'us-east-1', credentials: base });
    const r = await sts.send(new AssumeRoleCommand({
      RoleArn: entry.roleArn,
      RoleSessionName: `apn-probe-${partnerKey}`.slice(0, 64),
      DurationSeconds: 900,
      ...(entry.externalId ? { ExternalId: entry.externalId } : {}),
    }));
    const probe = new STSClient({
      region: 'us-east-1',
      credentials: {
        accessKeyId: r.Credentials!.AccessKeyId!,
        secretAccessKey: r.Credentials!.SecretAccessKey!,
        sessionToken: r.Credentials!.SessionToken!,
      },
    });
    const id = await probe.send(new GetCallerIdentityCommand({}));
    probe.destroy();
    sts.destroy();

    if (id.Account !== view.Id) {
      return {
        partnerKey, accountId: view.Id, ok: false, actualAccountId: id.Account,
        error: `role 实际进入的是 ${id.Account}，与配置的 ${view.Id} 不一致`,
      };
    }
    return { partnerKey, accountId: view.Id, ok: true, actualAccountId: id.Account };
  } catch (e: any) {
    return { partnerKey, accountId: view.Id, ok: false, error: e.name || e.message };
  }
}
