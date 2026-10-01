/**
 * Bedrock 工具集：Inference Profile 管理 / 批量创建 / 模型测试 / 模型列表 /
 * FTU 模型开通 / Fable 5 数据共享 / IAM 用户 / 交付表格。
 * 从桌面版 Bedrock Profile Manager（PySide6）迁移而来。
 *
 * 凭证策略：Bedrock 的读写操作 support-quota 角色都没有权限，
 * 统一走 Admin 凭证（getTempAdminCredentials，同 regions.ts enableRegion 的做法），
 * 进程内按账户缓存 50 分钟避免重复 STS。
 *
 * ⚠️ Tag 纪律：创建 Profile 的 tags 必填且不做任何默认值，每次由操作者输入
 * （桌面版默认 migSLQ1VY6LIX 会导致错打别家 MAP tag —— 平台侧强制显式输入）。
 */
import {
  BedrockClient,
  ListInferenceProfilesCommand,
  CreateInferenceProfileCommand,
  DeleteInferenceProfileCommand,
  ListTagsForResourceCommand,
  TagResourceCommand,
  UntagResourceCommand,
  ListFoundationModelsCommand,
  PutUseCaseForModelAccessCommand,
  GetAccountDataRetentionCommand,
  PutAccountDataRetentionCommand,
} from '@aws-sdk/client-bedrock';
import { BedrockRuntimeClient, InvokeModelCommand, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import {
  IAMClient, ListUsersCommand, ListAttachedUserPoliciesCommand, ListAccessKeysCommand,
  GetLoginProfileCommand, CreateUserCommand, AttachUserPolicyCommand, CreateLoginProfileCommand, CreateAccessKeyCommand,
} from '@aws-sdk/client-iam';
import crypto from 'crypto';
import { getTempAdminCredentials } from './aws-service';

// ===== Admin 凭证缓存（50 分钟；STS 凭证本身 1 小时） =====
// 有界缓存：平台有 3000+ 账户，无上限的 Map 会让 Admin 凭证在内存里无限累积
// （既是内存泄漏，也让已过期凭证长期滞留）。每次读写顺带清理过期项并限制容量。
const CRED_CACHE_MAX = 50;
const credCache = new Map<string, { creds: any; expireAt: number }>();

function pruneCredCache() {
  const now = Date.now();
  for (const [key, v] of credCache) if (v.expireAt <= now) credCache.delete(key);
  // 仍超限时按插入顺序淘汰最旧的（Map 保序）
  while (credCache.size >= CRED_CACHE_MAX) {
    const oldest = credCache.keys().next().value;
    if (oldest === undefined) break;
    credCache.delete(oldest);
  }
}

async function adminCreds(accountId: string) {
  const hit = credCache.get(accountId);
  if (hit && hit.expireAt > Date.now()) return hit.creds;
  const t = await getTempAdminCredentials(accountId);
  const creds = { accessKeyId: t.accessKeyId, secretAccessKey: t.secretAccessKey, sessionToken: t.sessionToken };
  pruneCredCache();
  credCache.set(accountId, { creds, expireAt: Date.now() + 50 * 60 * 1000 });
  return creds;
}

function bedrock(creds: any, region: string) {
  return new BedrockClient({ region, credentials: creds, maxAttempts: 2 });
}

// 按 SYSTEM_DEFINED profile ID 的厂商段（如 us.openai.gpt-6-sol 的 openai）与名称做关键词匹配，首个命中生效。
// 新厂商上架后若这里漏配，会落进 Unknown，批量创建页的 Provider 下拉就选不到它（曾漏掉 OpenAI/xAI 等 30 个 profile）。
// 规范名与配额页 BEDROCK_PROVIDER_HINTS（aws-service.ts）保持一致。
const PROVIDER_HINTS: Array<[string, string]> = [
  ['anthropic', 'Anthropic'], ['claude', 'Anthropic'],
  ['amazon', 'Amazon'], ['nova', 'Amazon'], ['titan', 'Amazon'],
  ['meta', 'Meta'], ['llama', 'Meta'], ['mistral', 'Mistral'],
  ['cohere', 'Cohere'], ['ai21', 'AI21'], ['jamba', 'AI21'],
  ['stability', 'Stability'], ['deepseek', 'DeepSeek'], ['qwen', 'Qwen'],
  ['openai', 'OpenAI'], ['gpt', 'OpenAI'],
  ['xai', 'xAI'], ['grok', 'xAI'],
  ['moonshot', 'Moonshot'], ['kimi', 'Moonshot'],
  ['twelvelabs', 'TwelveLabs'], ['pegasus', 'TwelveLabs'], ['marengo', 'TwelveLabs'],
  ['writer', 'Writer'], ['palmyra', 'Writer'],
  ['google', 'Google'], ['gemma', 'Google'], ['gemini', 'Google'],
  ['minimax', 'MiniMax'],
  ['nvidia', 'NVIDIA'], ['nemotron', 'NVIDIA'],
  ['z.ai', 'Z.ai'], ['zai', 'Z.ai'], ['glm', 'Z.ai'],
  ['luma', 'Luma'],
];
export function inferProvider(...values: string[]): string {
  const hay = values.filter(Boolean).join(' ').toLowerCase();
  for (const [needle, label] of PROVIDER_HINTS) if (hay.includes(needle)) return label;
  return 'Unknown';
}

// ===== Profiles 管理 =====

/** 列 APPLICATION 型 Inference Profile（多区域并发，含 tags 与后端模型） */
export async function listProfiles(accountId: string, regions: string[]) {
  const creds = await adminCreds(accountId);
  const out: any[] = [];
  const errors: Array<{ region: string; message: string }> = [];
  await Promise.all(regions.map(async region => {
    const c = bedrock(creds, region);
    try {
      let nextToken: string | undefined;
      do {
        const resp = await c.send(new ListInferenceProfilesCommand({ typeEquals: 'APPLICATION', maxResults: 100, nextToken }));
        for (const p of resp.inferenceProfileSummaries || []) {
          let tags: Array<{ key: string; value: string }> = [];
          try {
            const tagResp = await c.send(new ListTagsForResourceCommand({ resourceARN: p.inferenceProfileArn! }));
            tags = (tagResp.tags || []) as any;
          } catch { /* 无权限或限流时留空 */ }
          const modelArns = (p.models || []).map(m => m.modelArn || '');
          const shortModels = modelArns.map(m => /foundation-model\/(.+)$/.exec(m)?.[1] || m);
          const modelRegions = new Set(modelArns.map(m => /bedrock:([^:]*)::/.exec(m)?.[1] || 'global'));
          const scope = modelRegions.has('') || modelRegions.has('global') ? 'Global' : 'US';
          out.push({
            region,
            name: p.inferenceProfileName,
            status: p.status,
            scope,
            backendModels: [...new Set(shortModels)].sort().join(', '),
            backendRegions: [...modelRegions].sort().join(', '),
            tags,
            arn: p.inferenceProfileArn,
          });
        }
        nextToken = resp.nextToken;
      } while (nextToken);
    } catch (e: any) {
      errors.push({ region, message: e?.message || String(e) });
    } finally { c.destroy(); }
  }));
  return { rows: out, errors };
}

/** 列 SYSTEM_DEFINED profiles（= 可用于 copyFrom 创建的模型来源） */
export async function listSystemProfiles(accountId: string, region: string) {
  const creds = await adminCreds(accountId);
  const c = bedrock(creds, region);
  try {
    const models: any[] = [];
    let nextToken: string | undefined;
    do {
      const resp = await c.send(new ListInferenceProfilesCommand({ typeEquals: 'SYSTEM_DEFINED', maxResults: 100, nextToken }));
      for (const p of resp.inferenceProfileSummaries || []) {
        const pid = p.inferenceProfileId || '';
        const parts = pid.split('.');
        const scope = parts[0] === 'global' ? 'Global' : parts.length >= 2 ? parts[0].toUpperCase() : 'Other';
        models.push({
          provider: inferProvider(parts[1] || '', p.inferenceProfileName || '', pid),
          name: p.inferenceProfileName,
          modelId: pid,
          scope,
        });
      }
      nextToken = resp.nextToken;
    } while (nextToken);
    return models;
  } finally { c.destroy(); }
}

/**
 * 批量创建 Application Inference Profile。
 * ⚠️ tags 必填（route 层已强校验非空），不做默认值。
 */
export async function createProfiles(
  accountId: string, region: string,
  items: Array<{ modelId: string; name: string }>,
  tags: Array<{ key: string; value: string }>,
) {
  const creds = await adminCreds(accountId);
  const c = bedrock(creds, region);
  const results: Array<{ name: string; ok: boolean; arn?: string; error?: string }> = [];
  try {
    for (const item of items) {
      const modelArn = `arn:aws:bedrock:${region}:${accountId}:inference-profile/${item.modelId}`;
      try {
        const resp = await c.send(new CreateInferenceProfileCommand({
          inferenceProfileName: item.name,
          modelSource: { copyFrom: modelArn },
          tags: tags as any,
        }));
        results.push({ name: item.name, ok: true, arn: resp.inferenceProfileArn });
      } catch (e: any) {
        results.push({ name: item.name, ok: false, error: e?.message || String(e) });
      }
    }
  } finally { c.destroy(); }
  return results;
}

export async function deleteProfiles(accountId: string, region: string, arns: string[]) {
  const creds = await adminCreds(accountId);
  const c = bedrock(creds, region);
  const results: Array<{ arn: string; ok: boolean; error?: string }> = [];
  try {
    for (const arn of arns) {
      try {
        await c.send(new DeleteInferenceProfileCommand({ inferenceProfileIdentifier: arn }));
        results.push({ arn, ok: true });
      } catch (e: any) { results.push({ arn, ok: false, error: e?.message || String(e) }); }
    }
  } finally { c.destroy(); }
  return results;
}

export async function tagProfiles(accountId: string, region: string, arns: string[], tags: Array<{ key: string; value: string }>) {
  const creds = await adminCreds(accountId);
  const c = bedrock(creds, region);
  const results: Array<{ arn: string; ok: boolean; error?: string }> = [];
  try {
    for (const arn of arns) {
      try {
        await c.send(new TagResourceCommand({ resourceARN: arn, tags: tags as any }));
        results.push({ arn, ok: true });
      } catch (e: any) { results.push({ arn, ok: false, error: e?.message || String(e) }); }
    }
  } finally { c.destroy(); }
  return results;
}

export async function untagProfiles(accountId: string, region: string, arns: string[], tagKeys: string[]) {
  const creds = await adminCreds(accountId);
  const c = bedrock(creds, region);
  const results: Array<{ arn: string; ok: boolean; error?: string }> = [];
  try {
    for (const arn of arns) {
      try {
        await c.send(new UntagResourceCommand({ resourceARN: arn, tagKeys }));
        results.push({ arn, ok: true });
      } catch (e: any) { results.push({ arn, ok: false, error: e?.message || String(e) }); }
    }
  } finally { c.destroy(); }
  return results;
}

// ===== 模型列表 / 模型测试 =====

export async function listFoundationModels(accountId: string, region: string, provider?: string, inferenceType?: string) {
  const creds = await adminCreds(accountId);
  const c = bedrock(creds, region);
  try {
    const kw: any = {};
    if (provider && provider !== 'All') kw.byProvider = provider;
    if (inferenceType && inferenceType !== 'All') kw.byInferenceType = inferenceType;
    const resp = await c.send(new ListFoundationModelsCommand(kw));
    return (resp.modelSummaries || []).map(m => ({
      modelId: m.modelId || '',
      provider: m.providerName || '',
      name: m.modelName || '',
      status: m.modelLifecycle?.status || 'ACTIVE',
      inferenceTypes: (m.inferenceTypesSupported || []).join(', '),
      streaming: m.responseStreamingSupported ? 'Yes' : 'No',
    }));
  } finally { c.destroy(); }
}

/** 模型测试：先 InvokeModel（anthropic 格式），失败回退 Converse（与桌面版一致） */
export async function invokeModel(accountId: string, region: string, modelId: string, prompt: string, maxTokens = 1024) {
  const creds = await adminCreds(accountId);
  const rt = new BedrockRuntimeClient({ region, credentials: creds, maxAttempts: 1 });
  try {
    try {
      const body = JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
      });
      const resp = await rt.send(new InvokeModelCommand({ modelId, body, contentType: 'application/json' }));
      const result = JSON.parse(Buffer.from(resp.body as Uint8Array).toString('utf-8'));
      if (Array.isArray(result.content)) return result.content.map((c: any) => c.text || '').join('\n');
      return JSON.stringify(result, null, 2);
    } catch {
      const resp = await rt.send(new ConverseCommand({
        modelId,
        messages: [{ role: 'user', content: [{ text: prompt }] }],
        inferenceConfig: { maxTokens },
      }));
      const output = resp.output?.message?.content || [];
      return output.length ? output.map((c: any) => c.text || '').join('\n') : JSON.stringify(resp, null, 2);
    }
  } finally { rt.destroy(); }
}

