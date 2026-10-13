/**
 * Bedrock 工具路由（挂载在 /api/aws/bedrock-tools/*，
 * 经 authMiddleware + auditMiddleware；写操作再加 requireAdmin/requireStrictAdmin）。
 *
 * ⚠️ Tag 纪律：创建 Profile / 打 Tag 的 tags 必填，服务端强校验非空且每个 key/value 非空，
 * 绝不提供默认值（防止错打别家 MAP tag）。map-migrated 值必须符合 ^mig[A-Z0-9]{10}$，
 * 规则见 map-tag-rules.ts；交付表格一律从 AWS 重新读标签，不信任前端传来的 tags。
 */
import { Router, Request, Response, NextFunction } from 'express';
import { db } from '../db';
import * as bt from '../bedrock-tools';
import {
  buildDeliveryXlsx, buildDeliveryXlsxV2, filterAndSortForDelivery, normalizeDeliveryRows,
  type DeliveryVariant,
} from '../bedrock-delivery';
import {
  validateBedrockTags, assertArnsBelong, MapTagRuleError, type BedrockTag,
} from '../map-tag-rules';
import { listBedrockQuotas } from '../aws-service';

export const bedrockRouter = Router();

// 与 aws.ts 同语义的守卫（requireAdmin 拦 viewer；strict 只认数据库实时 admin）
const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
  const user = (req as any).user;
  if (user?.role !== 'admin' && user?.role !== 'partadmin') {
    return res.status(403).json({ error: '需要管理员权限' });
  }
  next();
};
const requireStrictAdmin = (req: Request, res: Response, next: NextFunction) => {
  const user = (req as any).user;
  const dbUser = user?.username ? db.getUser(user.username) : null;
  if (!dbUser || dbUser.role !== 'admin') {
    return res.status(403).json({ error: '需要 admin 权限（实时校验）' });
  }
  next();
};

const ACCOUNT_RE = /^\d{12}$/;
const REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d$/;

function parseRegions(raw: any): string[] {
  return String(raw || '').split(',').map(r => r.trim()).filter(r => REGION_RE.test(r));
}

/** 各状态计数，如「verified 3，mismatch 1」，只列出现过的状态 */
function statusSummary(results: Array<{ status: string }>): string {
  const counts = new Map<string, number>();
  for (const r of results) counts.set(r.status, (counts.get(r.status) || 0) + 1);
  return [...counts].map(([status, n]) => `${status} ${n}`).join('，');
}

const formatTags = (tags: BedrockTag[]) => tags.map(t => `${t.key}=${t.value}`).join(';');

/** 交付前从 AWS 读真实 tags 挂到行上；任一 ARN 读失败即拒绝（不允许用前端值兜底） */
async function attachAwsTags<T extends { arn: string; name: string }>(
  accountId: string, rows: T[],
): Promise<Array<T & { tags: BedrockTag[] }>> {
  const { tags, failures } = await bt.readProfileTagsByArn(accountId, rows.map(r => r.arn));
  if (failures.length) {
    const nameOf = (arn: string) => rows.find(r => r.arn === arn)?.name || arn;
    const list = failures.slice(0, 5).map(f => `${nameOf(f.arn)}（${f.error}）`).join('、');
    throw new MapTagRuleError(`无法从 AWS 读取以下 Profile 的标签，已拒绝生成：${list}`
      + `${failures.length > 5 ? ` 等 ${failures.length} 个` : ''}`);
  }
  return rows.map(r => ({ ...r, tags: tags.get(r.arn)! }));
}

function requireAccount(req: Request): string {
  const accountId = String(req.params.accountId || req.body?.accountId || '');
  if (!ACCOUNT_RE.test(accountId)) throw new Error('无效的账户 ID');
  return accountId;
}

// ===== Profiles =====

