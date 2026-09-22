/**
 * POC Cash 路由（挂载在 /api/poc-cash/*）。
 *
 * ⚠️ 全路由 admin-only：包括 GET。这里会创建真实商机并提交给 AWS 审核，
 * 属于对外发生实际业务动作的写操作，不对 viewer / partadmin 开放。
 * requireStrictAdmin 实时查库，避免 token 里的旧角色绕过。
 */
import { Router, Request, Response, NextFunction } from 'express';
import fs from 'fs';
import path from 'path';
import { db } from '../db';
import * as poc from '../poc-cash';
import * as fund from '../poc-cash-funding';

// CSV 快照目录。与账单导出同级，纳入同一套磁盘监控。
const POC_CSV_DIR = path.join(__dirname, '../../../data/poc-cash');

function savePocCsv(csv: string) {
  fs.mkdirSync(POC_CSV_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = `poc-cash-${ts}.csv`;
  fs.writeFileSync(path.join(POC_CSV_DIR, file), csv, 'utf-8');
  // 同时维护一份 latest，方便直接覆盖到本地台账
  fs.writeFileSync(path.join(POC_CSV_DIR, 'poc-cash-latest.csv'), csv, 'utf-8');
  return { file, savedAt: new Date().toISOString() };
}

function listPocCsvFiles() {
  try {
    return fs.readdirSync(POC_CSV_DIR)
      .filter(f => f.endsWith('.csv') && f !== 'poc-cash-latest.csv')
      .sort().reverse().slice(0, 50)
      .map(f => {
        const st = fs.statSync(path.join(POC_CSV_DIR, f));
        return { file: f, size: st.size, savedAt: st.mtime.toISOString() };
      });
  } catch {
    return [];
  }
}

/** 生成定价计算器链接。calculator.aws 的后端是未公开端点，
 *  失败不应让整个 POC 创建挂掉 —— 抛出明确错误由调用方决定。 */
async function makeCalculator(name: string, region: string, mrrUsd: number) {
  const { buildPocEstimate, saveEstimate, shareUrl, verifyEstimate } =
    await import('../pricing-calculator');
  const est = await buildPocEstimate(name, region, mrrUsd);
  const key = await saveEstimate(est);
  const v = await verifyEstimate(key, est.totalCost.monthly,
    Object.keys(est.services).length);
  if (!v.ok) throw new Error(`计算器读回校验失败：${v.problems.join('；')}`);
  return shareUrl(key);
}

export const pocCashRouter = Router();

/** 实时校验数据库中的角色，不信任 token 里的 role */
const requireStrictAdmin = (req: Request, res: Response, next: NextFunction) => {
  const user = (req as any).user;
  const dbUser = user?.username ? db.getUser(user.username) : null;
  if (!dbUser || dbUser.role !== 'admin') {
    return res.status(403).json({ error: '需要 admin 权限' });
  }
  next();
};

pocCashRouter.use(requireStrictAdmin);

/**
 * 从 query / body 取 partnerKey，缺省回落到默认主体。
 * 非法值直接交给 getPartner 抛错，不静默当成默认主体 ——
 * 否则前端传错 key 会把数据建到 Webby 账户里。
 */
function partnerKeyOf(req: Request): string {
  const raw = String(
    (req.query?.partnerKey ?? req.body?.partnerKey ?? '') || '',
  ).trim();
  if (!raw) return poc.DEFAULT_PARTNER_KEY;
  poc.getPartner(raw);   // 校验，非法则抛
  return raw;
}

/** 表单选项：partner 列表、用例、行业、凭证状态 */
pocCashRouter.get('/meta', (_req: Request, res: Response) => {
  res.json({
    configured: poc.isConfigured(),
    partners: poc.PARTNERS.map(p => ({
      key: p.key, label: p.label,
      titlePrefix: p.titlePrefix, titleSuffix: p.titleSuffix,
      defaultSolutionId: p.defaultSolutionId,
      apnAccountId: p.apnAccountId,
      // 逐个主体报告可用性：某个主体没配 role 时前端能直接标出来，
      // 而不是等用户提交后才报错
      configured: poc.isConfigured(p.key),
    })),
    useCases: poc.USE_CASES,
    industries: poc.INDUSTRIES,
    stages: poc.STAGES,
    closedLost: poc.CLOSED_LOST,
  });
});

/** 可关联的 Solutions（仅 Active） */
pocCashRouter.get('/solutions', async (req: Request, res: Response) => {
  try {
    res.json({ solutions: await poc.listSolutions(partnerKeyOf(req)) });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

/** 已有商机列表（摘要），供「参考已有商机」选择。支持按客户名搜索。 */
pocCashRouter.get('/opportunities', async (req: Request, res: Response) => {
  try {
    const search = typeof req.query.search === 'string' ? req.query.search : '';
    const limit = Number(req.query.limit) || 60;
    res.json({
      opportunities: await poc.listOpportunityBriefs({
        search, limit, partnerKey: partnerKeyOf(req),
      }),
    });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

/** 单个商机的完整内容作为模板。
 *  ListOpportunities 不返回 Title/UseCase/业务描述，必须单独 Get。 */
pocCashRouter.get('/opportunities/:id', async (req: Request, res: Response) => {
  const id = String(req.params.id || '');
  if (!/^O\d+$/.test(id)) {
    return res.status(400).json({ error: '无效的商机 ID' });
  }
  try {
    res.json(await poc.getOpportunityTemplate(id, partnerKeyOf(req)));
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

const OPP_ID_RE = /^O\d+$/;
const APP_ID_RE = /^benappl-[a-z0-9]+$/i;
const ACCOUNT_RE = /^\d{12}$/;

// ===== POC 资金申请 =====

/** 表单选项：竞争对手、默认值、前置说明 */
pocCashRouter.get('/funding/meta', (_req: Request, res: Response) => {
  res.json({
    considering: fund.CONSIDERING_OPTIONS,
    minLeadDays: fund.MIN_LEAD_DAYS,
    defaults: { people: 2, days: 3, calcRegion: 'ap-southeast-5' },
  });
});

/** 账户 → 项目桶（payer）。用平台 accounts_cache，毫秒级返回；
 *  遍历 45 个 payer 的 Organizations 要 60~90 秒，不能放表单里。 */
pocCashRouter.get('/funding/account/:id', (req: Request, res: Response) => {
  const id = String(req.params.id || '');
  if (!ACCOUNT_RE.test(id)) return res.status(400).json({ error: '账户 ID 应为 12 位数字' });
  const info = fund.accountInfo(id);
  if (!info) {
    return res.status(404).json({ error: '账户不在平台缓存中，请先在账户管理页刷新' });
  }
  res.json(info);
});

/** 金额预览 + 风险项（提交前可先看） */
pocCashRouter.post('/funding/preview', async (req: Request, res: Response) => {
  const b = req.body || {};
  const oppId = String(b.opportunityId || '');
  if (!OPP_ID_RE.test(oppId)) return res.status(400).json({ error: '无效的商机 ID' });
  try {
    const pre = await fund.precheckOpportunity(oppId);
    const people = Number(b.people) || 2;
    const days = Number(b.days) || 3;
    const leadDays = Number(b.leadDays) || fund.MIN_LEAD_DAYS;
    const amounts = fund.computeAmounts(pre.mrrUsd, people, days);
    res.json({
      precheck: pre,
      amounts,
      warnings: fund.warningsFor(amounts, leadDays),
      bucket: b.awsAccountId ? fund.bucketOfAccount(String(b.awsAccountId)) : null,
    });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

/** 创建 POC 申请（可选提交）。商机不合格会直接拒绝 —— 没有商机不能提 POC。 */
pocCashRouter.post('/funding', async (req: Request, res: Response) => {
  const b = req.body || {};
  try {
    if (!OPP_ID_RE.test(String(b.opportunityId || ''))) {
      throw new Error('必须先选择商机 —— 没有商机不能提 POC');
    }
    if (!ACCOUNT_RE.test(String(b.awsAccountId || ''))) {
      throw new Error('AWS 账户 ID 应为 12 位数字');
    }
    const desc = String(b.description || '').trim();
    if (desc.length < 50) throw new Error('业务描述至少 50 字');

    const result = await fund.createPocApplication({
      opportunityId: String(b.opportunityId),
      awsAccountId: String(b.awsAccountId),
      description: desc,
      activityName: b.activityName ? String(b.activityName) : undefined,
      name: b.name ? String(b.name) : undefined,
      considering: b.considering ? String(b.considering) : undefined,
      people: Number(b.people) || undefined,
      days: Number(b.days) || undefined,
      leadDays: Number(b.leadDays) || undefined,
      budgetYear: Number(b.budgetYear) || undefined,
      calculatorUrl: b.calculatorUrl ? String(b.calculatorUrl) : undefined,
      calcRegion: b.calcRegion ? String(b.calcRegion) : undefined,
      submit: b.submit !== false,
      force: !!b.force,
    }, makeCalculator);

    const user = (req as any).user;
    db.addAuditLog(user?.userId, 'POC_FUNDING_CREATE',
      `${result.applicationId} | ${result.name} | 商机 ${result.opportunityId}`
      + ` | ${result.amounts.pocUsd} USD | ${result.submitted ? '已提交' : '未提交'}`
      + `${result.warnings.length ? ` | 警告 ${result.warnings.length} 条` : ''}`,
      user?.username, req.ip);
    (res.locals as any).audited = true;
    res.json(result);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

/** 提交已创建的申请（不新建，避免重复单据） */
pocCashRouter.post('/funding/:id/submit', async (req: Request, res: Response) => {
  const id = String(req.params.id || '');
  if (!APP_ID_RE.test(id)) return res.status(400).json({ error: '无效的申请 ID' });
  try {
    const r = await fund.submitExisting(id);
    const user = (req as any).user;
    db.addAuditLog(user?.userId, 'POC_FUNDING_SUBMIT',
      `${id} | ${r.status} / ${r.stage}`, user?.username, req.ip);
    (res.locals as any).audited = true;
    res.json(r);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

/** POC 进度列表 */
pocCashRouter.get('/funding', async (req: Request, res: Response) => {
  try {
    res.json({
      applications: await fund.listPocApplications({
        includeMigrated: req.query.includeMigrated === '1',
      }),
    });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * CSV 台账：服务器留存一份带时间戳的快照，同时回传供下载。
 *
 * 留存而非纯下载，是为了保留变更历史 —— PO 号、到账金额是 AWS 事后回填的，
 * 有历史快照才能回溯「什么时候批的、什么时候到账的」。
 */
pocCashRouter.post('/funding/export', async (req: Request, res: Response) => {
  try {
    const rows = await fund.listPocApplications();
    // 商机标题/MRR/阶段在 Benefits API 里没有，逐个补齐
    const oppIds = [...new Set(rows.map(r => r.opportunityId).filter(Boolean))];
    const opportunities: Record<string, any> = {};
    await Promise.all(oppIds.map(async (id) => {
      try {
        const t = await poc.getStageStatus(id as string);
        opportunities[id as string] = {
          title: t.title, mrrUsd: t.mrrUsd, stage: t.stage,
        };
      } catch { /* 单条失败不影响整表 */ }
    }));

    const user = (req as any).user;
    const csv = fund.buildCsv(rows, {
      opportunities,
      owner: String(req.body?.owner || user?.username || ''),
    });

    const saved = savePocCsv(csv);
    db.addAuditLog(user?.userId, 'POC_FUNDING_EXPORT',
      `导出 ${rows.length} 条 | ${saved.file}`, user?.username, req.ip);
    (res.locals as any).audited = true;
    res.json({ rows: rows.length, file: saved.file, savedAt: saved.savedAt, csv });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

/** 历史快照列表 */
pocCashRouter.get('/funding/exports', (_req: Request, res: Response) => {
  res.json({ files: listPocCsvFiles() });
});

/** 查商机阶段与可操作性（提交后用它确认 AWS 审到哪一步了）。 */
pocCashRouter.get('/opportunities/:id/stage', async (req: Request, res: Response) => {
  const id = String(req.params.id || '');
  if (!OPP_ID_RE.test(id)) return res.status(400).json({ error: '无效的商机 ID' });
  try {
    res.json(await poc.getStageStatus(id, partnerKeyOf(req)));
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

/** 推进阶段。服务端自己 Get 最新 LastModifiedDate 做乐观锁，
 *  不接受前端传时间戳（避免用陈旧值触发 ConflictException）。 */
pocCashRouter.post('/opportunities/:id/stage', async (req: Request, res: Response) => {
  const id = String(req.params.id || '');
  if (!OPP_ID_RE.test(id)) return res.status(400).json({ error: '无效的商机 ID' });
  const stage = String(req.body?.stage || '');
  try {
    const pk = partnerKeyOf(req);
    const after = await poc.advanceStage(id, stage, pk);
    const user = (req as any).user;
    db.addAuditLog(user?.userId, 'POC_OPPORTUNITY_STAGE',
      `[${pk}] ${id} | 阶段推进到 ${after.stage} | ReviewStatus ${after.reviewStatus}`,
      user?.username, req.ip);
    (res.locals as any).audited = true;
    res.json(after);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

/** 标题预览：前端实时显示自动生成的标题，避免提交后才发现命名不对 */
pocCashRouter.post('/preview-title', (req: Request, res: Response) => {
  try {
    const partner = poc.getPartner(String(req.body.partnerKey || ''));
    const title = poc.buildTitle(
      partner,
      String(req.body.companyName || ''),
      String(req.body.projectName || ''));
    res.json({ title });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

/** 金额联动：MRR → ARR → POC 可申请额 */
pocCashRouter.get('/amounts', (req: Request, res: Response) => {
  const mrr = Number(req.query.mrr);
  if (!Number.isFinite(mrr) || mrr <= 0) {
    return res.status(400).json({ error: 'mrr 必须是正数' });
  }
  res.json(poc.deriveAmounts(mrr));
});

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 创建商机（可选提交）。校验一律在服务端做，不信任前端。 */
pocCashRouter.post('/opportunities', async (req: Request, res: Response) => {
  const b = req.body || {};
  const need = (v: any) => typeof v === 'string' && v.trim().length > 0;

  try {
    if (!need(b.partnerKey)) throw new Error('请选择 Partner');
    if (!need(b.companyName)) throw new Error('客户公司名必填');
    // 白名单校验：服务层对 Industry/CountryCode 用了 as any 断言绕过 SDK 字面量类型，
    // 合法性必须在这里兜住，否则非法值会一路传到 AWS 才报错。
    if (!poc.INDUSTRIES.includes(String(b.industry))) throw new Error('行业取值非法');
    if (!need(b.websiteUrl)) throw new Error('客户网址必填');
    if (!/^[A-Za-z]{2}$/.test(String(b.countryCode || ''))) {
      throw new Error('国家代码应为 2 位字母（ISO 3166-1，如 MY）');
    }
    if (!poc.USE_CASES.includes(String(b.customerUseCase))) {
      throw new Error('Use Case 取值非法（必须用 AWS 的完整字面量）');
    }
    if (!need(b.titleOverride) && !need(b.projectName)) {
      throw new Error('项目名称必填（或直接填写完整标题）');
    }
    const problem = String(b.customerBusinessProblem || '').trim();
    // AWS 审商机会看业务描述是否具体，过短基本会被打回
    if (problem.length < 50) throw new Error('业务描述至少 50 字');

    const mrrUsd = Number(b.mrrUsd);
    if (!Number.isFinite(mrrUsd) || mrrUsd <= 0) throw new Error('MRR 必须是正数');

    if (!DATE_RE.test(String(b.targetCloseDate || ''))) {
      throw new Error('预计成交日期格式应为 YYYY-MM-DD');
    }

    const result = await poc.createOpportunity({
      partnerKey: String(b.partnerKey),
      companyName: String(b.companyName).trim(),
      industry: String(b.industry),
      websiteUrl: String(b.websiteUrl).trim(),
      countryCode: String(b.countryCode).trim().toUpperCase(),
      postalCode: b.postalCode ? String(b.postalCode).trim() : undefined,
      projectName: String(b.projectName || '').trim(),
      titleOverride: b.titleOverride ? String(b.titleOverride).trim() : undefined,
      customerBusinessProblem: problem,
      customerUseCase: String(b.customerUseCase),
      mrrUsd,
      targetCloseDate: String(b.targetCloseDate),
      solutionId: b.solutionId ? String(b.solutionId) : undefined,
      marketingSource: b.marketingSource === 'None' ? 'None' : 'Marketing Activity',
      submit: b.submit !== false,
    });

    const user = (req as any).user;
    db.addAuditLog(user?.userId, 'POC_OPPORTUNITY_CREATE',
      `${result.opportunityId} | ${result.title} | MRR ${result.amounts.mrrUsd} USD`
      + ` | Solution ${result.solutionAssociated ? result.solutionId : '未关联'}`
      + ` | ${result.submitted ? '已提交' : '未提交'}`
      + `${result.warnings.length ? ` | 警告 ${result.warnings.length} 条` : ''}`,
      user?.username, req.ip);
    (res.locals as any).audited = true;

    res.json(result);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});
