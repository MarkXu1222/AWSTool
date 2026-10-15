/**
 * MAP 打标角色的 aws:TagKeys 限制：先单账户金丝雀，验证后全量开启。
 *
 *   npx tsx scripts/tag-keys-canary.ts --payer <12位> --account <12位> --enforce true|false   # 单账户参数覆盖
 *   npx tsx scripts/tag-keys-canary.ts --payer <12位> --all                                  # 全量开启（含 payer 自身角色）
 *   npx tsx scripts/tag-keys-canary.ts --payer <12位> --status [--account <12位>]            # 只读：参数与最近操作
 *
 * 只在 EC2 上手动执行。写操作只打印操作 ID，进度到 CloudFormation 控制台或 --status 查看。
 * 平台重跑接入不会改动 EnforceTagKeys（resolveAutoTaggerParams 沿用现值），切换只走本脚本。
 */
import fs from 'fs';
import path from 'path';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import {
  CloudFormationClient, DescribeStackSetCommand, DescribeStackInstanceCommand,
  ListStackSetOperationsCommand, UpdateStackInstancesCommand, UpdateStackSetCommand,
} from '@aws-sdk/client-cloudformation';
import { OrganizationsClient, ListRootsCommand } from '@aws-sdk/client-organizations';
import { IAMClient, PutRolePolicyCommand } from '@aws-sdk/client-iam';
import { AUTO_TAGGER_INLINE_POLICY } from '../server/tag-compliance';

const STACK_SET = 'AutoTaggerRole';
const REGION = 'us-east-1';
const USAGE = `用法：
  npx tsx scripts/tag-keys-canary.ts --payer <12位> --account <12位> --enforce true|false
  npx tsx scripts/tag-keys-canary.ts --payer <12位> --all
  npx tsx scripts/tag-keys-canary.ts --payer <12位> --status [--account <12位>]`;

function fail(message: string): never {
  console.error(message ? `${message}\n\n${USAGE}` : USAGE);
  process.exit(2);
}

function parseArgs(argv: string[]) {
  const args: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith('--')) fail(`无法识别的参数：${key}`);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { args[key.slice(2)] = next; i++; }
    else args[key.slice(2)] = true;
  }
  const payer = args.payer;
  if (typeof payer !== 'string' || !/^\d{12}$/.test(payer)) fail('--payer 必须是 12 位账户 ID');
  const account = args.account;
  if (account !== undefined && (typeof account !== 'string' || !/^\d{12}$/.test(account))) fail('--account 必须是 12 位账户 ID');

  const modes = [args.enforce !== undefined, args.all === true, args.status === true].filter(Boolean).length;
  if (modes !== 1) fail('--enforce、--all、--status 必须且只能选一种');
  if (args.enforce !== undefined) {
    if (args.enforce !== 'true' && args.enforce !== 'false') fail('--enforce 只能是 true 或 false');
    if (!account) fail('--enforce 需要同时指定 --account');
    return { mode: 'enforce' as const, payer, account: account as string, enforce: args.enforce };
  }
  if (args.all === true) {
    if (account) fail('--all 不能与 --account 同用');
    return { mode: 'all' as const, payer };
  }
  return { mode: 'status' as const, payer, account: account as string | undefined };
}

