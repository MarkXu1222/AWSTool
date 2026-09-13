// 只读核实客户质询中的每一项事实。不做任何写操作。
const { STSClient, AssumeRoleCommand } = require('@aws-sdk/client-sts');
const { CloudFormationClient, ListStackSetsCommand, ListStackInstancesCommand, DescribeStackSetCommand } = require('@aws-sdk/client-cloudformation');
const cfg = require('../config.json');

const REGION = cfg.region || 'us-east-1';
const BASE = { accessKeyId: cfg.credentials.accessKeyId, secretAccessKey: cfg.credentials.secretAccessKey };
const cv = (c: any) => ({ accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken });
const TARGETS = ['949474132716', '336449586160', '242258466073'];
const PAYER = 'yanhuang19-zyronix';

async function main() {
  const p = cfg.payers.find((x: any) => x.name === PAYER);
  const ar = await new STSClient({ region: REGION, credentials: BASE })
    .send(new AssumeRoleCommand({ RoleArn: p.roleArn, RoleSessionName: 'verify', DurationSeconds: 3600 }));
  const payerCreds = cv(ar.Credentials);
  const cf = new CloudFormationClient({ region: REGION, credentials: payerCreds });

  console.log('=== A. 管理账号侧：所有相关 StackSet 及其在这 3 个账户的实例 ===');
  const ls = await cf.send(new ListStackSetsCommand({ Status: 'ACTIVE', CallAs: 'SELF', MaxResults: 100 }));
  for (const s of ls.Summaries || []) {
    const name = String(s.StackSetName);
    if (!/support-quota|admin-console/.test(name)) continue;
    const inst: any[] = [];
    let t: string | undefined;
    do {
      const r = await cf.send(new ListStackInstancesCommand({ StackSetName: name, CallAs: 'SELF', NextToken: t, MaxResults: 100 }));
      inst.push(...(r.Summaries || [])); t = r.NextToken;
    } while (t);
    const mine = inst.filter((x: any) => TARGETS.includes(x.Account));
    console.log(`\n  ${name}  (总实例 ${inst.length})`);
    if (mine.length === 0) {
      console.log('    这 3 个账户：无实例');
    } else {
      mine.forEach((x: any) => {
        console.log(`    ${x.Account}  ${x.Status}/${x.StackInstanceStatus?.DetailedStatus}  drift=${x.DriftStatus || 'n/a'}`);
        if (x.StatusReason) console.log(`        原因: ${String(x.StatusReason).slice(0, 160)}`);
      });
    }
  }

  console.log('\n\n=== B. 成员账号侧：账户内实际的 CloudFormation 栈 ===');
  console.log('（用 support-quota 只读凭证查询，ReadOnlyAccess 含 cloudformation:List*）');
  for (const id of TARGETS) {
    try {
      const r = await new STSClient({ region: REGION, credentials: BASE })
        .send(new AssumeRoleCommand({ RoleArn: `arn:aws:iam::${id}:role/support-quota`, RoleSessionName: 'verify', DurationSeconds: 900 }));
      const c2 = cv(r.Credentials);
      const cfm = new CloudFormationClient({ region: REGION, credentials: c2 });
      const { ListStacksCommand } = require('@aws-sdk/client-cloudformation');
      const st = await cfm.send(new ListStacksCommand({}));
      const rel = (st.StackSummaries || []).filter((x: any) => /support-quota|admin-console|StackSet/i.test(String(x.StackName)));
      console.log(`\n  ${id}: 相关栈 ${rel.length} 个`);
      rel.forEach((x: any) => console.log(`      ${x.StackName}  ${x.StackStatus}  创建=${String(x.CreationTime).slice(0, 24)}${x.DeletionTime ? ' 删除=' + String(x.DeletionTime).slice(0, 24) : ''}`));
      if (rel.length === 0) console.log('      （无 support-quota / admin-console 相关栈）');
    } catch (e: any) {
      console.log(`\n  ${id}: 查询失败 ${e?.name}`);
    }
  }

  console.log('\n\n=== C. stacksets-exec-* 角色是否存在及其权限 ===');
  for (const id of TARGETS) {
    try {
      const r = await new STSClient({ region: REGION, credentials: BASE })
        .send(new AssumeRoleCommand({ RoleArn: `arn:aws:iam::${id}:role/support-quota`, RoleSessionName: 'verify', DurationSeconds: 900 }));
      const c2 = cv(r.Credentials);
      const { IAMClient, ListRolesCommand, ListAttachedRolePoliciesCommand, GetRoleCommand } = require('@aws-sdk/client-iam');
      const iam = new IAMClient({ region: REGION, credentials: c2 });
      const all: any[] = [];
      let marker: string | undefined;
      do {
        const res: any = await iam.send(new ListRolesCommand({ Marker: marker, MaxItems: 200 }));
        all.push(...(res.Roles || []));
        marker = res.IsTruncated ? res.Marker : undefined;
      } while (marker);
      const execRoles = all.filter((x: any) => /stacksets-exec/i.test(String(x.RoleName)));
      console.log(`\n  ${id}: stacksets-exec 角色 ${execRoles.length} 个`);
      for (const role of execRoles) {
        const att = await iam.send(new ListAttachedRolePoliciesCommand({ RoleName: role.RoleName }));
        const gr = await iam.send(new GetRoleCommand({ RoleName: role.RoleName }));
        const trust = JSON.parse(decodeURIComponent(gr.Role.AssumeRolePolicyDocument));
        console.log(`      ${role.RoleName}`);
        console.log(`        创建时间: ${String(role.CreateDate).slice(0, 24)}`);
        console.log(`        托管策略: ${(att.AttachedPolicies || []).map((x: any) => x.PolicyArn.split('/').pop()).join(', ') || '无'}`);
        console.log(`        信任主体: ${JSON.stringify(trust.Statement.map((s: any) => s.Principal))}`);
      }
    } catch (e: any) {
      console.log(`\n  ${id}: 查询失败 ${e?.name}`);
    }
  }
}
main().catch(e => { console.error('FATAL', e?.name, e?.message); process.exit(1); });
