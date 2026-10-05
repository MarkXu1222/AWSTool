/**
 * MAP 全自动接入：成员账户在接入前自建过 Resource Explorer 索引。
 *
 * koreawallpaper（2026-10）实际踩过：15 个 StackSet 实例以 AlreadyExists 失败，
 * CloudFormation 把它们标成 Status=OUTDATED / DetailedStatus=FAILED。旧逻辑只认
 * FAILED、且不覆盖聚合索引 StackSet，于是每 3 分钟重试一次直到 90 分钟超时，
 * 组织始终没写进 orgs.json，整个组织一个 tag 都没打上。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isExistingIndexConflict,
  classifyExistingIndex,
  RE_AGGREGATOR_STACKSET,
  RE_LOCAL_STACKSET,
  RE_SCOPED_LOCAL_STACKSET,
} from '../server/tag-compliance';

const REAL_REASON = 'ResourceLogicalId:Index, ResourceType:AWS::ResourceExplorer2::Index, '
  + 'ResourceStatusReason:Resource handler returned message: "Could not create the index: '
  + 'An index already exists in this AWS Region. (Service: ResourceExplorer2, Status Code: 409)" '
  + '(HandlerErrorCode: AlreadyExists).';

test('OUTDATED 状态的 AlreadyExists 也识别为已有索引（koreawallpaper 实际状态）', () => {
  for (const name of [RE_AGGREGATOR_STACKSET, RE_LOCAL_STACKSET, RE_SCOPED_LOCAL_STACKSET]) {
    assert.equal(isExistingIndexConflict(name, 'OUTDATED', REAL_REASON), true, name);
    assert.equal(isExistingIndexConflict(name, 'FAILED', REAL_REASON), true, name);
  }
});

test('其它失败原因或非索引 StackSet 不能被当成已有索引而被跳过', () => {
  assert.equal(isExistingIndexConflict(RE_LOCAL_STACKSET, 'OUTDATED', 'Account is not activated'), false);
  assert.equal(isExistingIndexConflict(RE_LOCAL_STACKSET, 'OUTDATED', undefined), false);
  assert.equal(isExistingIndexConflict('AutoTaggerRole', 'FAILED', REAL_REASON), false);
  assert.equal(isExistingIndexConflict(RE_LOCAL_STACKSET, 'CANCELLED', REAL_REASON), false);
});

test('聚合区：已是 AGGREGATOR 直接复用，LOCAL 需要升级', () => {
  assert.equal(classifyExistingIndex(RE_AGGREGATOR_STACKSET, 'us-east-1', { Type: 'AGGREGATOR', State: 'ACTIVE' }), 'ready');
  assert.equal(classifyExistingIndex(RE_AGGREGATOR_STACKSET, 'us-east-1', { Type: 'LOCAL', State: 'ACTIVE' }), 'upgrade');
  // 升级提交后进入 UPDATING，等待而不是判失败或重复提交
  assert.equal(classifyExistingIndex(RE_AGGREGATOR_STACKSET, 'us-east-1', { Type: 'AGGREGATOR', State: 'UPDATING' }), 'pending');
});

test('本地区：只有已向聚合区复制的 LOCAL 索引才算覆盖', () => {
  assert.equal(classifyExistingIndex(RE_LOCAL_STACKSET, 'us-east-1',
    { Type: 'LOCAL', State: 'ACTIVE', ReplicatingTo: ['us-east-1'] }), 'ready');
  // 聚合区刚升级时复制尚未建立：等待，不能当缺口重建（会再次 AlreadyExists）
  assert.equal(classifyExistingIndex(RE_LOCAL_STACKSET, 'us-east-1',
    { Type: 'LOCAL', State: 'ACTIVE', ReplicatingTo: [] }), 'pending');
  assert.equal(classifyExistingIndex(RE_SCOPED_LOCAL_STACKSET, 'us-east-1',
    { Type: 'LOCAL', State: 'ACTIVE', ReplicatingTo: ['us-east-1'] }), 'ready');
});

test('无法自动处理的已有索引判为 invalid，交给人工而不是无限重试', () => {
  // 本地区域被占成了聚合索引：单账户只能有一个聚合区，必须人工决定
  assert.equal(classifyExistingIndex(RE_LOCAL_STACKSET, 'us-east-1', { Type: 'AGGREGATOR', State: 'ACTIVE' }), 'invalid');
  assert.equal(classifyExistingIndex(RE_LOCAL_STACKSET, 'us-east-1', { Type: 'LOCAL', State: 'DELETING' }), 'invalid');
  assert.equal(classifyExistingIndex(RE_AGGREGATOR_STACKSET, 'us-east-1', null), 'invalid');
  assert.equal(classifyExistingIndex('AutoTaggerRole', 'us-east-1', { Type: 'LOCAL', State: 'ACTIVE' }), 'invalid');
});
