/**
 * POC Cash 创建商机时 Solution 的默认值与校验。
 *
 * 默认值来自 Partner Central 的实时 Active 列表，代码里只保留「偏好」。
 * 锁死两件事：
 *  1. 有 Active Solution 时不能建出无 Solution 的商机（多个却没选、选了不在列表里都要在建商机前拒绝）；
 *  2. 列表为空或查询失败时放行，商机照建并记 warning —— 不能因为查不到 Solution 就卡住建商机。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveSolutionDefault, decideSolutionForCreate, getPartner,
} from '../server/poc-cash';

const webby = getPartner('webby');
const mergebytes = getPartner('mergebytes');
const WEBBY_ACTIVE = ['S-0099756', 'S-0094524', 'S-0087929', 'S-0070517', 'S-0067877'];

test('resolveSolutionDefault：没有 Active 时无默认值', () => {
  assert.equal(resolveSolutionDefault([], 'S-0070517'), null);
  assert.equal(resolveSolutionDefault([]), null);
});

test('resolveSolutionDefault：优先项在列表里时用优先项', () => {
  assert.equal(resolveSolutionDefault(WEBBY_ACTIVE, 'S-0070517'), 'S-0070517');
});

test('resolveSolutionDefault：只有一个 Active 时用它，即便优先项不在列表', () => {
  assert.equal(resolveSolutionDefault(['S-0100389']), 'S-0100389');
  assert.equal(resolveSolutionDefault(['S-0100389'], 'S-0070517'), 'S-0100389');
});

test('resolveSolutionDefault：多个且无可用优先项时不自动选', () => {
  assert.equal(resolveSolutionDefault(['S-1', 'S-2']), null);
  assert.equal(resolveSolutionDefault(['S-1', 'S-2'], 'S-0070517'), null);
});

test('主体只保留 Solution 偏好，Mergebytes 无偏好', () => {
  assert.equal(webby.preferredSolutionId, 'S-0070517');
  assert.equal(mergebytes.preferredSolutionId, undefined);
});

test('decide：所选 Solution 在 Active 列表里就用它', () => {
  const r = decideSolutionForCreate(webby, 'S-0094524', { ok: true, activeIds: WEBBY_ACTIVE });
  assert.deepEqual(r, { solutionId: 'S-0094524', warnings: [] });
});

test('decide：所选 Solution 不在 Active 列表时拒绝（含列表为空）', () => {
  assert.throws(
    () => decideSolutionForCreate(webby, 'S-0099438', { ok: true, activeIds: WEBBY_ACTIVE }),
    /Solution S-0099438 不是 Webby 的 Active Solution，请刷新页面后重新选择/);
  assert.throws(
    () => decideSolutionForCreate(mergebytes, 'S-0070517', { ok: true, activeIds: [] }),
    /不是 Mergebytes 的 Active Solution/);
});

test('decide：未选时按默认值规则自动选', () => {
  assert.deepEqual(
    decideSolutionForCreate(webby, undefined, { ok: true, activeIds: WEBBY_ACTIVE }),
    { solutionId: 'S-0070517', warnings: [] });
  // 空白等同未选
  assert.deepEqual(
    decideSolutionForCreate(mergebytes, '  ', { ok: true, activeIds: ['S-0100389'] }),
    { solutionId: 'S-0100389', warnings: [] });
});

test('decide：没有 Active Solution 且未选时放行并记 warning', () => {
  const r = decideSolutionForCreate(mergebytes, undefined, { ok: true, activeIds: [] });
  assert.equal(r.solutionId, undefined);
  assert.deepEqual(r.warnings,
    ['Mergebytes 没有 Active 的 Solution，已跳过关联。在 Partner Central 发布 Solution 后会自动关联。']);
});

test('decide：多个 Active 却没选时拒绝，不建无 Solution 的商机', () => {
  assert.throws(
    () => decideSolutionForCreate(mergebytes, undefined, { ok: true, activeIds: ['S-1', 'S-2'] }),
    /Mergebytes 有 2 个 Active Solution，请选择要关联的 Solution/);
});

test('decide：查询失败但已选时照用所选', () => {
  assert.deepEqual(
    decideSolutionForCreate(mergebytes, 'S-0100389', { ok: false, error: 'Throttling' }),
    { solutionId: 'S-0100389', warnings: [] });
});

test('decide：查询失败且未选时，有优先项回落优先项', () => {
  const r = decideSolutionForCreate(webby, undefined, { ok: false, error: 'Throttling' });
  assert.equal(r.solutionId, 'S-0070517');
  assert.deepEqual(r.warnings, ['查询 Solution 列表失败（Throttling），按优先项 S-0070517 关联。']);
});

test('decide：查询失败且未选、无优先项时跳过关联', () => {
  const r = decideSolutionForCreate(mergebytes, undefined, { ok: false, error: 'Throttling' });
  assert.equal(r.solutionId, undefined);
  assert.deepEqual(r.warnings, ['查询 Solution 列表失败（Throttling），已跳过关联。']);
});
