/**
 * POC Cash 路由（挂载在 /api/poc-cash/*）。
 *
 * ⚠️ 全路由 admin-only：包括 GET。这里会创建真实商机并提交给 AWS 审核，
 * 属于对外发生实际业务动作的写操作，不对 viewer / partadmin 开放。
 * requireStrictAdmin 实时查库，避免 token 里的旧角色绕过。
 */
import { Router, Request, Response, NextFunction } from 'express';
import { db } from '../db';
import * as poc from '../poc-cash';

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

/** 表单选项：partner 列表、用例、行业、凭证状态 */
pocCashRouter.get('/meta', (_req: Request, res: Response) => {
  res.json({
    configured: poc.isConfigured(),
    partners: poc.PARTNERS.map(p => ({
      key: p.key, label: p.label,
      titlePrefix: p.titlePrefix, titleSuffix: p.titleSuffix,
      defaultSolutionId: p.defaultSolutionId,
    })),
    useCases: poc.USE_CASES,
    industries: poc.INDUSTRIES,
  });
});

/** 可关联的 Solutions（仅 Active） */
pocCashRouter.get('/solutions', async (_req: Request, res: Response) => {
  try {
    res.json({ solutions: await poc.listSolutions() });
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
