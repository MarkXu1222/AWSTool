// 只读：admin-console StackSet 实例显示 SUCCEEDED，但 AssumeRole 报 AccessDenied，
// 核实角色在这 3 个账户里的真实状态与信任策略。
const { STSClient, AssumeRoleCommand } = require('@aws-sdk/client-sts');
const { IAMClient, GetRoleCommand, ListAttachedRolePoliciesCommand } = require('@aws-sdk/client-iam');
const cfg = require('../config.json');

const REGION = cfg.region || 'us-east-1';
const BASE = { accessKeyId: cfg.credentials.accessKeyId, secretAccessKey: cfg.credentials.secretAccessKey };
const cv = (c: any) => ({ accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken });
const TARGETS = ['949474132716', '336449586160', '242258466073'];

async function main() {
  for (const id of TARGETS) {
    console.log(`\n=== ${id} ===`);

    // 用 support-quota（只读，含 iam:Get*）去看 admin-console 角色到底存不存在
    let ro: any = null;
    try {
      const r = await new STSClient({ region: REGION, credentials: BASE })
        .send(new AssumeRoleCommand({ RoleArn: `arn:aws:iam::${id}:role/support-quota`, RoleSessionName: 'chk', DurationSeconds: 900 }));
      ro = cv(r.Credentials);
    } catch (e: any) {
      console.log(`  support-quota 不可用: ${e?.name}`);
      continue;
    }

    const iam = new IAMClient({ region: REGION, credentials: ro });
    for (const roleName of ['admin-console', 'support-quota', 'OrganizationAccountAccessRole']) {
      try {
        const gr = await iam.send(new GetRoleCommand({ RoleName: roleName }));
        const trust = JSON.parse(decodeURIComponent(gr.Role.AssumeRolePolicyDocument));
        const att = await iam.send(new ListAttachedRolePoliciesCommand({ RoleName: roleName }));
        console.log(`  ${roleName}: 存在`);
        console.log(`      托管策略: ${(att.AttachedPolicies || []).map((x: any) => x.PolicyArn.split('/').pop()).join(', ') || '无'}`);
        console.log(`      信任主体: ${JSON.stringify(trust.Statement.map((s: any) => s.Principal))}`);
        if (trust.Statement.some((s: any) => s.Condition)) {
          console.log(`      信任条件: ${JSON.stringify(trust.Statement.map((s: any) => s.Condition).filter(Boolean))}`);
        }
      } catch (e: any) {
        console.log(`  ${roleName}: ${e?.name === 'NoSuchEntity' ? '不存在' : e?.name}`);
      }
    }

    // 实测 AssumeRole
    for (const roleName of ['admin-console']) {
      try {
        await new STSClient({ region: REGION, credentials: BASE })
          .send(new AssumeRoleCommand({ RoleArn: `arn:aws:iam::${id}:role/${roleName}`, RoleSessionName: 'chk', DurationSeconds: 900 }));
        console.log(`  实测 AssumeRole ${roleName}: 成功`);
      } catch (e: any) {
        console.log(`  实测 AssumeRole ${roleName}: ${e?.name} — ${String(e?.message || '').slice(0, 120)}`);
      }
    }
  }
}
main().catch(e => { console.error('FATAL', e?.name, e?.message); process.exit(1); });
