/**
 * Bedrock 批量创建页 Provider 归类（inferProvider）。
 *
 * 背景：PROVIDER_HINTS 只覆盖早期 9 家厂商，OpenAI / xAI / Moonshot / TwelveLabs / Writer 的
 * SYSTEM_DEFINED profile 全部落进 Unknown（us-east-1 实测 93 个里 30 个），Provider 下拉选不到 OpenAI。
 * 用例取自真实 profile ID 与名称，调用方式与 listSystemProfiles 一致：(ID 厂商段, profile 名, 完整 ID)。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferProvider } from '../server/bedrock-tools';

const classify = (pid: string, name: string) => inferProvider(pid.split('.')[1] || '', name, pid);

test('OpenAI 的 US / Global profile 都归为 OpenAI', () => {
  assert.equal(classify('us.openai.gpt-6-sol', 'US OpenAI GPT-6 Sol'), 'OpenAI');
  assert.equal(classify('global.openai.gpt-5.4', 'Global OpenAI GPT 5.4'), 'OpenAI');
  assert.equal(classify('global.openai.gpt-6.1-sol', 'Global OpenAI GPT-6.1 Sol'), 'OpenAI');
});

test('此前落入 Unknown 的其他新厂商', () => {
  assert.equal(classify('us.xai.grok-4.7', 'US xAI Grok 4.7'), 'xAI');
  assert.equal(classify('global.moonshotai.kimi-k3', 'Global Moonshot AI Kimi K3'), 'Moonshot');
  assert.equal(classify('us.twelvelabs.marengo-embed-3-0-v1:0', 'US TwelveLabs Marengo Embed 3.0'), 'TwelveLabs');
  // 名称里不带厂商名时靠模型家族兜底
  assert.equal(classify('us.twelvelabs.pegasus-1-2-v1:0', 'US Pegasus v1.2'), 'TwelveLabs');
  assert.equal(classify('us.writer.palmyra-x5-v1:0', 'US Palmyra X5'), 'Writer');
});

test('既有厂商归类不受影响', () => {
  assert.equal(classify('global.anthropic.claude-opus-4-7', 'Global Anthropic Claude Opus 4.7'), 'Anthropic');
  assert.equal(classify('us.amazon.nova-pro-v1:0', 'US Nova Pro'), 'Amazon');
  assert.equal(classify('us.meta.llama4-maverick-17b-instruct-v1:0', 'US Llama 4 Maverick 17B Instruct'), 'Meta');
  assert.equal(classify('us.deepseek.r1-v1:0', 'US DeepSeek-R1'), 'DeepSeek');
  assert.equal(classify('us.stability.sd3-5-large-v1:0', 'US Stable Diffusion 3.5 Large'), 'Stability');
});

test('认不出的仍归 Unknown，不猜测', () => {
  assert.equal(classify('us.acme.foo-1', 'US Foo 1'), 'Unknown');
});
