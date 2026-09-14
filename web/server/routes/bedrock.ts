/**
 * Bedrock 工具路由（挂载在 /api/aws/bedrock-tools/*，
 * 经 authMiddleware + auditMiddleware；写操作再加 requireAdmin/requireStrictAdmin）。
 *
 * ⚠️ Tag 纪律：创建 Profile / 打 Tag 的 tags 必填，服务端强校验非空且每个 key/value 非空，
 * 绝不提供默认值（防止错打别家 MAP tag）。
 */
import { Router, Request, Response, NextFunction } from 'express';
import { db } from '../db';
import * as bt from '../bedrock-tools';
import {
  buildDeliveryXlsx, buildDeliveryXlsxV2, filterAndSortForDelivery,
  type DeliveryVariant,
} from '../bedrock-delivery';
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

/** tags 强校验：非空数组，每项 key/value 均为非空字符串。不提供任何默认值。 */
function validateTags(tags: any): Array<{ key: string; value: string }> {
  if (!Array.isArray(tags) || tags.length === 0) {
    throw new Error('必须提供至少一个 Tag（key/value 均必填，平台不提供默认 Tag）');
  }
  const out: Array<{ key: string; value: string }> = [];
  for (const t of tags) {
    const key = typeof t?.key === 'string' ? t.key.trim() : '';
    const value = typeof t?.value === 'string' ? t.value.trim() : '';
    if (!key || !value) throw new Error('Tag 的 key 和 value 都不能为空');
    out.push({ key, value });
  }
  return out;
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
    const tags = validateTags(req.body.tags);
    const results = await bt.createProfiles(accountId, region, items, tags);
    const user = (req as any).user;
    const ok = results.filter(r => r.ok).length;
    db.addAuditLog(user?.userId, 'BEDROCK_PROFILE_CREATE',
      `账户 ${accountId} | ${region} | 创建 ${ok}/${results.length} 个 Profile | tags: ${tags.map(t => `${t.key}=${t.value}`).join(';')}`,
      user?.username, req.ip);
    (res.locals as any).audited = true;
    res.json({ success: true, data: results });
  } catch (e: any) { res.status(e.message?.includes('Tag') ? 400 : 500).json({ error: e.message }); }
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
    const arns = Array.isArray(req.body.arns) ? req.body.arns.filter((a: any) => typeof a === 'string' && a.startsWith('arn:')) : [];
    if (!arns.length) return res.status(400).json({ error: '请至少选择一个 Profile' });
    const tags = validateTags(req.body.tags);
    const results = await bt.tagProfiles(accountId, region, arns, tags);
    const user = (req as any).user;
    db.addAuditLog(user?.userId, 'BEDROCK_PROFILE_TAG',
      `账户 ${accountId} | ${region} | ${results.filter(r => r.ok).length}/${results.length} 个 Profile | tags: ${tags.map(t => `${t.key}=${t.value}`).join(';')}`,
      user?.username, req.ip);
    (res.locals as any).audited = true;
    res.json({ success: true, data: results });
  } catch (e: any) { res.status(e.message?.includes('Tag') ? 400 : 500).json({ error: e.message }); }
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
// 前端传当前已加载的 profiles 行 + IAM 凭证，服务端校验（账户唯一、map-migrated tag 唯一且必须存在）并生成 xlsx
bedrockRouter.post('/delivery', requireAdmin, async (req: Request, res: Response) => {
  try {
    const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
    const iamUser = String(req.body.iamUser || '').trim();
    const iamPassword = String(req.body.iamPassword || '');
    if (!rows.length) return res.status(400).json({ error: '没有 Profile 数据' });
    if (!iamUser || !iamPassword) return res.status(400).json({ error: 'IAM 用户名和密码必填' });
    const { buffer, accountId, tagValue } = await buildDeliveryXlsx(rows, iamUser, iamPassword);
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
    const { kept, dropped, missingByRegion } =
      filterAndSortForDelivery(rows.map((r: any) => ({ ...r, name: String(r.name || ''), region: String(r.region || '') })), variant);
    if (!kept.length) {
      return res.status(400).json({
        error: `账户中找不到任何交付清单内的 Profile（变体：${variant === 'full' ? '全量版' : '仅 global 版'}）。`
          + `已加载 ${rows.length} 个 Profile，均不在清单中。`,
      });
    }

    // 实时拉配额（只覆盖筛选后 rows 涉及的区域）
    const regions: string[] = [...new Set<string>(kept.map((r: any) => String(r.region)))].filter(r => REGION_RE.test(r));
    const quota = await listBedrockQuotas(accountId, regions);
    const rowsV2 = kept.map((r: any) => ({
      name: String(r.name || ''), arn: String(r.arn || ''), region: String(r.region || ''),
      tags: Array.isArray(r.tags) ? r.tags : [],
      ...bt.matchProfileTpmTpd(
        { backendModels: r.backendModels, name: r.name, scope: r.scope, region: r.region },
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