// 列 Application Profiles（多区域）
bedrockRouter.get('/profiles/:accountId', async (req: Request, res: Response) => {
  try {
    const accountId = requireAccount(req);
    const regions = parseRegions(req.query.regions);
    if (!regions.length) return res.status(400).json({ error: '请至少指定一个有效区域' });
    if (regions.length > 12) return res.status(400).json({ error: '一次最多查询 12 个区域' });
    res.json({ success: true, data: await bt.listProfiles(accountId, regions) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// 可创建的模型列表（SYSTEM_DEFINED profiles）
bedrockRouter.get('/models/:accountId', async (req: Request, res: Response) => {
  try {
    const accountId = requireAccount(req);
    const region = String(req.query.region || '');
    if (!REGION_RE.test(region)) return res.status(400).json({ error: '无效的区域' });
    res.json({ success: true, data: await bt.listSystemProfiles(accountId, region) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Foundation Models 列表
bedrockRouter.get('/foundation-models/:accountId', async (req: Request, res: Response) => {
  try {
    const accountId = requireAccount(req);
    const region = String(req.query.region || '');
    if (!REGION_RE.test(region)) return res.status(400).json({ error: '无效的区域' });
    const data = await bt.listFoundationModels(
      accountId, region,
      req.query.provider ? String(req.query.provider) : undefined,
      req.query.inferenceType ? String(req.query.inferenceType) : undefined,
    );
    res.json({ success: true, data });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// 批量创建（tags 必填）
bedrockRouter.post('/profiles/create', requireAdmin, async (req: Request, res: Response) => {
  try {
    const accountId = requireAccount(req);
    const region = String(req.body.region || '');
    if (!REGION_RE.test(region)) return res.status(400).json({ error: '无效的区域' });
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    if (!items.length) return res.status(400).json({ error: '请至少选择一个模型' });
    if (items.length > 100) return res.status(400).json({ error: '一次最多创建 100 个' });
    const tags = validateBedrockTags(req.body.tags);
    const results = await bt.createProfiles(accountId, region, items, tags);
    const user = (req as any).user;
    const created = results.filter(r => r.status !== 'create_failed').length;
    const verified = results.filter(r => r.ok).length;
    db.addAuditLog(user?.userId, 'BEDROCK_PROFILE_CREATE',
      `账户 ${accountId} | ${region} | 创建 ${created}/${results.length}，核验通过 ${verified}（${statusSummary(results)}） | tags: ${formatTags(tags)}`,
      user?.username, req.ip);
    (res.locals as any).audited = true;
    res.json({ success: true, data: results });
  } catch (e: any) { res.status(e instanceof MapTagRuleError ? 400 : 500).json({ error: e.message }); }
});

// 批量删除
bedrockRouter.post('/profiles/delete', requireAdmin, async (req: Request, res: Response) => {
  try {
    const accountId = requireAccount(req);
    const region = String(req.body.region || '');
    if (!REGION_RE.test(region)) return res.status(400).json({ error: '无效的区域' });
    const arns = Array.isArray(req.body.arns) ? req.body.arns.filter((a: any) => typeof a === 'string' && a.startsWith('arn:')) : [];
    if (!arns.length) return res.status(400).json({ error: '请至少选择一个 Profile' });
    const results = await bt.deleteProfiles(accountId, region, arns);
    const user = (req as any).user;
    db.addAuditLog(user?.userId, 'BEDROCK_PROFILE_DELETE',
      `账户 ${accountId} | ${region} | 删除 ${results.filter(r => r.ok).length}/${results.length} 个 Profile`,
      user?.username, req.ip);
    (res.locals as any).audited = true;
    res.json({ success: true, data: results });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// 批量打 Tag（tags 必填）
bedrockRouter.post('/profiles/tag', requireAdmin, async (req: Request, res: Response) => {
  try {
    const accountId = requireAccount(req);
    const region = String(req.body.region || '');
    if (!REGION_RE.test(region)) return res.status(400).json({ error: '无效的区域' });
    const rawArns = req.body.arns;
    if (!Array.isArray(rawArns) || rawArns.some((a: any) => typeof a !== 'string')) {
      return res.status(400).json({ error: 'arns 必须是字符串数组' });
    }
    const arns: string[] = rawArns;
    if (!arns.length) return res.status(400).json({ error: '请至少选择一个 Profile' });
    if (arns.length > 100) return res.status(400).json({ error: '一次最多 100 个 Profile' });
    const tags = validateBedrockTags(req.body.tags);
    // 整单校验在任何写入之前：选错账户/区域分组时一个都不打
    assertArnsBelong(arns, accountId, region);
    const results = await bt.tagProfiles(accountId, region, arns, tags);
    const user = (req as any).user;
    const verified = results.filter(r => r.ok).length;
    const oldCounts = new Map<string, number>();
    for (const r of results) {
      const label = r.oldReadFailed ? '读取失败' : (r.oldMapValue ?? '无');
      oldCounts.set(label, (oldCounts.get(label) || 0) + 1);
    }
    const oldDist = [...oldCounts].map(([v, n]) => `${v}×${n}`).join(', ');
    const removed = results.filter(r => r.removedVariantKeys.length)
      .map(r => `${r.arn.split('/').pop()}(${r.removedVariantKeys.join('/')})`);
    db.addAuditLog(user?.userId, 'BEDROCK_PROFILE_TAG',
      `账户 ${accountId} | ${region} | 打 Tag 核验通过 ${verified}/${results.length}（${statusSummary(results)}）`
      + ` | 旧 map-migrated: ${oldDist} | 新 tags: ${formatTags(tags)}`
      + `${removed.length ? ` | 移除变体 key：${removed.join('，')}` : ''}`,
      user?.username, req.ip);
    (res.locals as any).audited = true;
    res.json({ success: true, data: results });
  } catch (e: any) { res.status(e instanceof MapTagRuleError ? 400 : 500).json({ error: e.message }); }
});

// 解 Tag
bedrockRouter.post('/profiles/untag', requireAdmin, async (req: Request, res: Response) => {
  try {
    const accountId = requireAccount(req);
    const region = String(req.body.region || '');
    if (!REGION_RE.test(region)) return res.status(400).json({ error: '无效的区域' });
    const arns = Array.isArray(req.body.arns) ? req.body.arns.filter((a: any) => typeof a === 'string' && a.startsWith('arn:')) : [];
    const tagKeys = Array.isArray(req.body.tagKeys) ? req.body.tagKeys.filter((k: any) => typeof k === 'string' && k.trim()) : [];
    if (!arns.length || !tagKeys.length) return res.status(400).json({ error: '请选择 Profile 和要移除的 Tag key' });
    const results = await bt.untagProfiles(accountId, region, arns, tagKeys);
    res.json({ success: true, data: results });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ===== 模型测试 =====
bedrockRouter.post('/invoke', requireAdmin, async (req: Request, res: Response) => {
  try {
    const accountId = requireAccount(req);
    const region = String(req.body.region || '');
    if (!REGION_RE.test(region)) return res.status(400).json({ error: '无效的区域' });
    const modelId = String(req.body.modelId || '').trim();
    const prompt = String(req.body.prompt || '').trim();
    if (!modelId || !prompt) return res.status(400).json({ error: 'modelId 和 prompt 必填' });
    const maxTokens = Math.min(4096, Math.max(1, Number(req.body.maxTokens) || 1024));
    const text = await bt.invokeModel(accountId, region, modelId, prompt, maxTokens);
    res.json({ success: true, data: { text } });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ===== FTU 模型开通 =====
bedrockRouter.post('/ftu', requireAdmin, async (req: Request, res: Response) => {
  try {
    const accountId = requireAccount(req);
    const region = String(req.body.region || '');
    if (!REGION_RE.test(region)) return res.status(400).json({ error: '无效的区域' });
    const form = req.body.form || {};
    if (!String(form.companyName || '').trim() || !String(form.useCases || '').trim()) {
      return res.status(400).json({ error: '至少填写公司名称和使用场景' });
    }
    await bt.submitFtu(accountId, region, {
      companyName: String(form.companyName).trim(),
      companyWebsite: String(form.companyWebsite || '').trim(),
      intendedUsers: String(form.intendedUsers || '1').trim(),
      industryOption: String(form.industryOption || '').trim(),
      otherIndustryOption: String(form.otherIndustryOption || '').trim(),
      useCases: String(form.useCases).trim(),
    });
    const user = (req as any).user;
    db.addAuditLog(user?.userId, 'BEDROCK_FTU_SUBMIT',
      `账户 ${accountId} | ${region} | FTU 表单提交（${String(form.companyName).trim()}）`, user?.username, req.ip);
    (res.locals as any).audited = true;
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ===== Fable 5 数据共享 =====
bedrockRouter.get('/data-retention/:accountId', async (req: Request, res: Response) => {
  try {
    const accountId = requireAccount(req);
    const regions = parseRegions(req.query.regions);
    if (!regions.length) return res.status(400).json({ error: '请至少指定一个有效区域' });
    if (regions.length > 20) return res.status(400).json({ error: '一次最多查询 20 个区域' });
    res.json({ success: true, data: await bt.getDataRetention(accountId, regions) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

bedrockRouter.post('/data-retention/enable', requireStrictAdmin, async (req: Request, res: Response) => {
  try {
    const accountId = requireAccount(req);
    const regions = Array.isArray(req.body.regions) ? req.body.regions.filter((r: any) => REGION_RE.test(String(r))) : [];
    if (!regions.length) return res.status(400).json({ error: '请至少指定一个有效区域' });
    const results = await bt.enableProviderDataShare(accountId, regions);
    const user = (req as any).user;
    db.addAuditLog(user?.userId, 'BEDROCK_DATA_SHARE_ENABLE',
      `账户 ${accountId} | 开启 provider_data_share：${results.filter(r => r.ok).length}/${results.length} 区域成功`,
      user?.username, req.ip);
    (res.locals as any).audited = true;
    res.json({ success: true, data: results });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ===== IAM 用户 =====
bedrockRouter.get('/iam-users/:accountId', requireAdmin, async (req: Request, res: Response) => {
  try {
    const accountId = requireAccount(req);
    res.json({ success: true, data: await bt.listIamUsers(accountId) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// 创建 Admin IAM 用户——最高敏感级：strict admin + 审计
bedrockRouter.post('/iam-users/create', requireStrictAdmin, async (req: Request, res: Response) => {
  try {
    const accountId = requireAccount(req);
    const userName = String(req.body.userName || '').trim();
    if (!/^[\w+=,.@-]{1,64}$/.test(userName)) return res.status(400).json({ error: 'IAM 用户名不合法' });
    const result = await bt.createAdminUser(accountId, userName, {
      createConsoleLogin: req.body.createConsoleLogin !== false,
      createAccessKey: req.body.createAccessKey !== false,
      passwordResetRequired: req.body.passwordResetRequired === true,
    });
    const user = (req as any).user;
    db.addAuditLog(user?.userId, 'BEDROCK_IAM_ADMIN_CREATE',
      `账户 ${accountId} | 创建 AdministratorAccess IAM 用户 ${userName}（console:${req.body.createConsoleLogin !== false} key:${req.body.createAccessKey !== false}）`,
      user?.username, req.ip);
    (res.locals as any).audited = true;
    res.json({ success: true, data: result });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ===== 交付表格 =====
// 前端传当前已加载的 profiles 行（只用 name/arn）+ IAM 凭证；服务端校验 ARN 归属，
// 从 AWS 重新读 tags，再校验（map-migrated 存在、格式合规、全表唯一）并生成 xlsx
bedrockRouter.post('/delivery', requireAdmin, async (req: Request, res: Response) => {
  try {
    const requestedAccount = String(req.body.accountId || '');
    if (!ACCOUNT_RE.test(requestedAccount)) return res.status(400).json({ error: '无效的账户 ID' });
    const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
    const iamUser = String(req.body.iamUser || '').trim();
    const iamPassword = String(req.body.iamPassword || '');
    if (!rows.length) return res.status(400).json({ error: '没有 Profile 数据' });
    if (!iamUser || !iamPassword) return res.status(400).json({ error: 'IAM 用户名和密码必填' });
    const base = normalizeDeliveryRows(requestedAccount, rows);
    const authoritative = await attachAwsTags(requestedAccount, base);
    const { buffer, accountId, tagValue } = await buildDeliveryXlsx(authoritative, iamUser, iamPassword);
    const user = (req as any).user;
    db.addAuditLog(user?.userId, 'BEDROCK_DELIVERY_EXPORT',
      `账户 ${accountId} | 交付表格生成（${rows.length} 个 Profile，tag=${tagValue}）`, user?.username, req.ip);
    (res.locals as any).audited = true;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${accountId}-delivery.xlsx"`);
    res.send(buffer);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// 交付表格 v2（李浩版，五列带 TPM/TPD）：
// 服务端实时查 Service Quotas（listBedrockQuotas，与配额页同一条链路）做 Profile↔配额匹配，
// 匹配不到/提额未生效如实写 0（规范红线：TPM/TPD 必须实测，不盲套公式）。
bedrockRouter.post('/delivery-v2', requireAdmin, async (req: Request, res: Response) => {
  try {
    const accountId = String(req.body.accountId || '');
    if (!ACCOUNT_RE.test(accountId)) return res.status(400).json({ error: '无效的账户 ID' });
    const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
    const iamUser = String(req.body.iamUser || '').trim();
    const iamPassword = String(req.body.iamPassword || '');
    if (!rows.length) return res.status(400).json({ error: '没有 Profile 数据' });
    if (!iamUser || !iamPassword) return res.status(400).json({ error: 'IAM 用户名和密码必填' });

    // 交付变体：full = 每区 12 条（us+global）；global = 每区 6 条（仅 global）
    const variant: DeliveryVariant = req.body.variant === 'full' ? 'full' : 'global';

    // ⚠️ 必须先按规范筛选再做后续处理，顺序不能调换：
    // 1) prepareDelivery 会对**每一行**强校验 map-migrated tag，老模型若没打 tag
    //    会直接抛错，可它本来就不该出现在交付表里；
    // 2) 配额匹配对老模型也是纯浪费。
    // 3) 标签只在筛选之后从 AWS 读（attachAwsTags），前端传来的 tags 一律不用
    const base = normalizeDeliveryRows(accountId, rows);
    const { kept, dropped, missingByRegion } = filterAndSortForDelivery(base, variant);
    if (!kept.length) {
      return res.status(400).json({
        error: `账户中找不到任何交付清单内的 Profile（变体：${variant === 'full' ? '全量版' : '仅 global 版'}）。`
          + `已加载 ${rows.length} 个 Profile，均不在清单中。`,
      });
    }

    const keptWithTags = await attachAwsTags(accountId, kept);

    // 实时拉配额（只覆盖筛选后 rows 涉及的区域）
    const regions: string[] = [...new Set<string>(keptWithTags.map(r => r.region))].filter(r => REGION_RE.test(r));
    const quota = await listBedrockQuotas(accountId, regions);
    const rowsV2 = keptWithTags.map(r => ({
      name: r.name, arn: r.arn, region: r.region,
      tags: r.tags,
      ...bt.matchProfileTpmTpd(
        { backendModels: r.backendModels, name: r.name, scope: r.scope ?? '', region: r.region },
        quota.rows,
      ),
    }));
    const { buffer, accountId: acc, tagValue } = await buildDeliveryXlsxV2(rowsV2, iamUser, iamPassword);

    // 配额为 0 的条目要让操作者知道（规范：提额未生效如实写 0，但必须人工确认后再交付）
    const zeroQuota = rowsV2.filter(r => !r.tpm || !r.tpd).map(r => `${r.region}/${r.name}`);
    res.setHeader('X-Delivery-Variant', variant);
    res.setHeader('X-Delivery-Rows', String(rowsV2.length));
    if (zeroQuota.length) res.setHeader('X-Delivery-Zero-Quota', encodeURIComponent(zeroQuota.join(',')));
    if (missingByRegion.size) {
      const miss = [...missingByRegion].map(([reg, ns]) => `${reg}:${ns.join('|')}`).join(',');
      res.setHeader('X-Delivery-Missing', encodeURIComponent(miss));
    }

    const user = (req as any).user;
    db.addAuditLog(user?.userId, 'BEDROCK_DELIVERY_EXPORT',
      `账户 ${acc} | 交付表格 v2（李浩版，变体=${variant}，含 TPM/TPD，`
      + `加载 ${rows.length} → 交付 ${rowsV2.length} 条，剔除 ${dropped.length} 种老模型`
      + `${zeroQuota.length ? `，配额为 0：${zeroQuota.length} 条` : ''}，tag=${tagValue}）`,
      user?.username, req.ip);
    (res.locals as any).audited = true;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${acc}-delivery-v2.xlsx"`);
    res.send(buffer);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});
