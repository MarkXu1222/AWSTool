/**
 * map-migrated 标签前端校验。
 *
 * ⚠️ 与 server/map-tag-rules.ts 的 checkMapTagValue / validateBedrockTags 保持逐字一致
 * （规则顺序与报错文案都一样），tests/bedrock-map-tag-guard.test.ts 锁死。
 * 前端只负责提前提示，服务端才是最终裁决。
 */

export const MAP_TAG_KEY = 'map-migrated';
export const MAP_TAG_VALUE_RE = /^mig[A-Z0-9]{10}$/;
const MAX_TAGS_PER_REQUEST = 50;

export function checkMapTagValue(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return 'map-migrated 的值不能为空';
  const p = `map-migrated 值「${value}」不合规：`;
  if (value !== value.trim()) return p + '首尾不能有空格';
  if (value.startsWith('migmig')) return p + '出现重复的 mig 前缀（migmig…），只能以一个 mig 开头';
  if (!value.startsWith('mig')) return p + '必须以小写 mig 开头';
  if (value.length !== 13) return p + `长度应为 13（mig + 10 位大写字母或数字），当前 ${value.length}`;
  if (!MAP_TAG_VALUE_RE.test(value)) return p + 'mig 之后只能是大写字母 A-Z 或数字 0-9';
  return null;
}

/** 合规返回 null，否则返回第一条错误信息。 */
export function checkTagInputs(tags: Array<{ key: string; value: string }>): string | null {
  if (!Array.isArray(tags) || tags.length === 0) {
    return '必须提供至少一个 Tag（key/value 均必填，平台不提供默认 Tag）';
  }
  if (tags.length > MAX_TAGS_PER_REQUEST) return `一次最多 ${MAX_TAGS_PER_REQUEST} 个 Tag（AWS 上限）`;

  const seen = new Set<string>();
  let mapValue: string | null = null;
  for (let idx = 0; idx < tags.length; idx++) {
    const i = idx + 1;
    const { key, value } = (tags[idx] ?? {}) as { key?: unknown; value?: unknown };
    if (typeof key !== 'string' || typeof value !== 'string') return `第 ${i} 个 Tag 的 key 和 value 都必须是字符串`;
    if (key === '' || value === '') return `第 ${i} 个 Tag 的 key 和 value 都不能为空`;
    if (key !== key.trim()) return `第 ${i} 个 Tag 的 key「${key}」首尾不能有空格`;
    const lower = key.toLowerCase();
    if (lower.startsWith('aws:')) return `第 ${i} 个 Tag 的 key 不能以 aws: 开头（AWS 保留前缀）`;
    if (lower === MAP_TAG_KEY && key !== MAP_TAG_KEY) {
      return `第 ${i} 个 Tag 的 key「${key}」与 map-migrated 仅大小写不同，会造成混淆，请删除`;
    }
    if (seen.has(lower)) return `第 ${i} 个 Tag 的 key「${key}」重复`;
    seen.add(lower);
    if (key === MAP_TAG_KEY) mapValue = value;
    else if (value !== value.trim()) return `第 ${i} 个 Tag 的 value 首尾不能有空格`;
  }
  if (mapValue === null) return '缺少 map-migrated 标签';
  return checkMapTagValue(mapValue);
}
