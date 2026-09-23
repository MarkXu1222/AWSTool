/**
 * APN 合作伙伴账户目录。
 *
 * 这里锁的是几条「错了会静默出事」的约束：
 *  1. APN 账户**不能**混进 config.payers —— listAccounts() 的 payer 循环是
 *     catch{skip}，AssumeRole 失败会被静默吞掉，账户永远不出现且无人知晓；
 *  2. 账户 ID 必须与 POC Cash 的 PARTNERS 一致 —— 两份数据各写一次会漂移，
 *     漂移后页面显示的账户和商机实际落地的账户不是同一个；
 *  3. 平台不可用功能必须显式列出 —— 前端据此禁用按钮，漏了就会给出
 *     点了必然 AccessDenied 的入口；
 *  4. 缺 roleArn 时状态必须是 UNCONFIGURED，不能装作 ACTIVE。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listApnAccounts, APN_UNAVAILABLE, consoleRoleFor,
  apnPartnerKeyForAccount } from '../server/apn-accounts';
import { PARTNERS } from '../server/poc-cash';
import fs from 'fs';
import path from 'path';

const CONFIG_PATH = path.join(__dirname, '../../config.json');
const rootConfig = (() => {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); } catch { return {}; }
})();

test('APN 账户与 POC Cash 的 PARTNERS 严格一一对应', () => {
  const apn = listApnAccounts();
  assert.equal(apn.length, PARTNERS.length);
  for (const p of PARTNERS) {
    const row = apn.find(a => a.partnerKey === p.key);
    assert.ok(row, `缺少 APN 账户: ${p.key}`);
    // 账户 ID 必须取自 PARTNERS，不能另写一份
    assert.equal(row!.Id, p.apnAccountId);
    assert.equal(row!.Name, p.label);
  }
});

test('APN 账户 ID 是 12 位且互不重复', () => {
  const apn = listApnAccounts();
  const ids = apn.map(a => a.Id);
  assert.equal(new Set(ids).size, ids.length, 'APN 账户 ID 重复');
  ids.forEach(id => assert.match(id, /^\d{12}$/, `账户 ID 非法: ${id}`));
});

test('APN 账户绝不能出现在 config.payers 中', () => {
  // 实测：平台基础凭证 AssumeRole 这两个账户的 tool/OAAR/support-quota/
  // admin-console 全部 AccessDenied，且 Organizations 接口同样被拒。
  // 一旦写进 payers，listAccounts() 会静默跳过，问题无法从界面察觉。
  const payerIds = new Set(
    (rootConfig.payers || []).map((p: any) => {
      const m = /arn:aws:iam::(\d+):role\//.exec(p.roleArn || '');
      return m ? m[1] : '';
    }).filter(Boolean),
  );
  for (const a of listApnAccounts()) {
    assert.ok(!payerIds.has(a.Id),
      `APN 账户 ${a.Id} 被误配成 payer，会导致账户列表静默丢失该账户`);
  }
});

test('APN 账户标记为不可 Payer、不可 Admin，且带 _isApn', () => {
  for (const a of listApnAccounts()) {
    assert.equal(a._isApn, true);
    assert.equal(a._isPayer, false, 'APN 账户不是组织管理账户');
    // 前端 ConsoleButton / RootCredentialsPanel 依赖这两个标志禁用入口
    assert.equal(a._consoleDual, false);
    assert.equal(a._adminRoleExcluded, true);
  }
});

test('不可用功能清单非空且覆盖关键入口', () => {
  assert.ok(APN_UNAVAILABLE.length > 0);
  const joined = APN_UNAVAILABLE.join(' ');
  // 这几项都是账户页上真实存在、且对 APN 账户必然失败的入口
  ['Root', '配额', 'MAP'].forEach(k =>
    assert.ok(joined.includes(k), `不可用清单应说明 ${k}`));
  // 控制台已通过 apn-console 角色打通，不应再出现在「不可用」里，
  // 否则前端会继续渲染禁用按钮，功能等于白做
  assert.ok(!joined.includes('控制台'), '控制台已可用，不应列为不可用');
  for (const a of listApnAccounts()) {
    assert.deepEqual(a.unavailable, APN_UNAVAILABLE);
  }
});

test('控制台角色与 Partner Central 角色是独立的一对，不共用凭据', () => {
  // 两者权限差距悬殊（仅 partnercentral:* vs AdministratorAccess）。
  // 共用 role 会让 POC Cash 的自动化顺带拿到管理员权限；
  // 共用 ExternalId 会让其中一个泄露时把管理员 role 一起暴露。
  const pc = rootConfig.partnerCentral || {};
  for (const p of PARTNERS) {
    const e = pc[p.configKey || p.key] || {};
    if (!e.consoleRoleArn) continue;
    assert.notEqual(e.consoleRoleArn, e.roleArn,
      `${p.key} 的控制台角色与 Partner Central 角色不得是同一个`);
    assert.notEqual(e.consoleExternalId, e.externalId,
      `${p.key} 的两个 ExternalId 不得相同`);
  }
});

test('控制台角色 ARN 指向该主体自己的账户', () => {
  // ARN 填错主体时 AssumeRole 一样成功，只是进错账户 ——
  // 用户会被送进另一个 APN 账户的控制台且毫无提示
  const pc = rootConfig.partnerCentral || {};
  for (const p of PARTNERS) {
    const arn = pc[p.configKey || p.key]?.consoleRoleArn;
    if (!arn) continue;
    const m = /^arn:aws:iam::(\d{12}):role\//.exec(arn);
    assert.ok(m, `${p.key} 的 consoleRoleArn 格式非法: ${arn}`);
    assert.equal(m![1], p.apnAccountId,
      `${p.key} 的控制台角色指向了 ${m![1]}，应为 ${p.apnAccountId}`);
  }
});

test('consoleConfigured 如实反映配置状态', () => {
  const pc = rootConfig.partnerCentral || {};
  for (const a of listApnAccounts()) {
    const expected = Boolean(pc[a.partnerKey]?.consoleRoleArn);
    assert.equal(a.consoleConfigured, expected,
      `${a.partnerKey} 的 consoleConfigured 与配置不符`);
  }
});

test('未知主体取控制台角色返回空而不抛错', () => {
  // 前端可能传任意值；返回空让调用方走「未配置」提示，
  // 抛错会变成 500，掩盖真实原因
  const r = consoleRoleFor('does-not-exist');
  assert.equal(r.roleArn, '');
  assert.equal(r.externalId, '');
});

test('apnPartnerKeyForAccount 只认 APN 账户', () => {
  for (const p of PARTNERS) {
    assert.equal(apnPartnerKeyForAccount(p.apnAccountId), p.key);
  }
  // 组织内的普通账户不能被误判成 APN —— 否则会被路由到 apn-console 分支，
  // 拿着错误的角色去登录
  assert.equal(apnPartnerKeyForAccount('225214954491'), null);
  assert.equal(apnPartnerKeyForAccount(''), null);
});

test('配置齐全的主体为 ACTIVE，缺 roleArn 的为 UNCONFIGURED', () => {
  for (const a of listApnAccounts()) {
    assert.equal(a.Status, a.configured ? 'ACTIVE' : 'UNCONFIGURED',
      `${a.partnerKey} 的状态与 configured 不一致`);
  }
});

test('线上两个主体当前均已配置 roleArn 与 ExternalId', () => {
  // ExternalId 是这两个 role 信任策略的硬要求，缺了 AssumeRole 必失败。
  // 此用例同时充当配置回归：谁把 config 改坏了这里会先红。
  const apn = listApnAccounts();
  const webby = apn.find(a => a.partnerKey === 'webby')!;
  const mb = apn.find(a => a.partnerKey === 'mergebytes')!;
  assert.equal(webby.Id, '105673812363');
  assert.equal(mb.Id, '072471709462');
  for (const a of [webby, mb]) {
    assert.ok(a.configured, `${a.partnerKey} 缺少 roleArn`);
    assert.ok(a.externalIdConfigured, `${a.partnerKey} 缺少 ExternalId`);
  }
});

test('两个主体的 ExternalId 必须不同', () => {
  // 共用同一个 ExternalId 会让其中一个泄露时波及另一个主体
  const pc = rootConfig.partnerCentral || {};
  const ids = PARTNERS
    .map(p => pc[p.configKey || p.key]?.externalId)
    .filter(Boolean);
  assert.equal(new Set(ids).size, ids.length, '不同主体不得共用 ExternalId');
});
