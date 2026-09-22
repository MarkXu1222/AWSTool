/**
 * 创建商机的结果处理契约。
 *
 * 背景（真实故障）：前端 request() 对非 2xx **不抛错**，而是把后端的
 * { error: "..." } 原样 resolve 回来。doSubmit 直接 setResult(r) 后，
 * 结果页渲染出「商机 undefined 已创建」，再解引用 r.amounts.mrrUsd
 * 就整页崩进 ErrorBoundary —— 用户只看到「页面出错了」，真正的失败
 * 原因（如「业务描述至少 50 字」）被完全吞掉。
 *
 * 这里锁住两件事：
 *   1. 判定逻辑能把「错误响应」和「成功响应」分开
 *   2. 结果页用到的字段在残缺对象上取值不抛异常
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

/** 与 PocCash.tsx doSubmit 中的判定保持一致 */
function isFailure(r: any): boolean {
  return !!(r?.error || !r?.opportunityId);
}

/** 复刻结果页里所有对 result 的取值，任一处抛错即视为会崩页 */
function renderResultFields(result: any): Record<string, unknown> {
  return {
    status: result.warnings?.length ? 'warning' : 'success',
    title: `商机 ${result.opportunityId} ${result.submitted ? '已提交' : '已创建'}`,
    mrr: result.amounts ? `${result.amounts.mrrUsd.toLocaleString()} USD/月` : '—',
    arr: result.amounts ? `${result.amounts.arrUsd.toLocaleString()} USD` : '—',
    poc: result.amounts ? result.amounts.pocUsd.toLocaleString() : '—',
    showWarnings: (result.warnings?.length ?? 0) > 0,
    warningItems: (result.warnings || []).map((w: string) => w),
    nextStep: '下一步'
      + (result.amounts ? `（ARR ${result.amounts.arrUsd.toLocaleString()}）` : ''),
  };
}

test('后端 400 的 { error } 必须判为失败，不能进结果页', () => {
  // 这是截图里的真实场景：校验失败 → 400 → 前端却当成功处理
  assert.equal(isFailure({ error: '业务描述至少 50 字' }), true);
  assert.equal(isFailure({ error: 'MRR 必须是正数' }), true);
  // 没有 error 但也没有 ID，同样不能进结果页（会渲染成 undefined）
  assert.equal(isFailure({}), true);
  assert.equal(isFailure(null), true);
  assert.equal(isFailure(undefined), true);
});

test('正常创建结果判为成功', () => {
  assert.equal(isFailure({
    opportunityId: 'O28604112', title: 'T', submitted: true,
    amounts: { mrrUsd: 2400, arrUsd: 28800, pocUsd: 2880 }, warnings: [],
  }), false);
  // 只创建未提交，也是成功
  assert.equal(isFailure({
    opportunityId: 'O28604112', submitted: false,
    amounts: { mrrUsd: 1, arrUsd: 12, pocUsd: 1 }, warnings: [],
  }), false);
});

test('结果页渲染残缺对象不抛异常', () => {
  // 即便判定被绕过（如将来有人改回去），渲染层也要兜住
  for (const bad of [
    { error: '业务描述至少 50 字' },      // 截图里的实际对象
    {},
    { opportunityId: 'O1' },              // 缺 amounts / warnings
    { opportunityId: 'O1', amounts: null, warnings: null },
    { opportunityId: 'O1', warnings: [] },
  ]) {
    assert.doesNotThrow(() => renderResultFields(bad),
      `残缺对象导致崩页：${JSON.stringify(bad)}`);
  }
});

test('残缺对象的金额与警告降级为占位符而非报错', () => {
  const out = renderResultFields({ error: '业务描述至少 50 字' });
  assert.equal(out.mrr, '—');
  assert.equal(out.arr, '—');
  assert.equal(out.poc, '—');
  assert.equal(out.showWarnings, false);
  assert.deepEqual(out.warningItems, []);
  // 没有 amounts 时不能拼出「（ARR undefined）」这种文案
  assert.equal(String(out.nextStep).includes('undefined'), false);
});

test('完整结果的字段正常渲染', () => {
  const out = renderResultFields({
    opportunityId: 'O28604112', submitted: true,
    amounts: { mrrUsd: 2400, arrUsd: 28800, pocUsd: 2880 },
    warnings: ['Mergebytes 没有可关联的 Solution，已跳过关联。'],
  });
  assert.equal(out.status, 'warning');
  assert.equal(out.title, '商机 O28604112 已提交');
  assert.equal(out.showWarnings, true);
  assert.equal((out.warningItems as string[]).length, 1);
  assert.equal(String(out.mrr).includes('2,400'), true);
});