// ===== 李浩版交付：Profile ↔ Bedrock 配额（TPM/TPD）匹配 =====

/**
 * 从后端模型 ID 提取匹配键：`anthropic.claude-sonnet-4-5-20250929-v1:0` →
 * { family: 'sonnet', version: '4.5', v: 'v1' }；`claude-opus-4-6-v1` → { family:'opus', version:'4.6', v:'v1' }。
 *
 * ⚠️ 次版本号必须限长并加 `(?!\d)` 边界。
 * 旧写法 `(?:-(\d+))?` 是贪婪的：对**单段版本号 + 日期**的模型
 * （`claude-opus-5-20260301-v1:0`）会把 8 位日期当成次版本，
 * 得到 version='5.20260301'，后续 `model.includes(key.version)` 永远匹配不上
 * 配额名里的 "Anthropic Claude Opus 5" → TPM/TPD 静默写 0。
 * 双段版本号（4-6 / 4-7）因为日期前已有次版本，反而不受影响，
 * 所以这个 bug 只在 sonnet-5 / opus-5 这类模型上出现。
 */
export function extractClaudeKey(modelId: string): { family: string; version: string; v: string } | null {
  const m = /claude-([a-z]+)-(\d+)(?:-(\d{1,2})(?!\d))?(?:-\d{8})?(?:-v(\d+))?/
    .exec(String(modelId).toLowerCase());
  if (!m) return null;
  return { family: m[1], version: m[3] ? `${m[2]}.${m[3]}` : m[2], v: m[4] ? `v${m[4]}` : '' };
}

