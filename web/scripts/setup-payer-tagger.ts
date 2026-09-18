/**
 * 在各 payer 管理账户内创建 auto-tagger-role，并从 orgs.json 里移除对 payer 自身的排除。
 *
 * 背景：SERVICE_MANAGED StackSet 不部署到管理账户，所以 payer 自己没有打标角色，
 * 过去用 exclude_accounts 排除掉。现在业务要求 payer 资源也打 MAP 标签。
 *
 * 顺序很重要：**先建角色，再去排除**。反了会出现「扫描发现资源但 AssumeRole 失败」，
 * 报告里每天一批 failed。
 *
 * 用法：
 *   npx tsx scripts/setup-payer-tagger.ts            # dry-run，只看要做什么
 *   npx tsx scripts/setup-payer-tagger.ts --apply    # 实际执行
 */
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { IAMClient, GetRoleCommand, CreateRoleCommand, AttachRolePolicyCommand } from '@aws-sdk/client-iam';
import { getOrgsConfigSnapshot, putOrgsConfig, getOrgPayerMap } from '../server/tag-compliance';
import path from 'path';
import fs from 'fs';

const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../../config.json'), 'utf-8'));
const BASE = {
  accessKeyId: config.credentials?.accessKeyId || process.env.AWS_ACCESS_KEY_ID || '',
  secretAccessKey: config.credentials?.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY || '',
};
const CENTRAL = /arn:aws:iam::(\d+):/.exec(String(config.tagCompliance?.roleArn || ''))?.[1] || '382309211956';
const APPLY = process.argv.includes('--apply');

const MANAGED_POLICIES = [
  'arn:aws:iam::aws:policy/ResourceGroupsandTagEditorFullAccess',
  'arn:aws:iam::aws:policy/ReadOnlyAccess',
];

async function assumePayer(roleArn: string) {
  const sts = new STSClient({ region: 'us-east-1', credentials: BASE });
  const r = await sts.send(new AssumeRoleCommand({
    RoleArn: roleArn, RoleSessionName: 'setup-payer-tagger', DurationSeconds: 3600,
  }));
  return {
    accessKeyId: r.Credentials!.AccessKeyId!,
    secretAccessKey: r.Credentials!.SecretAccessKey!,
    sessionToken: r.Credentials!.SessionToken!,
  };
}

async function ensureRole(creds: any, payerName: string): Promise<string> {
  const iam = new IAMClient({ region: 'us-east-1', credentials: creds });
  try {
    await iam.send(new GetRoleCommand({ RoleName: 'auto-tagger-role' }));
    return '已存在';
  } catch (e: any) {
    if (e.name !== 'NoSuchEntityException') throw e;
  }
  if (!APPLY) return '将创建（dry-run）';

  await iam.send(new CreateRoleCommand({
    RoleName: 'auto-tagger-role',
    Description: 'Central tag-compliance auto-tagger (payer account, managed by AWSTool)',
    AssumeRolePolicyDocument: JSON.stringify({
      Version: '2012-10-17',
      Statement: [{
        Effect: 'Allow',
        Principal: { AWS: `arn:aws:iam::${CENTRAL}:root` },
        Action: 'sts:AssumeRole',
        Condition: { StringLike: { 'aws:PrincipalArn': `arn:aws:iam::${CENTRAL}:role/tag-compliance*` } },
      }],
    }),
    Tags: [{ Key: 'ManagedBy', Value: 'AWSTool' }, { Key: 'Purpose', Value: 'AutoTagger' }],
  }));
  for (const p of MANAGED_POLICIES) {
    await iam.send(new AttachRolePolicyCommand({ RoleName: 'auto-tagger-role', PolicyArn: p }));
  }
  return '已创建';
}

async function main() {
  console.log(`中央工具账户: ${CENTRAL}  模式: ${APPLY ? '实际执行' : 'DRY-RUN（加 --apply 才会改）'}\n`);

  const orgPayer = await getOrgPayerMap();
  const snapshot = await getOrgsConfigSnapshot();

  // ---- 第 1 步：所有 payer 建角色 ----
  console.log('=== 第 1 步：在 payer 管理账户创建 auto-tagger-role ===');
  const roleOk = new Map<string, boolean>();
  for (const [orgId, info] of Object.entries<any>(orgPayer)) {
    const payer = (config.payers || []).find((p: any) => p.roleArn?.includes(`::${info.payerAccountId}:`));
    if (!payer) { console.log(`  ${info.payerName}: config.json 里没有该 payer，跳过`); continue; }
    try {
      const creds = await assumePayer(payer.roleArn);
      const st = await ensureRole(creds, info.payerName);
      console.log(`  ${info.payerName.padEnd(12)} ${info.payerAccountId}  ${st}`);
      roleOk.set(orgId, st !== '将创建（dry-run）');
    } catch (e: any) {
      console.log(`  ${info.payerName.padEnd(12)} ${info.payerAccountId}  失败: ${e.name} ${e.message}`);
      roleOk.set(orgId, false);
    }
  }

  // ---- 第 2 步：移除 exclude_accounts 里的 payer 自身 ----
  console.log('\n=== 第 2 步：从 orgs.json 移除对 payer 自身的排除 ===');
  const next = snapshot.orgs.map((o: any) => {
    const info = orgPayer[o.org_id];
    if (!info) return o;
    const list = String(o.exclude_accounts || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!list.includes(info.payerAccountId)) {
      console.log(`  ${o.org_id} (${info.payerName}): 未排除 payer，无需改`);
      return o;
    }
    if (!roleOk.get(o.org_id)) {
      console.log(`  ${o.org_id} (${info.payerName}): ⚠️ 角色未就绪，保留排除（避免每天报 failed）`);
      return o;
    }
    const kept = list.filter(a => a !== info.payerAccountId);
    console.log(`  ${o.org_id} (${info.payerName}): 移除 ${info.payerAccountId}`
      + (kept.length ? `，保留 ${kept.join(',')}` : '，排除清单清空'));
    const copy = { ...o };
    if (kept.length) copy.exclude_accounts = kept.join(',');
    else delete copy.exclude_accounts;
    return copy;
  });

  if (!APPLY) { console.log('\nDRY-RUN 结束，未写入 S3。确认无误后加 --apply 重跑。'); return; }
  const changed = JSON.stringify(next) !== JSON.stringify(snapshot.orgs);
  if (!changed) { console.log('\n配置无变化，未写 S3。'); return; }
  // putOrgsConfig 第二参是裸 etag 字符串（不是 { etag } 对象），传错会被当成
  // header 值序列化成 "[object Object]" → Invalid character in header content
  const res = await putOrgsConfig(next, snapshot.etag);
  console.log(`\n✅ orgs.json 已更新（${res.count} 个组织，version=${res.versionId || '-'}）`);
}

main().then(() => process.exit(0)).catch(e => { console.error('ERR', e?.name, e?.message); process.exit(1); });
