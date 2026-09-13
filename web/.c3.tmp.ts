// 只读：确认这 3 个客户账户的归属、角色现状、StackSet 实例归属。
const { STSClient, AssumeRoleCommand } = require('@aws-sdk/client-sts');
const { OrganizationsClient, DescribeAccountCommand } = require('@aws-sdk/client-organizations');
const { CloudFormationClient, ListStackInstancesCommand, DescribeStackSetCommand } = require('@aws-sdk/client-cloudformation');
const { IAMClient, ListAttachedRolePoliciesCommand, ListRolePoliciesCommand, GetRolePolicyCommand, GetRoleCommand } = require('@aws-sdk/client-iam');
const cfg = require('../config.json');
const fs = require('fs');
const path = require('path');

const REGION = cfg.region || 'us-east-1';
const BASE = { accessKeyId: cfg.credentials.accessKeyId, secretAccessKey: cfg.credentials.secretAccessKey };
const cv = (c: any) => ({ accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken });
const TARGETS = ['949474132716', '336449586160', '242258466073'];

async function main() {
  // 从账户缓存定位归属
  const db = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/db.json'), 'utf8'));
  const cache = db.accounts_cache || [];
  console.log('=== 归属（来自平台账户缓存）===');
  const payerOf: Record<string, string> = {};
  for (const id of TARGETS) {
    const a = cache.find((x: any) => x.Id === id);
    if (a) {
      payerOf[id] = a._payer;
      console.log(`  ${id}  ${String(a.Name).padEnd(22)} ${a._payer}  status=${a.Status} joined=${a.JoinedMethod}`);
    } else {
      console.log(`  ${id}  不在账户缓存中`);
    }
  }

  const payers = [...new Set(Object.values(payerOf))];
  console.log(`\n涉及组织: ${payers.join(', ')}`);

  for (const payerName of payers) {
    const p = cfg.payers.find((x: any) => x.name === payerName);
    const ar = await new STSClient({ region: REGION, credentials: BASE })
      .send(new AssumeRoleCommand({ RoleArn: p.roleArn, RoleSessionName: 'c3', DurationSeconds: 3600 }));
    const creds = cv(ar.Credentials);
    const cf = new CloudFormationClient({ region: REGION, credentials: creds });

    console.log(`\n=== ${payerName} 的 StackSet 覆盖情况 ===`);
    for (const name of ['support-quota-role-orgwide', 'admin-console-role-orgwide']) {
      try {
        const d = await cf.send(new DescribeStackSetCommand({ StackSetName: name, CallAs: 'SELF' }));
        const inst: any[] = []; let t: string | undefined;
        do {
          const r = await cf.send(new ListStackInstancesCommand({ StackSetName: name, CallAs: 'SELF', NextToken: t, MaxResults: 100 }));
          inst.push(...(r.Summaries || [])); t = r.NextToken;
        } while (t);
        const mine = inst.filter(s => TARGETS.includes(s.Account));
        console.log(`  ${name}: 共 ${inst.length} 实例, 其中目标账户 ${mine.length} 个`);
        mine.forEach(s => console.log(`      ${s.Account} status=${s.StackInstanceStatus?.DetailedStatus} OU=${s.OrganizationalUnitId}`));
        console.log(`      部署目标 OU=${JSON.stringify(d.StackSet.OrganizationalUnitIds)} auto=${!!d.StackSet.AutoDeployment?.Enabled}`);
      } catch (e: any) {
        console.log(`  ${name}: ${e?.name}`);
      }
    }
  }

  console.log('\n=== 3 个账户上 support-quota / admin-console 的实际权限 ===');
  for (const id of TARGETS) {
    for (const role of ['support-quota', 'admin-console']) {
      try {
        const r = await new STSClient({ region: REGION, credentials: BASE })
          .send(new AssumeRoleCommand({ RoleArn: `arn:aws:iam::${id}:role/${role}`, RoleSessionName: 'c3', DurationSeconds: 900 }));
        const iam = new IAMClient({ region: REGION, credentials: cv(r.Credentials) });
        const att = await iam.send(new ListAttachedRolePoliciesCommand({ RoleName: role }));
        const inl = await iam.send(new ListRolePoliciesCommand({ RoleName: role }));
        const gr = await iam.send(new GetRoleCommand({ RoleName: role }));
        const trust = JSON.parse(decodeURIComponent(gr.Role.AssumeRolePolicyDocument));
        const hasExtId = JSON.stringify(trust).includes('ExternalId');
        console.log(`  ${id} / ${role}`);
        console.log(`      托管: ${(att.AttachedPolicies || []).map((x: any) => x.PolicyArn.split('/').pop()).join(', ') || '无'}`);
        console.log(`      内联: ${(inl.PolicyNames || []).join(', ') || '无'} | 信任含 ExternalId: ${hasExtId ? '是' : '否'}`);
      } catch (e: any) {
        console.log(`  ${id} / ${role}: ${e?.name}`);
      }
    }
  }
}
main().catch(e => { console.error('FATAL', e?.name, e?.message); process.exit(1); });