/**
 * 版本号必须**整段**出现在配额名里，不能用 includes 子串判断。
 * 配额名形如 "Anthropic Claude Opus 4.5" / "Anthropic Claude Opus 5"，
 * 而 `"opus 4.5".includes("5")` === true —— 查 Opus 5 会命中 Opus 4.5 的配额，
 * 把 1,111,111 这种错误数字写进交付表（比写 0 更危险：0 一眼能看出异常，
 * 错误数字会被当成真实配额直接发给客户）。
 * 这里用数字边界锚定：版本号前后都不能再接数字或小数点。
 */
function versionMatches(model: string, version: string): boolean {
  const esc = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\d.])${esc}(?![\\d.])`).test(model);
}

/**
 * 取该区域的账户级跨模型日配额（Cross-Model Account-Level Tokens Per Day，L-E3F10727）。
 *
 * 2026 年起 AWS 取消了 Anthropic 系列的逐模型 TPD 配额（实测 Opus 4.7 只剩 TPM），
 * 改为一个账户级总配额约束所有模型的合计日用量。
 * 所以逐模型 TPD 查不到时，真正生效的日限额就是这个值。
 */
function accountLevelTpd(quotaRows: any[], region: string): number {
  for (const q of quotaRows) {
    if (q.region !== region) continue;
    if (q.scope !== 'Account-Level') continue;
    const v = q.metrics?.TPD?.value;
    if (v != null) return Math.round(v);
  }
  return 0;
}

/**
 * 在 listBedrockQuotas 的结果行里找该 Profile 的 TPM/TPD。
 * scope：Global → 'Global Cross-Region'；US → 'Cross-Region'（李浩版规范的两档）。
 *
 * TPD 取值优先级：
 *   1. 该模型自己的 TPD（老模型仍有，如 Nova / Jamba）
 *   2. 回退到账户级跨模型 TPD —— Anthropic 现在都走这条
 * 两者都没有才写 0（规范：提额未生效如实写 0，不盲套公式）。
 *
 * `tpdShared` 标记这一行的 TPD 是否来自账户级共享配额，交付表据此加备注，
 * 避免客户误以为每个模型各自独享该额度。
 */
export function matchProfileTpmTpd(
  profile: { backendModels?: string; name?: string; scope: string; region: string },
  quotaRows: any[],
): { tpm: number; tpd: number; tpdShared: boolean } {
  const key = extractClaudeKey(profile.backendModels || profile.name || '');
  const shared = accountLevelTpd(quotaRows, profile.region);
  const pick = (q: any) => {
    const m = q.metrics?.TPD;
    // listBedrockQuotas 已把账户级 TPD 回填到缺值的行上（inherited=true）。
    // 必须按该标记判断，不能只看"有没有值"，否则回填值会被当成模型自有配额，
    // tpdShared 恒为 false，交付表就丢掉"该额度全账户共享"的备注 9。
    if (m?.value != null && !m.inherited) return { tpd: Math.round(m.value), tpdShared: false };
    const v = m?.inherited ? Math.round(m.value) : shared;
    return { tpd: v, tpdShared: v > 0 };
  };
  if (!key) return { tpm: 0, tpd: 0, tpdShared: false };
  const wantScope = profile.scope === 'Global' ? 'Global Cross-Region' : 'Cross-Region';
  for (const q of quotaRows) {
    if (q.region !== profile.region || q.scope !== wantScope) continue;
    const model = String(q.model || '').toLowerCase();
    if (!model.includes(key.family) || !versionMatches(model, key.version)) continue;
    if (key.v && !model.includes(key.v)) continue;
    // 无 v 后缀时避免匹配到 "4.6 V1" 这类带版本的行（除非只有它）
    if (!key.v && /v\d/.test(model)) continue;
    return { tpm: Math.round(q.metrics?.TPM?.value || 0), ...pick(q) };
  }
  // 放宽一轮：允许 v 后缀不严格（应对配额命名差异）。
  // 注意版本号仍须整段匹配，绝不放宽到子串，否则又会串到隔壁版本上。
  for (const q of quotaRows) {
    if (q.region !== profile.region || q.scope !== wantScope) continue;
    const model = String(q.model || '').toLowerCase();
    if (model.includes(key.family) && versionMatches(model, key.version)) {
      return { tpm: Math.round(q.metrics?.TPM?.value || 0), ...pick(q) };
    }
  }
  return { tpm: 0, tpd: 0, tpdShared: false };
}

// ===== FTU 模型开通（Claude 首次使用表单） =====

export interface FtuForm {
  companyName: string;
  companyWebsite: string;
  intendedUsers: string;      // 1=外部用户 2=内部用户
  industryOption: string;
  otherIndustryOption?: string;
  useCases: string;
}

export async function submitFtu(accountId: string, region: string, form: FtuForm) {
  const creds = await adminCreds(accountId);
  const c = bedrock(creds, region);
  try {
    // SDK 类型是 Uint8Array（Python 版传 JSON 字符串，HTTP 层等价）
    const formData = Buffer.from(JSON.stringify(form), 'utf-8');
    await c.send(new PutUseCaseForModelAccessCommand({ formData }));
    return { ok: true };
  } finally { c.destroy(); }
}

// ===== Fable 5 数据共享（data retention → provider_data_share） =====

export async function getDataRetention(accountId: string, regions: string[]) {
  const creds = await adminCreds(accountId);
  const results = await Promise.all(regions.map(async region => {
    const c = bedrock(creds, region);
    try {
      const resp = await c.send(new GetAccountDataRetentionCommand({}));
      return { region, ok: true, mode: String(resp.mode || '') };
    } catch (e: any) {
      return { region, ok: false, mode: e?.message || String(e) };
    } finally { c.destroy(); }
  }));
  return results.sort((a, b) => a.region.localeCompare(b.region));
}

export async function enableProviderDataShare(accountId: string, regions: string[]) {
  const creds = await adminCreds(accountId);
  const results = await Promise.all(regions.map(async region => {
    const c = bedrock(creds, region);
    try {
      await c.send(new PutAccountDataRetentionCommand({ mode: 'provider_data_share' as any }));
      return { region, ok: true, mode: 'provider_data_share' };
    } catch (e: any) {
      return { region, ok: false, mode: e?.message || String(e) };
    } finally { c.destroy(); }
  }));
  return results.sort((a, b) => a.region.localeCompare(b.region));
}

// ===== IAM 用户 =====

export async function listIamUsers(accountId: string) {
  const creds = await adminCreds(accountId);
  const iam = new IAMClient({ region: 'us-east-1', credentials: creds });
  try {
    const users: any[] = [];
    let marker: string | undefined;
    do {
      const page = await iam.send(new ListUsersCommand({ Marker: marker }));
      for (const user of page.Users || []) {
        const name = user.UserName!;
        const [policies, keys, loginProfile] = await Promise.all([
          iam.send(new ListAttachedUserPoliciesCommand({ UserName: name })).then(r => (r.AttachedPolicies || []).map(p => p.PolicyName || '')).catch(() => [] as string[]),
          iam.send(new ListAccessKeysCommand({ UserName: name })).then(r => r.AccessKeyMetadata || []).catch(() => []),
          iam.send(new GetLoginProfileCommand({ UserName: name })).then(() => true).catch(() => false),
        ]);
        users.push({
          username: name,
          arn: user.Arn || '',
          administrator: policies.includes('AdministratorAccess'),
          consoleLogin: loginProfile,
          activeKeys: keys.filter(k => k.Status === 'Active').length,
          keyIds: keys.map(k => k.AccessKeyId || '').join(', '),
          createdAt: user.CreateDate ? new Date(user.CreateDate).toISOString() : '',
        });
      }
      marker = page.IsTruncated ? page.Marker : undefined;
    } while (marker);
    return users;
  } finally { iam.destroy(); }
}

function generateConsolePassword(length = 24): string {
  const symbols = '!@#$%^&*_-+=';
  const lowers = 'abcdefghijklmnopqrstuvwxyz';
  const uppers = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const digits = '0123456789';
  const all = lowers + uppers + digits + symbols;
  const pick = (set: string) => set[crypto.randomInt(set.length)];
  const chars = [pick(lowers), pick(uppers), pick(digits), pick(symbols)];
  while (chars.length < length) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

/** 创建 AdministratorAccess IAM 用户（console 密码 + 可选 AK）——敏感操作，route 层 requireStrictAdmin */
export async function createAdminUser(
  accountId: string, userName: string,
  opts: { createConsoleLogin?: boolean; createAccessKey?: boolean; passwordResetRequired?: boolean } = {},
) {
  const name = userName.trim();
  if (!name) throw new Error('IAM 用户名不能为空');
  const { createConsoleLogin = true, createAccessKey = true, passwordResetRequired = false } = opts;
  const creds = await adminCreds(accountId);
  const iam = new IAMClient({ region: 'us-east-1', credentials: creds });
  try {
    const user = (await iam.send(new CreateUserCommand({ UserName: name }))).User;
    await iam.send(new AttachUserPolicyCommand({ UserName: name, PolicyArn: 'arn:aws:iam::aws:policy/AdministratorAccess' }));
    const result: any = { user: { userName: name, arn: user?.Arn || '' }, consolePassword: '', accessKey: null };
    if (createConsoleLogin) {
      const password = generateConsolePassword();
      await iam.send(new CreateLoginProfileCommand({ UserName: name, Password: password, PasswordResetRequired: passwordResetRequired }));
      result.consolePassword = password;
    }
    if (createAccessKey) {
      const ak = (await iam.send(new CreateAccessKeyCommand({ UserName: name }))).AccessKey;
      result.accessKey = { accessKeyId: ak?.AccessKeyId || '', secretAccessKey: ak?.SecretAccessKey || '' };
    }
    return result;
  } finally { iam.destroy(); }
}