async function payerCredentials(payer: string) {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../../config.json'), 'utf8'));
  const entry = (config.payers || []).find((p: { roleArn?: string }) => (p.roleArn || '').includes(`:${payer}:`));
  if (!entry) throw new Error(`config.payers 里没有 payer ${payer}`);
  const sts = new STSClient({ region: REGION, credentials: config.credentials });
  const r = await sts.send(new AssumeRoleCommand({ RoleArn: entry.roleArn, RoleSessionName: 'tag-keys-canary', DurationSeconds: 900 }));
  return {
    accessKeyId: r.Credentials!.AccessKeyId!,
    secretAccessKey: r.Credentials!.SecretAccessKey!,
    sessionToken: r.Credentials!.SessionToken!,
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const credentials = await payerCredentials(opts.payer);
  const cfn = new CloudFormationClient({ region: REGION, credentials });
  const described = await cfn.send(new DescribeStackSetCommand({ StackSetName: STACK_SET, CallAs: 'SELF' }));
  const param = (key: string) => described.StackSet?.Parameters?.find(p => p.ParameterKey === key)?.ParameterValue;

  if (opts.mode === 'status') {
    console.log(`StackSet ${STACK_SET}: CentralToolingAccountId=${param('CentralToolingAccountId')}`
      + ` AllowedTagKeys=${param('AllowedTagKeys')} EnforceTagKeys=${param('EnforceTagKeys')}`);
    const ops = await cfn.send(new ListStackSetOperationsCommand({ StackSetName: STACK_SET, CallAs: 'SELF', MaxResults: 3 }));
    for (const op of ops.Summaries || []) console.log(`  操作 ${op.OperationId} ${op.Action} ${op.Status}`);
    if (opts.account) {
      const instance = await cfn.send(new DescribeStackInstanceCommand({
        StackSetName: STACK_SET, StackInstanceAccount: opts.account, StackInstanceRegion: REGION, CallAs: 'SELF',
      }));
      const si = instance.StackInstance;
      console.log(`  实例 ${opts.account}: ${si?.StackInstanceStatus?.DetailedStatus || si?.Status}`
        + ` overrides=${JSON.stringify(si?.ParameterOverrides || [])}`);
    }
    return;
  }

  if (!param('EnforceTagKeys')) {
    throw new Error('StackSet 还没有 EnforceTagKeys 参数：请先在平台重跑接入，把模板更新到最小权限版本');
  }

  if (opts.mode === 'enforce') {
    const org = new OrganizationsClient({ region: REGION, credentials });
    const rootOuId = (await org.send(new ListRootsCommand({}))).Roots?.[0]?.Id;
    if (!rootOuId) throw new Error('未取到组织根 OU');
    const r = await cfn.send(new UpdateStackInstancesCommand({
      StackSetName: STACK_SET,
      CallAs: 'SELF',
      DeploymentTargets: { OrganizationalUnitIds: [rootOuId], Accounts: [opts.account], AccountFilterType: 'INTERSECTION' },
      Regions: [REGION],
      ParameterOverrides: [{ ParameterKey: 'EnforceTagKeys', ParameterValue: opts.enforce }],
    }));
    console.log(`已提交：账户 ${opts.account} EnforceTagKeys=${opts.enforce}，操作 ${r.OperationId}`);
    return;
  }

  // --all：StackSet 级开启，并同步 payer 自身的 auto-tagger-role（StackSet 覆盖不到管理账户）
  const r = await cfn.send(new UpdateStackSetCommand({
    StackSetName: STACK_SET,
    CallAs: 'SELF',
    UsePreviousTemplate: true,
    Capabilities: ['CAPABILITY_NAMED_IAM'],
    Parameters: [
      { ParameterKey: 'CentralToolingAccountId', UsePreviousValue: true },
      { ParameterKey: 'AllowedTagKeys', UsePreviousValue: true },
      { ParameterKey: 'EnforceTagKeys', ParameterValue: 'true' },
    ],
    OperationPreferences: { FailureTolerancePercentage: 100, MaxConcurrentPercentage: 100 },
  }));
  console.log(`已提交：StackSet 全量 EnforceTagKeys=true，操作 ${r.OperationId}`);

  const allowedTagKeys = (param('AllowedTagKeys') || 'map-migrated').split(',');
  const iam = new IAMClient({ region: REGION, credentials });
  await iam.send(new PutRolePolicyCommand({
    RoleName: 'auto-tagger-role',
    PolicyName: 'AutoTagPolicy',
    PolicyDocument: JSON.stringify(AUTO_TAGGER_INLINE_POLICY({ allowedTagKeys, enforceTagKeys: true })),
  }));
  console.log(`已更新 payer ${opts.payer} 的 auto-tagger-role：只允许写 ${allowedTagKeys.join(', ')}`);
}

main().catch(error => {
  console.error(`失败：${error?.name || 'Error'} ${error?.message || error}`);
  process.exit(1);
});
