/**
 * 盘点各 payer 的角色部署情况（只读，不改任何资源）
 *
 * 输出：
 * 1. 每个 payer 的两个 StackSet（support-quota-role-orgwide / admin-console-role-orgwide）
 *    真实状态：是否存在、PermissionModel、AutoDeployment、实例数与失败数
 * 2. 组织账户构成（CREATED / INVITED）
 * 3. OrganizationAccountAccessRole（组织默认角色）抽样探测：
 *    CREATED（在管理账户中创建）自带该角色，INVITED（邀请加入）不带
 *
 * 用法（web/ 目录下）：
 *   env -u AWS_PROFILE npx tsx scripts/audit-org-roles.mts
 *   env -u AWS_PROFILE npx tsx scripts/audit-org-roles.mts --payer FFCloud --oaar-sample 3
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { OrganizationsClient, ListAccountsCommand } from '@aws-sdk/client-organizations';
import {
  CloudFormationClient, DescribeStackSetCommand, ListStackInstancesCommand,
} from '@aws-sdk/client-cloudformation';

const argv = process.argv.slice(2);
const opt = (f: string, d?: string) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const onlyPayer = opt('--payer');
const csvPath = opt('--csv');
const OAAR_SAMPLE = Math.max(0, Number(opt('--oaar-sample', '2')));

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(SCRIPT_DIR, '../../config.json'), 'utf-8'));
const BASE_CREDS = {
  accessKeyId: config.credentials.accessKeyId,
  secretAccessKey: config.credentials.secretAccessKey,
};
const SUPPORT_STACKSET = 'support-quota-role-orgwide';
const ADMIN_STACKSET = 'admin-console-role-orgwide';

interface StackSetInfo {
  exists: boolean;
  status?: string;
  permissionModel?: string;
  autoDeployment?: boolean;
  instances?: number;
  failed?: number;
  error?: string;
}

async function payerCreds(roleArn: string) {
  const sts = new STSClient({ region: 'us-east-1', credentials: BASE_CREDS });
  const r = await sts.send(new AssumeRoleCommand({ RoleArn: roleArn, RoleSessionName: 'role-audit' }));
  return {
    accessKeyId: r.Credentials!.AccessKeyId!,
    secretAccessKey: r.Credentials!.SecretAccessKey!,
    sessionToken: r.Credentials!.SessionToken!,
  };
}

async function describeStackSet(cf: CloudFormationClient, name: string): Promise<StackSetInfo> {
  try {
    const d = await cf.send(new DescribeStackSetCommand({ StackSetName: name, CallAs: 'SELF' }));
    const ss = d.StackSet!;
    let instances = 0, failed = 0, token: string | undefined;
    do {
      const r = await cf.send(new ListStackInstancesCommand({
        StackSetName: name, CallAs: 'SELF', NextToken: token, MaxResults: 100,
      }));
      for (const inst of r.Summaries || []) {
        instances++;
        const st = inst.StackInstanceStatus?.DetailedStatus || inst.Status;
        if (st && !['SUCCEEDED', 'CURRENT'].includes(st)) failed++;
      }
      token = r.NextToken;
    } while (token);
    return {
      exists: true,
      status: ss.Status,
      permissionModel: ss.PermissionModel,
      autoDeployment: !!ss.AutoDeployment?.Enabled,
      instances,
      failed,
    };
  } catch (e: any) {
    if (e?.name === 'StackSetNotFoundException') return { exists: false };
    return { exists: false, error: `${e?.name}: ${String(e?.message).slice(0, 60)}` };
  }
}

// 抽样探测成员账户的 OrganizationAccountAccessRole 是否存在且可从 payer assume
async function probeOaar(creds: any, payerAccountId: string, accounts: any[]) {
  const sts = new STSClient({ region: 'us-east-1', credentials: creds });
  const out: { id: string; name?: string; joined?: string; ok: boolean; err?: string }[] = [];
  for (const a of accounts) {
    if (a.Id === payerAccountId || a.Status !== 'ACTIVE') continue;
    try {
      await sts.send(new AssumeRoleCommand({
        RoleArn: `arn:aws:iam::${a.Id}:role/OrganizationAccountAccessRole`,
        RoleSessionName: 'oaar-probe',
        DurationSeconds: 900,
      }));
      out.push({ id: a.Id, name: a.Name, joined: a.JoinedMethod, ok: true });
    } catch (e: any) {
      out.push({ id: a.Id, name: a.Name, joined: a.JoinedMethod, ok: false, err: e?.name || 'Error' });
    }
    if (out.length >= OAAR_SAMPLE) break;
  }
  return out;
}

(async () => {
  const payers: { name: string; roleArn: string }[] = (config.payers || [])
    .filter((p: any) => !onlyPayer || p.name === onlyPayer);
  if (!payers.length) { console.error('没有匹配的 payer'); process.exit(1); }

  const consoleAdmin: string[] = config.consoleAdminPayers || [];
  const rows: any[] = [];
  console.log(`盘点 ${payers.length} 个 payer（OAAR 抽样 ${OAAR_SAMPLE} 个/组织）\n`);

  for (const p of payers) {
    const acctId = p.roleArn.split(':')[4];
    const row: any = { payer: p.name, managementAccount: acctId, inConsoleAdminList: consoleAdmin.includes(p.name) };
    try {
      const creds = await payerCreds(p.roleArn);
      const cf = new CloudFormationClient({ region: 'us-east-1', credentials: creds });
      const [sup, adm] = await Promise.all([
        describeStackSet(cf, SUPPORT_STACKSET),
        describeStackSet(cf, ADMIN_STACKSET),
      ]);
      row.support = sup;
      row.admin = adm;

      const org = new OrganizationsClient({ region: 'us-east-1', credentials: creds });
      const accounts: any[] = [];
      let token: string | undefined;
      do {
        const r: any = await org.send(new ListAccountsCommand({ NextToken: token }));
        accounts.push(...(r.Accounts || []));
        token = r.NextToken;
      } while (token);
      row.totalAccounts = accounts.length;
      row.invited = accounts.filter(a => a.JoinedMethod === 'INVITED').length;
      row.created = accounts.filter(a => a.JoinedMethod === 'CREATED').length;
      row.oaar = OAAR_SAMPLE > 0 ? await probeOaar(creds, acctId, accounts) : [];
    } catch (e: any) {
      row.error = `${e?.name}: ${String(e?.message).slice(0, 80)}`;
    }
    rows.push(row);

    const f = (s?: StackSetInfo) => !s ? '-' : s.exists
      ? `${s.instances} 实例${s.failed ? ` / ${s.failed} 失败` : ''} · ${s.permissionModel === 'SERVICE_MANAGED' ? 'SM' : s.permissionModel} · auto=${s.autoDeployment ? 'Y' : 'N'} · ${s.status}`
      : (s.error ? `ERR ${s.error}` : '❌ 不存在');
    const oaarOk = (row.oaar || []).filter((o: any) => o.ok).length;
    console.log(`${row.error ? '❌' : '•'} ${p.name} (${acctId}) 账户 ${row.totalAccounts ?? '?'} [CREATED ${row.created ?? '?'} / INVITED ${row.invited ?? '?'}]`);
    console.log(`    support-quota : ${f(row.support)}`);
    console.log(`    admin-console : ${f(row.admin)}`);
    if (OAAR_SAMPLE > 0 && !row.error) {
      console.log(`    OAAR 抽样      : ${oaarOk}/${(row.oaar || []).length}` +
        (row.oaar || []).map((o: any) => ` · ${o.id}(${o.joined || '?'})${o.ok ? '✓' : '✗' + (o.err || '')}`).join(''));
    }
    if (row.error) console.log(`    ERROR: ${row.error}`);
  }

  console.log('\n========== 汇总 ==========');
  const ok = rows.filter(r => !r.error);
  const admInstalled = ok.filter(r => r.admin?.exists);
  const admMissing = ok.filter(r => !r.admin?.exists);
  const supInstalled = ok.filter(r => r.support?.exists);
  console.log(`可访问 payer:            ${ok.length}/${rows.length}`);
  console.log(`admin-console 已安装:    ${admInstalled.length}`);
  console.log(`admin-console 未安装:    ${admMissing.length}`);
  console.log(`support-quota 已安装:    ${supInstalled.length}`);
  const admFailed = admInstalled.filter(r => (r.admin.failed || 0) > 0);
  if (admFailed.length) console.log(`admin-console 有失败实例: ${admFailed.map(r => `${r.payer}(${r.admin.failed})`).join(', ')}`);
  const noAuto = admInstalled.filter(r => !r.admin.autoDeployment);
  if (noAuto.length) console.log(`⚠️ AutoDeployment 关闭:   ${noAuto.map(r => r.payer).join(', ')}`);
  if (admMissing.length) {
    console.log('\n未安装 admin-console 的 payer:');
    for (const r of admMissing) console.log(`  ${r.payer} (${r.managementAccount}) 账户 ${r.totalAccounts}${r.inConsoleAdminList ? '  ⚠️ 但已在 consoleAdminPayers 白名单' : ''}`);
  }
  const inconsistent = ok.filter(r => r.inConsoleAdminList !== !!r.admin?.exists);
  if (inconsistent.length) {
    console.log('\n⚠️ consoleAdminPayers 白名单与实际部署不一致:');
    for (const r of inconsistent) console.log(`  ${r.payer}: 白名单=${r.inConsoleAdminList ? '是' : '否'} 实际=${r.admin?.exists ? '已部署' : '未部署'}`);
  }
  const totalInvited = ok.reduce((s, r) => s + (r.invited || 0), 0);
  const totalCreated = ok.reduce((s, r) => s + (r.created || 0), 0);
  const allOaar = ok.flatMap(r => r.oaar || []);
  console.log(`\n账户来源合计: CREATED ${totalCreated} / INVITED ${totalInvited}`);
  console.log(`OAAR 抽样合计: ${allOaar.filter((o: any) => o.ok).length}/${allOaar.length} 可 assume`);
  const byJoin = (j: string) => {
    const s = allOaar.filter((o: any) => o.joined === j);
    return `${s.filter((o: any) => o.ok).length}/${s.length}`;
  };
  console.log(`  其中 CREATED: ${byJoin('CREATED')} · INVITED: ${byJoin('INVITED')}`);

  if (csvPath) {
    const lines = ['payer,management_account,in_console_admin_list,total_accounts,created,invited,support_exists,support_instances,support_failed,support_auto,admin_exists,admin_instances,admin_failed,admin_auto,oaar_ok,oaar_total,error'];
    for (const r of rows) {
      const oaarOk = (r.oaar || []).filter((o: any) => o.ok).length;
      lines.push([
        r.payer, r.managementAccount, r.inConsoleAdminList, r.totalAccounts ?? '',
        r.created ?? '', r.invited ?? '',
        r.support?.exists ?? '', r.support?.instances ?? '', r.support?.failed ?? '', r.support?.autoDeployment ?? '',
        r.admin?.exists ?? '', r.admin?.instances ?? '', r.admin?.failed ?? '', r.admin?.autoDeployment ?? '',
        oaarOk, (r.oaar || []).length,
        `"${(r.error || '').replace(/"/g, '""')}"`,
      ].join(','));
    }
    fs.writeFileSync(csvPath, lines.join('\n'));
    console.log(`\nCSV: ${csvPath}`);
  }
  fs.writeFileSync('/tmp/org-roles-audit.json', JSON.stringify(rows, null, 2));
  console.log('JSON: /tmp/org-roles-audit.json');
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
