/**
 * 区域下拉（配额 / 批量提额 / Bedrock）的覆盖面与可搜索性。
 *
 * 实际踩过：批量提额里搜「巴西」搜不到 sa-east-1 —— 区域其实在列表里，但 label 只写了
 * 城市「圣保罗」，下拉按 label 过滤，看起来就像区域缺失。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REGIONS } from '../client/src/constants/regions';

// AWS 商业区全集（`aws account list-regions`，2026-10 共 34 个）
const AWS_COMMERCIAL_REGIONS = [
  'af-south-1', 'ap-east-1', 'ap-east-2', 'ap-northeast-1', 'ap-northeast-2', 'ap-northeast-3',
  'ap-south-1', 'ap-south-2', 'ap-southeast-1', 'ap-southeast-2', 'ap-southeast-3', 'ap-southeast-4',
  'ap-southeast-5', 'ap-southeast-6', 'ap-southeast-7', 'ca-central-1', 'ca-west-1',
  'eu-central-1', 'eu-central-2', 'eu-north-1', 'eu-south-1', 'eu-south-2',
  'eu-west-1', 'eu-west-2', 'eu-west-3', 'il-central-1', 'me-central-1', 'me-south-1',
  'mx-central-1', 'sa-east-1', 'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
];

const options = REGIONS.filter(r => r.value);
// 与 antd Select optionFilterProp="label" 的默认行为一致：label 包含输入即命中
const search = (keyword: string) => options.filter(r => r.label.toLowerCase().includes(keyword.toLowerCase())).map(r => r.value);

test('下拉覆盖 AWS 全部商业区，且没有重复或不存在的区域', () => {
  const values = options.map(r => r.value);
  assert.equal(new Set(values).size, values.length, '区域重复');
  assert.deepEqual([...values].sort(), [...AWS_COMMERCIAL_REGIONS].sort());
});

test('按国家/地区中文名能搜到对应区域', () => {
  const cases: Array<[string, string[]]> = [
    ['巴西', ['sa-east-1']],
    ['美国', ['us-east-1', 'us-east-2', 'us-west-1', 'us-west-2']],
    ['香港', ['ap-east-1']],
    ['日本', ['ap-northeast-1', 'ap-northeast-3']],
    ['韩国', ['ap-northeast-2']],
    ['印度', ['ap-south-1', 'ap-south-2']],
    ['澳大利亚', ['ap-southeast-2', 'ap-southeast-4']],
    ['加拿大', ['ca-central-1', 'ca-west-1']],
    ['德国', ['eu-central-1']],
    ['英国', ['eu-west-2']],
  ];
  for (const [keyword, expected] of cases) {
    assert.deepEqual(search(keyword).sort(), expected.sort(), `搜「${keyword}」`);
  }
});

test('按城市名和区域代码仍能搜到', () => {
  assert.deepEqual(search('圣保罗'), ['sa-east-1']);
  assert.deepEqual(search('弗吉尼亚'), ['us-east-1']);
  assert.deepEqual(search('sa-east'), ['sa-east-1']);
});
