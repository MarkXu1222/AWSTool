/**
 * 修正 payer 账户 auto-tagger-role 的权限。
 *
 * 教训：最初给 payer 角色附的是托管策略
 * ResourceGroupsandTagEditorFullAccess + ReadOnlyAccess，
 * 但前者**只给 tag:TagResources / resource-groups:***，
 * 不含各服务自身的打标 API（athena:TagResource、logs:TagResource、
 * s3:PutBucketTagging ...）。而 TagResources 底层是代调各服务 API，
 * 所以实际打标全部 AccessDenied。
 *
 * 正确做法：用与 AUTO_TAGGER_ROLE_TEMPLATE 完全相同的内联策略
 * （从 CFN 模板里解析出 Action 列表，保证单一数据源、不会两处漂移）。
 *
 * 用法: npx tsx scripts/fix-payer-tagger-policy.ts [--apply]
 */
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import {
  IAMClient, PutRolePolicyCommand, DetachRolePolicyCommand,
  ListAttachedRolePoliciesCommand,
} from '@aws-sdk/client-iam';
import { getOrgPayerMap, AUTO_TAGGER_INLINE_POLICY } from '../server/tag-compliance';
import path from 'path';
import fs from 'fs';

const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../../config.json'), 'utf-8'));
const BASE = {
  accessKeyId: config.credentials?.accessKeyId || process.env.AWS_ACCESS_KEY_ID || '',
  secretAccessKey: config.credentials?.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY || '',
};
const APPLY = process.argv.includes('--apply');

async function main() {
  const policy = AUTO_TAGGER_INLINE_POLICY();
  console.log(`内联策略 Action 数: ${policy.Statement.reduce((s: number, st: any) => s + st.Action.length, 0)}`);
  console.log(`模式: ${APPLY ? '实际执行' : 'DRY-RUN'}\n`);

  for (const [, info] of Object.entries<any>(await getOrgPayerMap())) {
    const payer = (config.payers || []).find((p: any) => p.roleArn?.includes(`::${info.payerAccountId}:`));
    if (!payer) continue;
    try {
      const sts = new STSClient({ region: 'us-east-1', credentials: BASE });
      const h = await sts.send(new AssumeRoleCommand({
        RoleArn: payer.roleArn, RoleSessionName: 'fix-tagger-policy', DurationSeconds: 3600,
      }));
      const iam = new IAMClient({
        region: 'us-east-1',
        credentials: {
          accessKeyId: h.Credentials!.AccessKeyId!,
          secretAccessKey: h.Credentials!.SecretAccessKey!,
          sessionToken: h.Credentials!.SessionToken!,
        },
      });
      if (!APPLY) { console.log(`  ${info.payerName.padEnd(12)} 将写入内联策略 AutoTagPolicy 并卸载误加的托管策略`); continue; }

      await iam.send(new PutRolePolicyCommand({
        RoleName: 'auto-tagger-role',
        PolicyName: 'AutoTagPolicy',
        PolicyDocument: JSON.stringify(policy),
      }));
      // 卸掉最初误加的 ResourceGroupsandTagEditorFullAccess（权限不足且冗余）；
      // ReadOnlyAccess 保留：扫描器需要读资源现有 tag。
      const att = await iam.send(new ListAttachedRolePoliciesCommand({ RoleName: 'auto-tagger-role' }));
      for (const p of att.AttachedPolicies || []) {
        if (p.PolicyArn?.includes('ResourceGroupsandTagEditorFullAccess')) {
          await iam.send(new DetachRolePolicyCommand({ RoleName: 'auto-tagger-role', PolicyArn: p.PolicyArn }));
        }
      }
      console.log(`  ${info.payerName.padEnd(12)} ${info.payerAccountId}  ✅ 已修正`);
    } catch (e: any) {
      console.log(`  ${info.payerName.padEnd(12)} ${info.payerAccountId}  ❌ ${e.name}: ${e.message}`);
    }
  }
}

main().then(() => process.exit(0)).catch(e => { console.error('ERR', e?.name, e?.message); process.exit(1); });
