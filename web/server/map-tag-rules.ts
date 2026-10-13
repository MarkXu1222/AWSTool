/**
 * Bedrock Inference Profile 的 map-migrated 标签规则（纯函数，不碰 AWS / db）。
 *
 * 背景：value 由操作者手填，曾把 `migmig…`（手敲 mig + 粘贴带 mig 的 MPE ID）写进 AWS，
 * 交付表又只校验「全表一致」，整批错值进了客户 Excel。平台不存储各 payer 的标准值，
 * 能做的是：格式严格校验、禁止任何覆盖主标签的写法、写后以 AWS 回查为准。
 *
 * ⚠️ 前端 client/src/utils/mapTag.ts 是本文件校验部分的逐字镜像（前端放行的请求，
 * 服务端不能以另一条理由拒绝），改这里必须同步改那里；tests/bedrock-map-tag-guard.test.ts 锁死。
 * ⚠️ 不 import tag-compliance.ts：它会初始化 S3/STS 配置，Bedrock 侧用不到。
 */

export const MAP_TAG_KEY = 'map-migrated';
/** MAP 2.0 MPE ID：小写 mig + 10 位大写字母或数字（如 migEY52ZIK63T） */
export const MAP_TAG_VALUE_RE = /^mig[A-Z0-9]{10}$/;
/** AWS 单资源 Tag 上限 */
export const MAX_TAGS_PER_REQUEST = 50;

export interface BedrockTag { key: string; value: string }

export class MapTagRuleError extends Error {
  readonly code = 'MAP_TAG_RULE';
  constructor(message: string) { super(message); this.name = 'MapTagRuleError'; }
}

/** 返回 null 表示合规；否则返回给用户看的完整错误信息。按固定顺序命中第一条。 */
export function checkMapTagValue(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return 'map-migrated 的值不能为空';
  const p = `map-migrated 值「${value}」不合规：`;
  if (value !== value.trim()) return p + '首尾不能有空格';
  // 区分大小写：合法 MPE ID 的 10 位可能恰好以 MIG 开头（migMIGAB12345）
  if (value.startsWith('migmig')) return p + '出现重复的 mig 前缀（migmig…），只能以一个 mig 开头';
  if (!value.startsWith('mig')) return p + '必须以小写 mig 开头';
  if (value.length !== 13) return p + `长度应为 13（mig + 10 位大写字母或数字），当前 ${value.length}`;
  if (!MAP_TAG_VALUE_RE.test(value)) return p + 'mig 之后只能是大写字母 A-Z 或数字 0-9';
  return null;
}

/** 返回第一条违规信息；合规返回 null。validateBedrockTags 与前端 checkTagInputs 共用这套顺序。 */
function firstTagsViolation(tags: unknown): string | null {
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
    // 大小写变体与主标签并存时，谁是「真」值取决于下游怎么读，属于难排查的静默覆盖
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

/** 校验并返回规范化后的 tags（map-migrated 排第一，其余保持原顺序）。不 trim、不改写任何值。 */
export function validateBedrockTags(tags: unknown): BedrockTag[] {
  const violation = firstTagsViolation(tags);
  if (violation) throw new MapTagRuleError(violation);
  const list = (tags as BedrockTag[]).map(t => ({ key: t.key, value: t.value }));
  return [...list.filter(t => t.key === MAP_TAG_KEY), ...list.filter(t => t.key !== MAP_TAG_KEY)];
}

export function findMapTagValue(tags: BedrockTag[] | undefined | null): string | null {
  return (tags || []).find(t => t.key === MAP_TAG_KEY)?.value ?? null;
}

export function findMapTagKeyVariant(tags: BedrockTag[] | undefined | null): string | null {
  return variantKeysToRemove(tags)[0] ?? null;
}

/** 不分大小写等于 map-migrated 但不精确的 key（打 Tag 前需移除），按出现顺序去重。 */
export function variantKeysToRemove(tags: BedrockTag[] | undefined | null): string[] {
  const out: string[] = [];
  for (const t of tags || []) {
    if (t.key.toLowerCase() === MAP_TAG_KEY && t.key !== MAP_TAG_KEY && !out.includes(t.key)) out.push(t.key);
  }
  return out;
}

const PROFILE_ARN_RE = /^arn:aws:bedrock:([a-z]{2}(?:-[a-z]+)+-\d):(\d{12}):application-inference-profile\/[A-Za-z0-9]+$/;

export function parseProfileArn(arn: unknown): { region: string; accountId: string } | null {
  if (typeof arn !== 'string') return null;
  const m = PROFILE_ARN_RE.exec(arn);
  return m ? { region: m[1], accountId: m[2] } : null;
}

/** 所有 ARN 必须能解析、属于 accountId，且（给了 region 时）区域相同。 */
export function assertArnsBelong(arns: string[], accountId: string, region?: string): void {
  const bad = arns.filter(arn => {
    const parsed = parseProfileArn(arn);
    return !parsed || parsed.accountId !== accountId || (region !== undefined && parsed.region !== region);
  });
  if (!bad.length) return;
  throw new MapTagRuleError(
    `以下 ARN 不属于账户 ${accountId}${region ? ` / 区域 ${region}` : ''}：`
    + `${bad.slice(0, 5).join('、')}${bad.length > 5 ? ` 等 ${bad.length} 个` : ''}`);
}

/** 期望 tags 与 AWS 实际 tags 的差异描述；空数组 = 一致。不比较 actual 中多出的其它 key。 */
export function diffTags(expected: BedrockTag[], actual: BedrockTag[]): string[] {
  const diffs: string[] = [];
  for (const e of expected) {
    const a = actual.find(t => t.key === e.key);
    if (!a) diffs.push(`${e.key}：期望 ${e.value}，实际缺失`);
    else if (a.value !== e.value) diffs.push(`${e.key}：期望 ${e.value}，实际 ${a.value}`);
  }
  const variant = findMapTagKeyVariant(actual);
  if (variant) diffs.push(`存在与 map-migrated 仅大小写不同的 key「${variant}」`);
  return diffs;
}

export type ReadBackStatus = 'verified' | 'read_failed' | 'mismatch';

/**
 * 写后回查：最多 attempts 次、间隔 delayMs，任一次一致即 verified（容忍最终一致性）。
 * 只要有一次读成功，结论就基于实测值（mismatch）；全部读失败才是 read_failed。
 */
export async function readBackTags(
  read: () => Promise<BedrockTag[]>,
  expected: BedrockTag[],
  opts: { attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ status: ReadBackStatus; actual: BedrockTag[] | null; error?: string }> {
  const attempts = opts.attempts ?? 3;
  const delayMs = opts.delayMs ?? 1000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));

  let lastActual: BedrockTag[] | null = null;
  let lastDiff: string[] = [];
  let lastErr = '';
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(delayMs);
    try {
      const actual = await read();
      lastActual = actual;
      const diff = diffTags(expected, actual);
      if (!diff.length) return { status: 'verified', actual };
      lastDiff = diff;
    } catch (e: any) {
      lastErr = e?.message || String(e);
    }
  }
  if (lastActual === null) return { status: 'read_failed', actual: null, error: lastErr };
  return { status: 'mismatch', actual: lastActual, error: lastDiff.join('；') };
}
