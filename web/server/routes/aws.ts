import { Router, Request, Response } from 'express';
import * as aws from '../aws-service';
import { db, BillingExportJob, TagOnboardingConflictError } from '../db';
import { generateQuotaDoc, getCompanyForAccount } from '../doc-generator';
import { submitCaseDoc, getCaseDocJob } from '../case-doc-submitter';
import { COMPANY_PROFILES } from '../doc-templates';
import {
  cancelBillingExport,
  getBillingExportDownload,
  getBillingExportJob,
  getBillingExportJobsForUser,
  submitBillingExport,
  toBillingExportJobView,
} from '../billing-export-jobs';
import { auditLogsToCsv, enrichAuditLog } from '../audit-presentation';
import { syncAccountRoles, getAccountRolesSummary } from '../account-roles';
import { getDepartedSummary, backfillDepartures } from '../account-lifecycle';
import {
  getRestrictedAccounts, markRestricted, unmarkRestricted,
  getExternalId, RESTRICTED_UNAVAILABLE,
} from '../restricted-accounts';
import { listApnAccounts, probeApnAccount, APN_UNAVAILABLE,
  getApnConsoleSigninUrl, apnPartnerKeyForAccount } from '../apn-accounts';
import * as tagCompliance from '../tag-compliance';
import * as tagOnboarding from '../tag-onboarding';
import { pipeline } from 'stream/promises';
import { cancelRootEmail, listRootEmails, rootEmailAvailability, submitRootEmail, rootEmailCatalog,
  listRootEmailBatches, getRootEmailBatch, submitRootEmailBatch, cancelRootEmailBatch, getRootResetLink,
  getManualRootResetLink, prepareRootCredentialCsv, retryRootEmailJob,
  getRootEmailManualCaptcha, answerRootEmailManualCaptcha } from '../root-email-jobs';
import { type CredentialDownloadSlot, RootEmailError } from '../root-email-core';
import { MailApiError } from '../mail-api';
import { createRootResetGuard } from '../root-reset-permissions';
import { StepUpMfaError, verifyStepUpTotp } from '../step-up-mfa';

export const awsRouter = Router();

// RBAC: reject write operations for viewer role
const requireAdmin = (req: Request, res: Response, next: any) => {
  if ((req as any).user?.role === 'viewer') {
    return res.status(403).json({ error: '查看者角色无此权限' });
  }
  next();
};

// 严格 admin —— 只放 role === 'admin'。
// 注意上面的 requireAdmin 名不符实：它只拦 viewer，partadmin 是放行的。
// 那个行为被提额、资源删除等端点依赖，不宜更改，所以这里单独提供严格版本。
// 与 requireRootAccess 一致，从数据库读当前角色，不信任 JWT 里可能已过期的角色
// （authMiddleware 直接把 JWT payload 挂到 req.user，降级用户在 token 过期前仍持旧角色）。
const requireStrictAdmin = (req: Request, res: Response, next: any) => {
  const tokenUser = (req as any).user;
  const currentUser = tokenUser?.username ? db.getUser(tokenUser.username) : null;
  if (!currentUser
    || String(currentUser.id) !== String(tokenUser?.userId)
    || currentUser.username !== tokenUser?.username) {
    return res.status(401).json({ error: '用户身份已变更，请重新登录' });
  }
  if (currentUser.role !== 'admin') {
    return res.status(403).json({ error: '仅管理员可访问' });
  }
  next();
};

// ===== MAP 标签合规（编排中央工具账户的 tag-compliance 系统）=====

// 是否已配置（前端据此显示未配置提示）
awsRouter.get('/tag-compliance/status', async (_req: Request, res: Response) => {
  res.json({ success: true, data: { configured: tagCompliance.isConfigured() } });
});

// 全自动接入：提交后由持久化 runner 完成资源、索引、S3 配置和最终校验。
awsRouter.post('/tag-compliance/onboarding', requireStrictAdmin, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const result = tagOnboarding.submitTagOnboarding({
      payerAccountId: req.body?.payerAccountId,
      tagValue: req.body?.tagValue,
      extraTagKey: req.body?.extraTagKey,
      extraTagValue: req.body?.extraTagValue,
      requestedBy: user?.username,
    });
    try {
      db.addAuditLog(
        user?.userId,
        'TAG_ONBOARDING_SUBMIT',
        `${result.reused ? '复用' : '创建'} MAP 一键接入任务 ${result.job.id}，payer ${result.job.payerAccountId}`
        + (result.job.extraTagKey
          ? `，额外标签 ${result.job.extraTagKey}=${result.job.extraTagValue}` : ''),
        user?.username,
        req.ip,
      );
      (res.locals as any).audited = true;
    } catch (auditError: any) {
      // 任务已经持久化并可能开始执行，审计失败不能把已接受的任务伪装成 400。
      console.error(`[MAP Onboarding] 任务 ${result.job.id} 审计写入失败:`, auditError.message);
    }
    res.status(result.reused ? 200 : 202).json({ success: true, data: result });
  } catch (e: any) {
    if (e instanceof TagOnboardingConflictError || e?.code === 'TAG_ONBOARDING_CONFLICT') {
      return res.status(409).json({ error: e.message, data: { activeJob: e.activeJob } });
    }
    const badRequest = /12 位|tag_value|不能超过/.test(String(e.message));
    res.status(badRequest ? 400 : 500).json({ error: e.message });
  }
});

// 查询某 payer 最近一次任务，供刷新页面或重开弹窗时恢复进度。
awsRouter.get('/tag-compliance/onboarding', async (req: Request, res: Response) => {
  try {
    const payer = String(req.query.payer || '').trim();
    if (!/^\d{12}$/.test(payer)) return res.status(400).json({ error: '请提供 12 位 payer 账户 ID' });
    res.json({ success: true, data: tagOnboarding.getLatestTagOnboardingJob(payer) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

awsRouter.get('/tag-compliance/onboarding/:jobId', async (req: Request, res: Response) => {
  try {
    const job = tagOnboarding.getTagOnboardingJob(String(req.params.jobId || ''));
    if (!job) return res.status(404).json({ error: 'MAP 接入任务不存在' });
    res.json({ success: true, data: job });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

awsRouter.post('/tag-compliance/onboarding/:jobId/retry', requireStrictAdmin, async (req: Request, res: Response) => {
  try {
    const job = tagOnboarding.retryOnboarding(String(req.params.jobId || ''));
    const user = (req as any).user;
    try {
      db.addAuditLog(user?.userId, 'TAG_ONBOARDING_RETRY', `重试 MAP 一键接入任务 ${job.id}，payer ${job.payerAccountId}`, user?.username, req.ip);
      (res.locals as any).audited = true;
    } catch (auditError: any) {
      console.error(`[MAP Onboarding] 重试任务 ${job.id} 审计写入失败:`, auditError.message);
    }
    res.status(202).json({ success: true, data: job });
  } catch (e: any) {
    if (String(e.message).includes('不存在')) return res.status(404).json({ error: e.message });
    if (String(e.message).includes('只有失败')) return res.status(409).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// 读取组织配置 orgs.json（同时返回 ETag，手工保存必须做条件写）
awsRouter.get('/tag-compliance/config', async (_req: Request, res: Response) => {
  try {
    const snapshot = await tagCompliance.getOrgsConfigSnapshot();
    res.json({ success: true, data: snapshot.orgs, meta: { etag: snapshot.etag, versionId: snapshot.versionId } });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// 写入组织配置 orgs.json（viewer 拦截 + ETag 防陈旧覆盖 + 校验 + 审计）
awsRouter.put('/tag-compliance/config', requireStrictAdmin, async (req: Request, res: Response) => {
  try {
    if (!req.body || Array.isArray(req.body) || !Object.prototype.hasOwnProperty.call(req.body, 'etag')) {
      return res.status(400).json({ error: '保存组织配置必须携带最近读取到的 ETag，请先重新加载' });
    }
    const orgs = req.body.orgs;
    const expectedEtag = typeof req.body.etag === 'string' ? req.body.etag : null;
    const r = await tagCompliance.putOrgsConfig(orgs, expectedEtag);
    const user = (req as any).user;
    db.addAuditLog(user?.userId, 'TAG_CONFIG_UPDATE', `更新 MAP 组织配置 (${r.count} 个组织)`, user?.username, req.ip);
    (res.locals as any).audited = true;
    res.json({ success: true, data: r });
  } catch (e: any) {
    if (e instanceof tagCompliance.OrgConfigConflictError || e?.code === 'ORG_CONFIG_CONFLICT') {
      return res.status(409).json({ error: e.message });
    }
    res.status(400).json({ error: e.message });
  }
});

// 触发扫描（严格 admin + 显式风险确认 + 审计）。中央状态机未暴露本次
// dry-run/正式模式，后端不能根据上一份报告推断，必须由操作者确认中央配置。
const MAP_SCAN_CONFIRMATION = 'TRIGGER_MAP_SCAN_WITH_CENTRAL_MODE';
awsRouter.post('/tag-compliance/scan', requireStrictAdmin, async (req: Request, res: Response) => {
  try {
    if (req.body?.confirmation !== MAP_SCAN_CONFIRMATION) {
      return res.status(400).json({
        error: '触发前必须确认：本次运行模式由中央状态机配置决定，可能真实修改所有已配置组织的资源标签',
      });
    }
    const r = await tagCompliance.startScan();
    const user = (req as any).user;
    db.addAuditLog(
      user?.userId,
      'TAG_SCAN_TRIGGER',
      `显式确认中央运行模式后触发 MAP 标签扫描: ${r.executionArn}`,
      user?.username,
      req.ip,
    );
    (res.locals as any).audited = true;
    res.json({ success: true, data: r });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// 最近执行记录
awsRouter.get('/tag-compliance/executions', async (_req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await tagCompliance.listExecutions(15) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// 最新报告（附带 org_id → payer 名称映射，便于前端展示归属）
awsRouter.get('/tag-compliance/report', async (_req: Request, res: Response) => {
  try {
    const [report, orgMeta] = await Promise.all([
      tagCompliance.getLatestReport(),
      tagCompliance.getOrgPayerMap().catch(() => ({})),
    ]);
    res.json({ success: true, data: report ? { ...report, orgMeta } : { orgMeta, report: null } });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// 报告通知邮箱（SNS 订阅）：列出 / 添加 / 删除
awsRouter.get('/tag-compliance/notify-emails', async (_req: Request, res: Response) => {
  try {
    if (!tagCompliance.isNotifyConfigured()) {
      return res.json({ success: true, data: { configured: false, subscriptions: [] } });
    }
    const subscriptions = await tagCompliance.listNotifySubscriptions();
    res.json({ success: true, data: { configured: true, subscriptions } });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

awsRouter.post('/tag-compliance/notify-emails', requireStrictAdmin, async (req: Request, res: Response) => {
  try {
    const email = String(req.body?.email || '').trim();
    const r = await tagCompliance.addNotifyEmail(email);
    const user = (req as any).user;
    if (!r.alreadyExists) {
      db.addAuditLog(user?.userId, 'TAG_NOTIFY_EMAIL_ADD', `添加 MAP 标签合规报告通知邮箱 ${email}`, user?.username, req.ip);
      (res.locals as any).audited = true;
    }
    res.json({ success: true, data: r });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

awsRouter.delete('/tag-compliance/notify-emails', requireStrictAdmin, async (req: Request, res: Response) => {
  try {
    const subscriptionArn = String(req.body?.subscriptionArn || req.query.subscriptionArn || '').trim();
    const endpoint = String(req.body?.endpoint || '').trim();
    await tagCompliance.removeNotifySubscription(subscriptionArn);
    const user = (req as any).user;
    db.addAuditLog(user?.userId, 'TAG_NOTIFY_EMAIL_REMOVE', `移除 MAP 标签合规报告通知邮箱 ${endpoint || subscriptionArn}`, user?.username, req.ip);
    (res.locals as any).audited = true;
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// 下发 Resource Explorer 索引 StackSet（替代控制台 Quick Setup，异步执行）
awsRouter.post('/tag-compliance/re-indexes', requireStrictAdmin, async (req: Request, res: Response) => {
  try {
    const payer = String(req.body?.payerAccountId || '').trim();
    if (!/^\d{12}$/.test(payer)) return res.status(400).json({ error: '请提供 12 位 payer 账户 ID' });
    const aggregatorRegion = String(req.body?.aggregatorRegion || 'us-east-1').trim();
    const requestedLocalRegions: string[] = Array.isArray(req.body?.localRegions)
      ? [...new Set<string>((req.body.localRegions as unknown[])
        .map(region => String(region).trim())
        .filter(Boolean))].sort()
      : [];
    const coverage = await tagCompliance.getOrgEnabledRegions(payer);
    if (!coverage.aggregatorRegions.includes(aggregatorRegion)) {
      return res.status(400).json({ error: `聚合区域 ${aggregatorRegion} 未在 payer 与全部 ACTIVE 成员账户共同启用` });
    }
    const requiredLocalRegions = coverage.regions.filter(region => region !== aggregatorRegion).sort();
    const missing = requiredLocalRegions.filter(region => !requestedLocalRegions.includes(region));
    const unexpected = requestedLocalRegions.filter(region => !requiredLocalRegions.includes(region));
    if (missing.length > 0 || unexpected.length > 0) {
      return res.status(400).json({
        error: '索引区域必须与组织实际启用区域完全一致，请重新读取区域后再提交',
        data: { missing, unexpected, requiredLocalRegions },
      });
    }
    const payerLocalRegions = coverage.payerRegions.filter(region => region !== aggregatorRegion);
    const r = await tagCompliance.deployReIndexes(
      payer,
      aggregatorRegion,
      requiredLocalRegions,
      payerLocalRegions,
      coverage.memberEnabledRegions,
      coverage.defaultRegions,
    );
    const user = (req as any).user;
    db.addAuditLog(user?.userId, 'TAG_RE_INDEX_DEPLOY',
      `下发 RE 索引 payer ${payer} — 聚合 ${aggregatorRegion}, 本地 ${r.localRegions.length} 区域, 成员 ${coverage.memberAccountCount} 个; ${r.steps.map(s => `${s.label}:${s.status}`).join(', ')}`,
      user?.username, req.ip);
    (res.locals as any).audited = true;
    res.json({ success: true, data: r });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// 查询 RE 索引 StackSet 部署进度（供前端轮询）
awsRouter.get('/tag-compliance/re-indexes/status', async (req: Request, res: Response) => {
  try {
    const payer = String(req.query.payer || '').trim();
    if (!/^\d{12}$/.test(payer)) return res.status(400).json({ error: '请提供 12 位 payer 账户 ID' });
    res.json({ success: true, data: await tagCompliance.getReIndexStatus(payer) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// 动态读取 payer + ACTIVE 成员账户的实际启用区域，供手工索引部署使用。
awsRouter.get('/tag-compliance/enabled-regions', requireStrictAdmin, async (req: Request, res: Response) => {
  try {
    const payer = String(req.query.payer || '').trim();
    if (!/^\d{12}$/.test(payer)) return res.status(400).json({ error: '请提供 12 位 payer 账户 ID' });
    res.json({ success: true, data: await tagCompliance.getOrgEnabledRegions(payer) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// 一键接入：自动补齐该 payer 组织的前置资源（RE 跨账户访问/聚合索引/OrgView/search-role/StackSet）
awsRouter.post('/tag-compliance/provision', requireStrictAdmin, async (req: Request, res: Response) => {
  try {
    const payer = String(req.body?.payerAccountId || '').trim();
    if (!/^\d{12}$/.test(payer)) return res.status(400).json({ error: '请提供 12 位 payer 账户 ID' });
    const r = await tagCompliance.provisionOrg(payer);
    const user = (req as any).user;
    const summary = r.steps.map(s => `${s.label}:${s.status}`).join(', ');
    db.addAuditLog(user?.userId, 'TAG_ORG_PROVISION', `一键接入 MAP 标签合规 payer ${payer} — ${summary}`, user?.username, req.ip);
    (res.locals as any).audited = true;
    res.json({ success: true, data: r });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// 接入组织前置自检：给定 payer 账户，尽力探测 search-role / OrgView / StackSet / 组织信息
awsRouter.get('/tag-compliance/precheck', async (req: Request, res: Response) => {
  try {
    const payer = String(req.query.payer || '').trim();
    if (!/^\d{12}$/.test(payer)) return res.status(400).json({ error: '请提供 12 位 payer 账户 ID' });
    res.json({ success: true, data: await tagCompliance.precheckOrg(payer) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// RBAC: 根用户凭证操作权限（独立于角色，可单独分配）。用于账户"根用户"tab 的敏感功能：
// 生成 Admin 临时凭证 / 删除 Root MFA / 恢复根密码。admin 恒有；其他用户需被显式授予 root_access。
// 与 requireAuditAccess 一致，从数据库读取当前权限，避免信任 JWT 中可能过期的角色/权限。
const requireRootAccess = (req: Request, res: Response, next: any) => {
  const tokenUser = (req as any).user;
  const currentUser = tokenUser?.username ? db.getUser(tokenUser.username) : null;
  if (!currentUser
    || String(currentUser.id) !== String(tokenUser?.userId)
    || currentUser.username !== tokenUser?.username) {
    return res.status(401).json({ error: '用户身份已变更，请重新登录' });
  }
  if (currentUser.role === 'admin' || (currentUser as any).root_access === true) {
    (res.locals as any).rootAccessUser = currentUser;
    return next();
  }
  return res.status(403).json({ error: '无根用户凭证操作权限，请联系管理员分配' });
};

// Root recovery email and automatic password jobs. Reset URLs and plaintext passwords never appear in list APIs.
awsRouter.use('/root-email', createRootResetGuard(username => db.getUser(username)));
const rootEmailFailure = (res: Response, error: unknown) => {
  const status = error instanceof RootEmailError || error instanceof StepUpMfaError ? error.statusCode
    : error instanceof MailApiError ? 503 : 500;
  const message = error instanceof RootEmailError || error instanceof StepUpMfaError || error instanceof MailApiError
    ? error.message : 'Root 密码任务服务异常，请联系管理员';
  return res.status(status).json({ error: message });
};
const verifyRootEmailStepUp = (req: Request, res: Response, value: unknown) => {
  try { verifyStepUpTotp(res.locals.rootResetUser, value, req.ip); }
  catch (error) {
    const user = res.locals.rootResetUser;
    try {
      db.addAuditLog(Number(user?.id) || null, 'ROOT_PASSWORD_STEPUP_FAILED',
        `Root 密码高风险操作 MFA 验证失败 · ${req.method} ${req.path}`, user?.username, req.ip);
    } catch { console.error('[RootEmail] MFA 失败审计写入失败'); }
    throw error;
  }
};
awsRouter.post('/root-email/jobs/:id/reset-link', async (req, res) => {
  try {
    const data = await getRootResetLink(String(req.params.id), res.locals.rootResetUser);
    res.locals.audited = true;
    res.json({ success: true, data });
  } catch (error) { rootEmailFailure(res, error); }
});
awsRouter.post('/root-email/jobs/:id/manual-reset-link', async (req, res) => {
  try {
    verifyRootEmailStepUp(req, res, req.body?.totpCode);
    const data = await getManualRootResetLink(String(req.params.id), res.locals.rootResetUser, req.ip);
    res.locals.audited = true;
    res.json({ success: true, data });
  } catch (error) { rootEmailFailure(res, error); }
});
awsRouter.post('/root-email/jobs/:id/retry', async (req, res) => {
  try {
    if (req.body?.confirmRetry !== true) throw new RootEmailError('请确认重新发送恢复邮件并自动设置 Root 新密码');
    verifyRootEmailStepUp(req, res, req.body?.totpCode);
    const data = await retryRootEmailJob(String(req.params.id), res.locals.rootResetUser, req.ip);
    res.locals.audited = true;
    res.status(202).json({ success: true, data });
  } catch (error) { rootEmailFailure(res, error); }
});
awsRouter.post('/root-email/jobs/:id/manual-captcha', (req, res) => {
  try {
    const data = getRootEmailManualCaptcha(String(req.params.id), res.locals.rootResetUser);
    res.locals.audited = true;
    res.json({ success: true, data });
  } catch (error) { rootEmailFailure(res, error); }
});
awsRouter.post('/root-email/jobs/:id/manual-captcha/answer', (req, res) => {
  try {
    const data = answerRootEmailManualCaptcha(String(req.params.id), res.locals.rootResetUser, req.body || {}, req.ip);
    res.locals.audited = true;
    res.status(202).json({ success: true, data });
  } catch (error) { rootEmailFailure(res, error); }
});
awsRouter.get('/root-email/availability', async (_req, res) => {
  try { res.json({ success: true, data: await rootEmailAvailability() }); }
  catch (error) { rootEmailFailure(res, error); }
});
awsRouter.get('/root-email/catalog', (_req, res) => {
  try { res.json({ success: true, data: rootEmailCatalog() }); }
  catch (error) { rootEmailFailure(res, error); }
});
awsRouter.get('/root-email/batches', (_req, res) => {
  try { res.json({ success: true, data: listRootEmailBatches(res.locals.rootResetUser) }); }
  catch (error) { rootEmailFailure(res, error); }
});
awsRouter.get('/root-email/batches/:id', (req, res) => {
  try { res.json({ success: true, data: getRootEmailBatch(String(req.params.id), res.locals.rootResetUser) }); }
  catch (error) { rootEmailFailure(res, error); }
});
awsRouter.post('/root-email/batches', async (req, res) => {
  try {
    if (req.body?.confirmSetPassword !== true) throw new RootEmailError('请确认将自动修改所选账户的 Root 密码');
    verifyRootEmailStepUp(req, res, req.body?.totpCode);
    const result = await submitRootEmailBatch(String(req.body.payerAccountId || ''), req.body.accountIds,
      String(req.body.requestId || ''), {
        accountCount: req.body?.confirmAccountCount,
      }, res.locals.rootResetUser, req.ip);
    res.locals.audited = true;
    res.status(result.reused ? 200 : 202).json({ success: true, data: result });
  } catch (error) { rootEmailFailure(res, error); }
});
awsRouter.post('/root-email/batches/:id/credentials-csv', (req, res) => {
  try {
    const slot = req.body?.slot;
    if (slot !== 'owner' && slot !== 'admin') throw new RootEmailError('下载副本类型必须为 owner 或 admin');
    const download = prepareRootCredentialCsv(String(req.params.id), res.locals.rootResetUser,
      slot as CredentialDownloadSlot, req.ip);
    let finished = false;
    res.once('finish', () => { finished = true; download.complete(true); });
    res.once('close', () => { if (!finished) download.complete(res.headersSent); });
    res.locals.audited = true;
    res.set({
      'Cache-Control': 'no-store, max-age=0',
      Pragma: 'no-cache',
      Expires: '0',
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${download.filename}"`,
      'X-Credential-Count': String(download.count),
      'X-Credential-Slot': download.slot,
    });
    res.status(200).send(download.csv);
  } catch (error) { rootEmailFailure(res, error); }
});
awsRouter.post('/root-email/batches/:id/cancel', (req, res) => {
  try {
    res.json({ success: true, data: cancelRootEmailBatch(String(req.params.id), res.locals.rootResetUser) });
    res.locals.audited = true;
  } catch (error) { rootEmailFailure(res, error); }
});
awsRouter.get('/root-email/accounts/:accountId/jobs', (req, res) => {
  try { res.json({ success: true, data: listRootEmails(String(req.params.accountId), res.locals.rootResetUser) }); }
  catch (error) { rootEmailFailure(res, error); }
});
awsRouter.post('/root-email/accounts/:accountId/jobs', async (req, res) => {
  try {
    if (req.body?.confirmSend !== true) throw new RootEmailError('请确认向该账户的根邮箱发送恢复邮件');
    const job = await submitRootEmail(String(req.params.accountId), res.locals.rootResetUser, req.ip);
    res.locals.audited = true;
    res.status(202).json({ success: true, data: job });
  } catch (error) { rootEmailFailure(res, error); }
});
awsRouter.post('/root-email/jobs/:id/cancel', (req, res) => {
  try {
    res.json({ success: true, data: cancelRootEmail(String(req.params.id), res.locals.rootResetUser) });
    res.locals.audited = true;
  } catch (error) { rootEmailFailure(res, error); }
});

// RBAC: 批量 payer 提额权限（独立开关，必须显式授予）。
// 该功能会对整个组织所有账户批量提交提额请求，影响面大，因此与页面权限解耦，
// 且同样从数据库读取当前权限，不信任 JWT 里可能过期的角色。
const requireBulkQuotaAccess = (req: Request, res: Response, next: any) => {
  const tokenUser = (req as any).user;
  const currentUser = tokenUser?.username ? db.getUser(tokenUser.username) : null;
  if (!currentUser) return res.status(401).json({ error: '用户不存在或登录已失效' });
  if (currentUser.role === 'admin' || (currentUser as any).bulk_quota_access === true) return next();
  return res.status(403).json({ error: '无批量提额权限，请联系管理员分配' });
};

// Audit logs contain sensitive operational data. Enforce the current database
// permission instead of trusting the potentially stale role/pages in the JWT.
const requireAuditAccess = (req: Request, res: Response, next: any) => {
  const tokenUser = (req as any).user;
  const currentUser = tokenUser?.username ? db.getUser(tokenUser.username) : null;
  if (!currentUser) return res.status(401).json({ error: '用户不存在或登录已失效' });
  if (currentUser.role === 'admin') return next();

  const allowedPages = (currentUser as any).allowed_pages;
  // Backward compatibility is limited to legacy null/undefined values.
  if (allowedPages == null) return next();
  if (Array.isArray(allowedPages) && allowedPages.includes('audit')) return next();
  // Corrupt or unexpected permission values must fail closed.
  return res.status(403).json({ error: '无权访问审计日志' });
};

// 账单导出会读取多个账户的 Billing 页面，必须实时校验 billing 页面权限。
// 旧用户的 null/undefined 仍按现有兼容规则视为全部页面，异常值 fail closed。
const requireBillingAccess = (req: Request, res: Response, next: any) => {
  const tokenUser = (req as any).user;
  const currentUser = tokenUser?.username ? db.getUser(tokenUser.username) : null;
  if (!currentUser
    || String(currentUser.id) !== String(tokenUser?.userId)
    || currentUser.username !== tokenUser?.username) {
    return res.status(401).json({ error: '用户身份已变更，请重新登录' });
  }
  const allowedPages = (currentUser as any).allowed_pages;
  const allowed = currentUser.role === 'admin'
    || allowedPages == null
    || (Array.isArray(allowedPages) && allowedPages.includes('billing'));
  if (!allowed) return res.status(403).json({ error: '无权导出账单，请联系管理员分配账单页面权限' });
  (res.locals as any).billingUser = currentUser;
  next();
};

function isBillingJobOwner(user: any, job: BillingExportJob): boolean {
  if (job.createdByUserId != null) {
    return user?.id != null && String(user.id) === job.createdByUserId;
  }
  // 兼容迁移前没有稳定 owner ID 的历史记录；新任务绝不按用户名授权。
  return user?.username === job.createdBy;
}

function canAccessBillingJob(user: any, job: BillingExportJob): boolean {
  return user?.role === 'admin' || isBillingJobOwner(user, job);
}

function billingJobViewForUser(user: any, job: BillingExportJob) {
  return {
    ...toBillingExportJobView(job),
    ownedByCurrentUser: isBillingJobOwner(user, job),
  };
}

// Test connection
awsRouter.get('/connection', async (_req: Request, res: Response) => {
  try {
    const results = await aws.testConnection();
    res.json({ success: true, data: results });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// List accounts — returns cached data instantly, refreshes in background
awsRouter.get('/accounts', async (_req: Request, res: Response) => {
  try {
    const { accounts: cached, cachedAt } = db.getAccountsCache();
    
    // If cache exists and is less than 10 minutes old, return it instantly
    if (cached.length > 0) {
      res.json({ success: true, data: cached, cachedAt });
      // Refresh in background if cache is older than 5 minutes
      const age = Date.now() - new Date(cachedAt).getTime();
      if (age > 5 * 60 * 1000) {
        aws.listAccounts().then(accounts => db.setAccountsCache(accounts)).catch(() => {});
      }
      return;
    }
    
    // No cache — must fetch (first time)
    const accounts = await aws.listAccounts();
    db.setAccountsCache(accounts);
    res.json({ success: true, data: accounts });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Force refresh accounts from AWS
awsRouter.post('/accounts/refresh', async (_req: Request, res: Response) => {
  try {
    const accounts = await aws.listAccounts();
    db.setAccountsCache(accounts);
    res.json({ success: true, data: accounts });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// 账户角色自愈 —— 状态查询（仅 admin：检测结果暴露了哪些账户平台进不去，属运维信息）
awsRouter.get('/accounts/roles-status', requireStrictAdmin, async (_req: Request, res: Response) => {
  try {
    res.json({ success: true, data: getAccountRolesSummary() });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// 账户角色自愈 —— 手动触发检测/补齐
// body: { full?: boolean, accountIds?: string[], probeOnly?: boolean }
awsRouter.post('/accounts/roles-check', requireStrictAdmin, async (req: Request, res: Response) => {
  try {
    const { full, accountIds, probeOnly } = req.body || {};
    if (accountIds !== undefined && (!Array.isArray(accountIds) || accountIds.some((x: any) => typeof x !== 'string'))) {
      return res.status(400).json({ error: 'accountIds 必须是字符串数组' });
    }
    const result = await syncAccountRoles({
      full: !!full,
      accountIds: Array.isArray(accountIds) && accountIds.length ? accountIds : undefined,
      probeOnly: !!probeOnly,
    });
    // details 可能很长，只回汇总 + 有问题的明细
    res.json({
      success: true,
      data: {
        scanned: result.scanned,
        ok: result.ok,
        remediated: result.remediated,
        pending: result.pending,
        unreachable: result.unreachable,
        skippedSuspended: result.skippedSuspended,
        problems: result.details.filter(d => d.state !== 'ok'),
      },
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// 离场账户 —— 已移出组织的账户记录（用于追溯遗留数据的归属）
awsRouter.get('/accounts/departed', async (_req: Request, res: Response) => {
  try {
    res.json({ success: true, data: getDepartedSummary() });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// 离场账户 —— 手动触发补录（把有遗留数据但已不在缓存里的账户登记进来）
awsRouter.post('/accounts/departed/backfill', requireStrictAdmin, async (_req: Request, res: Response) => {
  try {
    const r = backfillDepartures();
    res.json({ success: true, data: { ...r, summary: getDepartedSummary() } });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// APN 合作伙伴账户 —— 只读目录。
// 刻意独立于 /accounts：这些账户不在任何组织里，平台只有 Partner Central
// 一条通路，混进 accounts_cache 会污染角色自愈/离场检测/批量操作。
awsRouter.get('/apn-accounts', async (_req: Request, res: Response) => {
  try {
    res.json({ success: true, data: { records: listApnAccounts(), unavailable: APN_UNAVAILABLE } });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// 按需实测连通性（会真的 AssumeRole，不放进列表接口以免拖慢账户页首屏）
awsRouter.post('/apn-accounts/probe', requireStrictAdmin, async (req: Request, res: Response) => {
  try {
    const { partnerKey } = req.body || {};
    const targets = partnerKey ? [String(partnerKey)] : listApnAccounts().map(a => a.partnerKey);
    const results = await Promise.all(targets.map(k =>
      probeApnAccount(k).catch((e: any) => ({
        partnerKey: k, accountId: '', ok: false, error: e.message,
      }))));
    res.json({ success: true, data: results });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// 敏感权限客户账户 —— 列表（不返回 ExternalId 明文）
awsRouter.get('/accounts/restricted', async (_req: Request, res: Response) => {
  try {
    const list = getRestrictedAccounts().map((r: any) => ({
      account_id: r.account_id,
      account_name: r.account_name,
      payer: r.payer,
      state: r.state,
      marked_by: r.marked_by,
      marked_at: r.marked_at,
      applied_at: r.applied_at,
      note: r.note,
      last_error: r.last_error,
      has_external_id: Boolean(r.external_id_enc),
    }));
    res.json({ success: true, data: { records: list, unavailable: RESTRICTED_UNAVAILABLE } });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// 标记为敏感权限客户并执行收窄。耗时较长（逐账户等 CloudFormation）
awsRouter.post('/accounts/restricted', requireStrictAdmin, async (req: Request, res: Response) => {
  try {
    const { accountIds, note } = req.body || {};
    if (!Array.isArray(accountIds) || accountIds.length === 0
      || accountIds.some((x: any) => typeof x !== 'string' || !/^\d{12}$/.test(x))) {
      return res.status(400).json({ error: 'accountIds 必须是 12 位账户 ID 的数组' });
    }
    const user = (req as any).user;
    const r = await markRestricted(accountIds, { markedBy: user?.username, note });
    db.addAuditLog(user?.userId, 'ACCOUNT_RESTRICT',
      `标记敏感权限客户账户: ${accountIds.join(', ')}`, user?.username, req.ip);
    (res.locals as any).audited = true;
    res.json({ success: true, data: r });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// 取消标记，恢复默认权限
awsRouter.delete('/accounts/restricted/:accountId', requireStrictAdmin, async (req: Request, res: Response) => {
  try {
    const accountId = String(req.params.accountId);
    const r = await unmarkRestricted(accountId);
    if (!r.ok) return res.status(400).json({ error: r.error });
    const user = (req as any).user;
    db.addAuditLog(user?.userId, 'ACCOUNT_UNRESTRICT',
      `取消敏感权限标记并恢复默认权限: ${accountId}`, user?.username, req.ip);
    (res.locals as any).audited = true;
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// 取某账户的 ExternalId 明文 —— 需交付给客户，仅严格 admin 且单独审计
awsRouter.get('/accounts/restricted/:accountId/external-id', requireStrictAdmin, async (req: Request, res: Response) => {
  try {
    const accountId = String(req.params.accountId);
    const v = getExternalId(accountId);
    if (!v) return res.status(404).json({ error: '该账户未标记或无 ExternalId' });
    const user = (req as any).user;
    db.addAuditLog(user?.userId, 'ACCOUNT_EXTERNALID_VIEW',
      `查看账户 ${accountId} 的 ExternalId`, user?.username, req.ip);
    (res.locals as any).audited = true;
    res.json({ success: true, data: { accountId, externalId: v } });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Account detail
awsRouter.get('/accounts/:id/detail', async (req: Request, res: Response) => {
  try {
    const detail = await aws.getAccountDetail(String(req.params.id));
    res.json({ success: true, data: detail });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// 实时运营计数（读内存 DB，轻量）：
// - roleIssues: 账户角色自愈的异常计数。刻意只返回计数不返回 problems 明细，
//   明细仍走 requireStrictAdmin 的 /accounts/roles-status，权限模型不被破坏。
// - quotaPending: 配额待达标数（Case 未关闭且当前值未到目标值）。
function getDashboardLiveCounters() {
  let roleIssues: { unreachable: number; pending: number } | undefined;
  try {
    const roles = getAccountRolesSummary();
    // 从未跑过角色检测（total=0，如新部署）时不返回该字段，前端据此隐藏整卡，
    // 避免显示误导性的「0 异常」
    if (roles.total > 0) {
      roleIssues = {
        unreachable: roles.byState['unreachable'] || 0,
        pending: (roles.byState['pending'] || 0) + (roles.byState['retrying'] || 0),
      };
    }
  } catch { /* 角色数据不可用时静默降级，不影响概览展示 */ }
  let quotaPending = 0;
  try {
    quotaPending = db.getQuotaRequests().filter((r: any) =>
      r.status !== 'CASE_CLOSED' && Number(r.current_value) < Number(r.desired_value)).length;
  } catch { /* 同上 */ }
  // 离场账户：只计当前仍处于「已离开」状态的（rejoined 的不算）
  let departed = 0;
  try { departed = getDepartedSummary().total; } catch { /* 同上 */ }
  return { roleIssues, quotaPending, departed };
}

// Dashboard summary — 仅返回不产生 AWS API 费用的实时运营计数
awsRouter.get('/dashboard/summary', (_req: Request, res: Response) => {
  res.json({ success: true, data: getDashboardLiveCounters() });
});


// Federated console sign-in URL — open a child account's console without login.
// access=support（默认，只读 support-quota 角色）| admin（专用 admin-console 角色，完整管理员权限）
awsRouter.get('/console-url/:accountId', async (req: Request, res: Response) => {
  try {
    const accountId = String(req.params.accountId);
    if (!/^\d{12}$/.test(accountId)) return res.status(400).json({ error: '无效的账户 ID' });
    const { caseId, destination, access } = req.query;
    const mode: 'auto' | 'support' | 'admin' = access === 'admin' ? 'admin' : access === 'support' ? 'support' : 'auto';

    // APN 账户走独立的 apn-console 角色（AdministratorAccess）。
    // 不能走下面的常规链路：那条链依赖 support-quota / OAAR / payer 二级跳，
    // 这两个账户一个都没有，只会得到一串 AccessDenied。
    const apnKey = apnPartnerKeyForAccount(accountId);
    if (apnKey) {
      // 该角色是完整管理员，门禁与 Admin 控制台一致
      const tokenUser = (req as any).user;
      const currentUser = tokenUser?.username ? db.getUser(tokenUser.username) : null;
      if (!currentUser) return res.status(401).json({ error: '用户不存在或登录已失效' });
      if (!(currentUser.role === 'admin' || (currentUser as any).root_access === true)) {
        return res.status(403).json({ error: '无权登录 APN 账户控制台（该角色为完整管理员），请联系管理员分配根用户权限' });
      }
      const apnDest = (destination as string) || 'https://console.aws.amazon.com/';
      const apnUrl = await getApnConsoleSigninUrl(apnKey, apnDest);
      db.addAuditLog(tokenUser?.userId, 'CONSOLE_ADMIN_LOGIN',
        `APN 账户 ${accountId}（${apnKey}）· 生成管理员控制台免登录链接`,
        tokenUser?.username, req.ip);
      (res.locals as any).audited = true;
      return res.json({ success: true, url: apnUrl });
    }

    // 安全门禁：Admin 控制台 = 完整管理员权限，等同生成 Admin 临时凭证，
    // 需具备根用户权限（admin 角色或被授予 root_access）。只读选项对所有登录用户开放。
    if (mode === 'admin') {
      const tokenUser = (req as any).user;
      const currentUser = tokenUser?.username ? db.getUser(tokenUser.username) : null;
      if (!currentUser) return res.status(401).json({ error: '用户不存在或登录已失效' });
      if (!(currentUser.role === 'admin' || (currentUser as any).root_access === true)) {
        return res.status(403).json({ error: '无权以 Admin 权限登录控制台，请联系管理员分配根用户权限' });
      }
    }

    // Default destination: Support case page (or custom)
    let dest = destination as string;
    if (!dest && caseId) {
      dest = `https://support.console.aws.amazon.com/support/home#/case/?displayId=${caseId}`;
    }
    if (!dest) {
      dest = 'https://console.aws.amazon.com/';
    }
    const url = await aws.getConsoleSigninUrl(accountId, dest, mode);

    // Admin 控制台登录属高权限操作，写审计
    if (mode === 'admin') {
      const user = (req as any).user;
      db.addAuditLog(user?.userId, 'CONSOLE_ADMIN_LOGIN', `AWS 账户 ${accountId} · 生成 Admin 控制台免登录链接`, user?.username, req.ip);
      (res.locals as any).audited = true;
    }
    res.json({ success: true, url });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Generate quota increase document (PDF)
awsRouter.post('/quotas/generate-doc', async (req: Request, res: Response) => {
  try {
    const { accountId, accountName, companyKey, serviceCode, quotaName, region, requestedValue, currentValue } = req.body;
    // 必需：quotaName + region + requestedValue，且 accountId / companyKey 至少一个
    if (!quotaName || !region || !requestedValue) {
      return res.status(400).json({ error: '缺少必要参数（quotaName / region / requestedValue）' });
    }
    if (!accountId && !companyKey) {
      return res.status(400).json({ error: '需要指定 accountId 或 companyKey' });
    }
    const pdf = await generateQuotaDoc({
      accountId, accountName, companyKey, serviceCode,
      quotaName, region, requestedValue: Number(requestedValue),
      currentValue: currentValue != null ? Number(currentValue) : undefined,
    });
    const company = companyKey || (accountId ? getCompanyForAccount(accountId)?.key : null) || 'doc';
    const filename = `${company}-${(quotaName || 'quota').replace(/[^a-zA-Z0-9]/g, '_').slice(0, 30)}-${requestedValue}-${region}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(pdf);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// 一键提交提额文档到 Support Case：生成 PDF → 联邦登录 → Reply → 传附件 → Submit。
// requireAdmin（拦 viewer）：会真实回帖到客户 Case，viewer 不可用。
awsRouter.post('/quotas/case-doc-submit', requireAdmin, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { accountId, accountName, caseId, companyKey, serviceCode, quotaName, region, requestedValue, currentValue, message } = req.body;
    if (!accountId || !caseId || !quotaName || !region || !requestedValue) {
      return res.status(400).json({ error: '缺少必要参数（accountId / caseId / quotaName / region / requestedValue）' });
    }
    const job = submitCaseDoc({
      accountId: String(accountId),
      accountName,
      caseId: String(caseId),
      companyKey,
      serviceCode,
      quotaName,
      region,
      requestedValue: Number(requestedValue),
      currentValue: currentValue != null ? Number(currentValue) : undefined,
      message,
      createdBy: user?.username || 'unknown',
    });
    db.addAuditLog(
      user?.userId,
      'CASE_DOC_SUBMIT',
      `一键提交提额文档 · 账户 ${accountId} · Case ${caseId} · ${quotaName} → ${requestedValue} (${region})`,
      user?.username,
      req.ip,
    );
    (res.locals as any).audited = true;
    res.status(202).json({ success: true, data: job });
  } catch (e: any) {
    if (e?.code === 'CASE_DOC_BUSY') return res.status(409).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// 一键提交任务状态轮询（不写审计——轮询噪音）
awsRouter.get('/quotas/case-doc-submit/:jobId', (req: Request, res: Response) => {
  const job = getCaseDocJob(String(req.params.jobId));
  if (!job) return res.status(404).json({ error: '任务不存在（服务可能已重启）' });
  (res.locals as any).audited = true;
  res.json({ success: true, data: job });
});

// Get company profile for an account (for doc generation UI)
awsRouter.get('/quotas/company/:accountId', async (req: Request, res: Response) => {
  try {
    const company = getCompanyForAccount(String(req.params.accountId));
    res.json({ success: true, data: company });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Billing PDF 后台 job：提交/状态/取消/下载均为短请求，下载产物保留固定 TTL。
awsRouter.post('/billing/export-jobs', requireBillingAccess, async (req: Request, res: Response) => {
  try {
    const user = (res.locals as any).billingUser;
    if (user.id == null) return res.status(500).json({ error: '当前用户缺少稳定 ID，无法创建账单导出任务' });
    const job = submitBillingExport({
      accountIds: req.body?.accountIds,
      months: req.body?.months,
      createdBy: user.username,
      createdByUserId: String(user.id),
    });
    try {
      db.addAuditLog(
        user.id,
        'BILLING_EXPORT_SUBMIT',
        `创建账单导出任务 ${job.id} · ${new Set(job.tasks.map(item => item.accountId)).size} 个账户 · ${job.total} 份 PDF`,
        user.username,
        req.ip,
      );
      (res.locals as any).audited = true;
    } catch (auditError: any) {
      console.error(`[BillingExport] job ${job.id} 审计写入失败:`, auditError.message);
    }
    res.status(202).json({ success: true, data: billingJobViewForUser(user, job) });
  } catch (e: any) {
    const message = e?.message || String(e);
    if (e?.code === 'BILLING_EXPORT_OWNER_ACTIVE') {
      return res.status(409).json({ error: message, activeJobId: e.activeJobId });
    }
    if (e?.code === 'BILLING_EXPORT_QUEUE_FULL') {
      res.setHeader('Retry-After', '15');
      return res.status(429).json({ error: message });
    }
    const clientError = /请选择|必须是 12 位|格式错误|超出允许范围|任务过多|不在平台缓存/.test(message);
    res.status(clientError ? 400 : 503).json({ error: message });
  }
});

// 历史任务分页列表。admin 默认查看全局；其他用户始终只返回本人记录。自动恢复显式请求 scope=mine。
awsRouter.get('/billing/export-jobs', requireBillingAccess, (req: Request, res: Response) => {
  try {
    const user = (res.locals as any).billingUser;
    const requestedScope = req.query.scope == null ? undefined : String(req.query.scope);
    if (requestedScope !== undefined && !['mine', 'all'].includes(requestedScope)) {
      return res.status(400).json({ error: 'scope 必须是 mine 或 all' });
    }
    const scope: 'mine' | 'all' = user.role === 'admin'
      ? ((requestedScope as 'mine' | 'all' | undefined) ?? 'all')
      : 'mine';
    const page = Math.max(1, Math.floor(Number(req.query.page || 1)) || 1);
    const limit = Math.max(1, Math.min(50, Math.floor(Number(req.query.limit || 20)) || 20));
    const userId = user.id == null ? '' : String(user.id);
    const result = getBillingExportJobsForUser(
      user.username,
      userId,
      user.role === 'admin',
      scope,
      (page - 1) * limit,
      limit,
    );
    const jobs = result.jobs.map(job => billingJobViewForUser(user, job));
    res.json({
      success: true,
      data: jobs,
      pagination: {
        page,
        limit: result.limit,
        total: result.total,
        totalPages: Math.ceil(result.total / result.limit),
        scope,
      },
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

awsRouter.get('/billing/export-jobs/:jobId', requireBillingAccess, (req: Request, res: Response) => {
  try {
    const user = (res.locals as any).billingUser;
    const job = getBillingExportJob(String(req.params.jobId));
    if (!job) return res.status(404).json({ error: '账单导出任务不存在或已清理' });
    if (!canAccessBillingJob(user, job)) return res.status(403).json({ error: '只能查看自己创建的账单导出任务' });
    res.json({ success: true, data: billingJobViewForUser(user, job) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

awsRouter.post('/billing/export-jobs/:jobId/cancel', requireBillingAccess, (req: Request, res: Response) => {
  try {
    const user = (res.locals as any).billingUser;
    const existing = getBillingExportJob(String(req.params.jobId));
    if (!existing) return res.status(404).json({ error: '账单导出任务不存在或已清理' });
    if (!canAccessBillingJob(user, existing)) return res.status(403).json({ error: '只能取消自己创建的账单导出任务' });
    const job = cancelBillingExport(existing.id);
    try {
      db.addAuditLog(user.id, 'BILLING_EXPORT_CANCEL', `取消账单导出任务 ${job.id}`, user.username, req.ip);
      (res.locals as any).audited = true;
    } catch (auditError: any) {
      console.error(`[BillingExport] job ${job.id} 取消审计写入失败:`, auditError.message);
    }
    res.status(job.status === 'cancelling' ? 202 : 200).json({ success: true, data: billingJobViewForUser(user, job) });
  } catch (e: any) {
    const message = e?.message || String(e);
    res.status(/已经结束|无法取消/.test(message) ? 409 : 500).json({ error: message });
  }
});

awsRouter.get('/billing/export-jobs/:jobId/download', requireBillingAccess, async (req: Request, res: Response) => {
  let download: ReturnType<typeof getBillingExportDownload> | null = null;
  try {
    const user = (res.locals as any).billingUser;
    const existing = getBillingExportJob(String(req.params.jobId));
    if (!existing) return res.status(404).json({ error: '账单导出任务不存在或已清理' });
    if (!canAccessBillingJob(user, existing)) return res.status(403).json({ error: '只能下载自己创建的账单导出文件' });
    download = getBillingExportDownload(existing.id);
    const { job, stream, fileSize } = download;
    try {
      db.addAuditLog(user.id, 'BILLING_EXPORT_DOWNLOAD_START', `开始下载账单导出任务 ${job.id} · 成功 ${job.ok} · 失败 ${job.failed}`, user.username, req.ip);
      (res.locals as any).audited = true;
    } catch (auditError: any) {
      console.error(`[BillingExport] job ${job.id} 下载开始审计写入失败:`, auditError.message);
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Length', String(fileSize));
    res.setHeader('Content-Disposition', `attachment; filename="${job.downloadFilename}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    await pipeline(stream, res);
    try {
      db.addAuditLog(user.id, 'BILLING_EXPORT_DOWNLOAD', `完成下载账单导出任务 ${job.id} · ${fileSize} bytes`, user.username, req.ip);
    } catch (auditError: any) {
      console.error(`[BillingExport] job ${job.id} 下载完成审计写入失败:`, auditError.message);
    }
  } catch (e: any) {
    const message = e?.message || String(e);
    if (res.headersSent) {
      console.error(`[BillingExport] 下载流中断 ${req.params.jobId}:`, e);
      if (!res.destroyed) res.destroy(e instanceof Error ? e : new Error(message));
      return;
    }
    const status = /已过期|已不存在|已不可用/.test(message) ? 410 : /尚未就绪/.test(message) ? 409 : 500;
    res.status(status).json({ error: message });
  } finally {
    if (download) {
      if (!download.stream.destroyed) download.stream.destroy();
      download.release();
    }
  }
});

// List all company profiles (for manual doc generation UI)
awsRouter.get('/quotas/companies', async (_req: Request, res: Response) => {
  try {
    const list = Object.values(COMPANY_PROFILES).map(c => ({
      key: c.key,
      displayName: c.displayName,
      industry: c.industry,
    }));
    // 按名字排序，便于下拉查找
    list.sort((a, b) => a.displayName.localeCompare(b.displayName));
    res.json({ success: true, data: list });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// 批量 payer 提额（独立权限 requireBulkQuotaAccess）
// 对某个 payer 自身 + 其组织下所有 ACTIVE 账户，在多个区域批量提交提额请求。
// 任务量可能很大（账户数 × 区域数），因此后台异步执行 + 前端轮询进度。
// ============================================================
interface BulkQuotaJob {
  id: string;
  createdBy?: string;
  payerAccountId: string;
  payerName: string;
  regions: string[];
  serviceCode: string;
  quotaCode: string;
  quotaName: string;
  desiredValue: number;
  scope: string;
  total: number;
  done: number;
  ok: number;
  failed: number;
  skipped: number;
  status: 'running' | 'completed' | 'error';
  error?: string;
  startedAt: string;
  finishedAt?: string;
  results: { accountId: string; accountName: string; region: string; status: 'ok' | 'failed' | 'skipped'; message?: string; requestId?: string; currentValue?: number }[];
}
const bulkQuotaJobs = new Map<string, BulkQuotaJob>();
const BULK_QUOTA_MAX_TASKS = 2000;

// 最多保留最近 20 个任务，避免内存无限增长
function pruneBulkQuotaJobs() {
  if (bulkQuotaJobs.size <= 20) return;
  const sorted = [...bulkQuotaJobs.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  for (const j of sorted.slice(0, bulkQuotaJobs.size - 20)) bulkQuotaJobs.delete(j.id);
}

// 可选的 payer 列表（只有 payer，不含成员账户）
awsRouter.get('/bulk-quota/payers', requireBulkQuotaAccess, async (_req: Request, res: Response) => {
  try {
    const payers = aws.listConfiguredPayers();
    // 用账户缓存补充 payer 账户的真实名称，便于识别
    const { accounts } = db.getAccountsCache();
    const data = payers.map(p => {
      const acct = (accounts || []).find((a: any) => a.Id === p.accountId);
      return { name: p.name, accountId: p.accountId, accountName: acct?.Name || '' };
    }).sort((a, b) => a.name.localeCompare(b.name));
    res.json({ success: true, data });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// 某 payer 组织下的 ACTIVE 账户（实时查 Organizations，不依赖缓存）
awsRouter.get('/bulk-quota/accounts/:payerAccountId', requireBulkQuotaAccess, async (req: Request, res: Response) => {
  try {
    const payerAccountId = String(req.params.payerAccountId);
    if (!/^\d{12}$/.test(payerAccountId)) return res.status(400).json({ error: '无效的 payer 账户 ID' });
    res.json({ success: true, data: await aws.listOrgAccountsForPayer(payerAccountId) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// 提交批量提额任务（QuotaCode 由服务端按配额名解析，前端只需选类型 + 填数字）
awsRouter.post('/bulk-quota/submit', requireBulkQuotaAccess, async (req: Request, res: Response) => {
  try {
    const { payerAccountId, regions, serviceCode, quotaName, desiredValue, scope } = req.body || {};
    if (!/^\d{12}$/.test(String(payerAccountId || ''))) return res.status(400).json({ error: '无效的 payer 账户 ID' });
    const regionList: string[] = Array.isArray(regions)
      ? [...new Set(regions.map((r: any) => String(r).trim()).filter((r: string) => /^[a-z]{2}(-[a-z]+)+-\d$/.test(r)))]
      : [];
    if (regionList.length === 0) return res.status(400).json({ error: '请至少选择一个区域' });
    if (!serviceCode || !quotaName) return res.status(400).json({ error: '缺少 serviceCode / quotaName' });
    const target = Number(desiredValue);
    if (!isFinite(target) || target <= 0) return res.status(400).json({ error: '期望值必须为正数' });
    const mode = scope === 'payer' ? 'payer' : scope === 'members' ? 'members' : 'all';

    // 服务端解析 QuotaCode（前端只需选配额类型 + 填数字）。
    // QuotaCode 跨账户一致，先用 payer 解析；某区域拿不到就换下一个选中的区域再试。
    let quotaCode = '';
    let resolvedName = String(quotaName);
    for (const r of regionList) {
      try {
        const hit = await aws.resolveQuotaCodeByName(String(payerAccountId), serviceCode, String(quotaName), r);
        if (hit?.quotaCode) { quotaCode = hit.quotaCode; resolvedName = hit.quotaName || resolvedName; break; }
      } catch { /* 换下一个区域再试 */ }
    }
    if (!quotaCode) {
      return res.status(400).json({ error: `在所选区域内均未找到配额「${quotaName}」（${serviceCode}），请确认该服务在这些区域可用` });
    }

    const { payerName, accounts } = await aws.listOrgAccountsForPayer(String(payerAccountId));
    const targets = accounts.filter((a: any) =>
      mode === 'all' ? true : mode === 'payer' ? a.isPayer : !a.isPayer);
    if (targets.length === 0) return res.status(400).json({ error: '按所选范围没有匹配的账户' });
    const total = targets.length * regionList.length;
    if (total > BULK_QUOTA_MAX_TASKS) {
      return res.status(400).json({ error: `任务量 ${total} 超过上限 ${BULK_QUOTA_MAX_TASKS}，请减少区域或拆分执行` });
    }

    const user = (req as any).user;
    const job: BulkQuotaJob = {
      id: `bq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdBy: user?.username,
      payerAccountId: String(payerAccountId), payerName,
      regions: regionList, serviceCode, quotaCode, quotaName: resolvedName,
      desiredValue: target, scope: mode,
      total, done: 0, ok: 0, failed: 0, skipped: 0,
      status: 'running', startedAt: new Date().toISOString(), results: [],
    };
    bulkQuotaJobs.set(job.id, job);
    pruneBulkQuotaJobs();

    db.addAuditLog(user?.userId, 'BULK_QUOTA_SUBMIT',
      `批量提额 payer ${payerName}(${payerAccountId}) | ${job.quotaName} | ${serviceCode} | 区域 ${regionList.join(',')} | 范围 ${mode} | ${targets.length} 账户 × ${regionList.length} 区域 = ${total} 请求 | 提升至 ${target}`,
      user?.username, req.ip);
    (res.locals as any).audited = true;

    // 后台执行：有界并发，逐条记录结果，失败不影响其它任务
    (async () => {
      const tasks: { account: any; region: string }[] = [];
      for (const a of targets) for (const r of regionList) tasks.push({ account: a, region: r });
      const CONCURRENCY = 5;
      let cursor = 0;
      const worker = async () => {
        while (cursor < tasks.length) {
          const idx = cursor++;
          const t = tasks[idx];
          try {
            // 先读当前值：已达到/超过目标就跳过，避免无谓地开 Support Case
            const current = await aws.getServiceQuotaValue(t.account.Id, serviceCode, quotaCode, t.region);
            if (current === null) {
              job.skipped++;
              job.results.push({ accountId: t.account.Id, accountName: t.account.Name || '', region: t.region, status: 'skipped', message: '该区域无此配额（服务可能未在此区域提供）' });
              continue;
            }
            if ((current as any).regionNotEnabled) {
              job.skipped++;
              job.results.push({ accountId: t.account.Id, accountName: t.account.Name || '', region: t.region, status: 'skipped', message: '该账户未启用此 opt-in 区域，请先在「区域管理」开通' });
              continue;
            }
            if (current.value >= target) {
              job.skipped++;
              job.results.push({ accountId: t.account.Id, accountName: t.account.Name || '', region: t.region, status: 'skipped', message: `已达标（当前 ${current.value} ≥ 目标 ${target}）`, currentValue: current.value });
              continue;
            }
            if (!current.adjustable) {
              job.skipped++;
              job.results.push({ accountId: t.account.Id, accountName: t.account.Name || '', region: t.region, status: 'skipped', message: '该配额不可调整', currentValue: current.value });
              continue;
            }
            const result = await aws.requestQuotaIncrease(t.account.Id, serviceCode, quotaCode, target, t.region);
            db.upsertQuotaRequest({
              id: (result as any)?.Id || `${t.account.Id}-${t.region}-${Date.now()}`,
              account_id: t.account.Id, service_code: serviceCode, quota_code: quotaCode,
              quota_name: job.quotaName, desired_value: target,
              current_value: current.value,
              status: (result as any)?.Status || 'PENDING', region: t.region,
              submitted_by: user?.username, case_id: (result as any)?.CaseId || null,
              created_at: new Date().toISOString(),
            });
            job.ok++;
            job.results.push({ accountId: t.account.Id, accountName: t.account.Name || '', region: t.region, status: 'ok', requestId: (result as any)?.Id, currentValue: current.value });
          } catch (e: any) {
            job.failed++;
            job.results.push({ accountId: t.account.Id, accountName: t.account.Name || '', region: t.region, status: 'failed', message: e?.name ? `${e.name}: ${e.message}` : String(e?.message || e) });
          } finally {
            job.done++;
          }
        }
      };
      try {
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, worker));
        job.status = 'completed';
      } catch (e: any) {
        job.status = 'error';
        job.error = e?.message || String(e);
      } finally {
        job.finishedAt = new Date().toISOString();
        console.log(`[BulkQuota] job ${job.id} ${job.status}: ok=${job.ok} skipped=${job.skipped} failed=${job.failed} total=${job.total}`);
      }
    })();

    res.json({ success: true, data: { jobId: job.id, total, accounts: targets.length, regions: regionList.length } });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// 查询批量提额任务进度
awsRouter.get('/bulk-quota/job/:jobId', requireBulkQuotaAccess, async (req: Request, res: Response) => {
  const job = bulkQuotaJobs.get(String(req.params.jobId));
  if (!job) return res.status(404).json({ error: '任务不存在或已过期' });
  res.json({ success: true, data: job });
});

// Bedrock 配额（TPM/RPM/TPD，多区域一键查询）
// 路径特意用 /bedrock/quotas 前缀，避免与下面的 /quotas/:accountId/:serviceCode 通配冲突
awsRouter.get('/bedrock/quotas/:accountId', async (req: Request, res: Response) => {
  try {
    const accountId = String(req.params.accountId);
    if (!/^\d{12}$/.test(accountId)) return res.status(400).json({ error: '无效的账户 ID' });
    const regions = String(req.query.regions || '')
      .split(',')
      .map(r => r.trim())
      .filter(r => /^[a-z]{2}(-[a-z]+)+-\d$/.test(r));
    const data = await aws.listBedrockQuotas(accountId, regions);
    res.json({ success: true, data });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// List quotas
awsRouter.get('/quotas/:accountId/:serviceCode', async (req: Request, res: Response) => {
  try {
    const { region } = req.query;
    const quotas = await aws.listServiceQuotas(String(req.params.accountId), String(req.params.serviceCode), region as string);
    res.json({ success: true, data: quotas });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Request quota increase
awsRouter.post('/quotas/increase', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { accountId, serviceCode, quotaCode, desiredValue, quotaName, region } = req.body;
    const targetRegion = region || aws.DEFAULT_REGION;
    const result = await aws.requestQuotaIncrease(accountId, serviceCode, quotaCode, desiredValue, targetRegion);
    const user = (req as any).user;

    db.upsertQuotaRequest({
      id: result?.Id || `${accountId}-${Date.now()}`,
      account_id: accountId, service_code: serviceCode, quota_code: quotaCode,
      quota_name: quotaName || '', desired_value: desiredValue,
      status: result?.Status || 'PENDING', region: targetRegion, submitted_by: user?.username,
      case_id: (result as any)?.CaseId || null,
      created_at: new Date().toISOString(),
    });
    db.addAuditLog(user?.userId, 'QUOTA_INCREASE', `账户 ${accountId} | ${quotaName || quotaCode} | ${serviceCode} | ${targetRegion} | 提升至 ${desiredValue}`, user?.username, req.ip);
    (res.locals as any).audited = true;

    res.json({ success: true, data: result });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Quota stats from DB (no AWS call — instant)
awsRouter.get('/quotas/stats', async (_req: Request, res: Response) => {
  try {
    const records = db.getQuotaRequests();
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const caseOpened7d = records.filter(r =>
      (r.status === 'CASE_OPENED' || r.status === 'PENDING') &&
      r.created_at && r.created_at >= sevenDaysAgo
    );
    res.json({ success: true, data: { total: records.length, caseOpened7d: caseOpened7d.length, records: caseOpened7d } });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// List quota requests (from local DB)
awsRouter.get('/quotas/requests', async (_req: Request, res: Response) => {
  try {
    const records = db.getQuotaRequests();
    res.json({ success: true, data: records });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Sync status — check if a background sync is running
let syncState = { running: false, total: 0, done: 0, startedAt: '' };

awsRouter.get('/quotas/sync-status', async (_req: Request, res: Response) => {
  res.json({ success: true, data: syncState });
});

// Sync quota requests — SSE streaming (data arrives as each account completes)
awsRouter.get('/quotas/sync-stream', async (req: Request, res: Response) => {
  // SSE headers — disable compression for streaming
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  (res as any).flush = (res as any).flush || (() => {});
  // Disable compression for this response
  (req as any).headers['accept-encoding'] = '';
  res.flushHeaders();

  try {
    const allAccounts = await aws.listAccounts();
    const accountIds = allAccounts.map((a: any) => a.Id);
    const total = accountIds.length;

    syncState = { running: true, total, done: 0, startedAt: new Date().toISOString() };
    res.write(`data: ${JSON.stringify({ type: 'start', total })}\n\n`);
    if (typeof (res as any).flush === 'function') (res as any).flush();

    // Process in batches of 15 (parallel within batch, with enrichment)
    const batchSize = 10;
    for (let i = 0; i < accountIds.length; i += batchSize) {
      const batch = accountIds.slice(i, i + batchSize);
      const results = await Promise.allSettled(batch.map(async (accountId: string) => {
        try {
          let requests = await aws.listQuotaRequests(accountId);
          // Enrich with current values
          if (requests.length > 0) {
            requests = await aws.enrichCurrentValues(accountId, requests);
          }
          for (const r of requests) {
            db.upsertQuotaRequest({
              id: r.Id,
              account_id: accountId,
              service_code: r.ServiceCode,
              quota_code: r.QuotaCode,
              quota_name: r.QuotaName,
              desired_value: r.DesiredValue,
              current_value: r._currentValue,
              status: r.Status,
              case_id: r.CaseId || null,
              region: r.QuotaArn ? r.QuotaArn.split(':')[3] : (r._region || 'us-east-1'),
              created_at: r.Created ? new Date(r.Created).toISOString() : undefined,
            });
          }
          return { accountId, count: requests.length };
        } catch { return { accountId, count: 0 }; }
      }));

      // Send progress update
      syncState.done = Math.min(i + batchSize, total);
      const batchResults = results.map(r => r.status === 'fulfilled' ? r.value : { accountId: '', count: 0 });
      res.write(`data: ${JSON.stringify({ type: 'progress', done: syncState.done, total, batch: batchResults })}\n\n`);
      if (typeof (res as any).flush === 'function') (res as any).flush();
    }

    syncState = { running: false, total, done: total, startedAt: syncState.startedAt };
    const allRecords = db.getQuotaRequests();
    res.write(`data: ${JSON.stringify({ type: 'done', total: allRecords.length })}\n\n`);
    res.end();
  } catch (e: any) {
    syncState.running = false;
    res.write(`data: ${JSON.stringify({ type: 'error', message: e.message })}\n\n`);
    res.end();
  }
});

// Legacy sync endpoint (for backward compat / small account lists)
awsRouter.post('/quotas/sync', async (req: Request, res: Response) => {
  try {
    let { accountIds } = req.body;
    
    if (!accountIds || accountIds.length === 0) {
      const allAccounts = await aws.listAccounts();
      accountIds = allAccounts.map((a: any) => a.Id);
    }

    // If large set, return DB data immediately and suggest streaming
    if (accountIds.length > 20) {
      return res.json({ success: true, data: db.getQuotaRequests(), message: 'Use /quotas/sync-stream for large sync' });
    }

    // Small set — sync directly with enrichment
    const batchSize = 5;
    for (let i = 0; i < accountIds.length; i += batchSize) {
      const batch = accountIds.slice(i, i + batchSize);
      await Promise.allSettled(batch.map(async (accountId: string) => {
        try {
          let requests = await aws.listQuotaRequests(accountId);
          if (requests.length > 0) {
            requests = await aws.enrichCurrentValues(accountId, requests);
          }
          for (const r of requests) {
            db.upsertQuotaRequest({
              id: r.Id,
              account_id: accountId,
              service_code: r.ServiceCode,
              quota_code: r.QuotaCode,
              quota_name: r.QuotaName,
              desired_value: r.DesiredValue,
              current_value: r._currentValue,
              status: r.Status,
              case_id: r.CaseId || null,
              region: r.QuotaArn ? r.QuotaArn.split(':')[3] : (r._region || 'us-east-1'),
              created_at: r.Created ? new Date(r.Created).toISOString() : undefined,
            });
          }
        } catch {}
      }));
    }

    res.json({ success: true, data: db.getQuotaRequests() });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Sync single account (quick refresh — with current value enrichment)
awsRouter.post('/quotas/sync-account/:accountId', async (req: Request, res: Response) => {
  try {
    const accountId = String(req.params.accountId);
    let requests = await aws.listQuotaRequests(accountId);
    // Enrich with current values (acceptable for single account)
    requests = await aws.enrichCurrentValues(accountId, requests);
    for (const r of requests) {
      db.upsertQuotaRequest({
        id: r.Id,
        account_id: accountId,
        service_code: r.ServiceCode,
        quota_code: r.QuotaCode,
        quota_name: r.QuotaName,
        desired_value: r.DesiredValue,
        current_value: r._currentValue,
        status: r.Status,
        case_id: r.CaseId || null,
        region: r.QuotaArn ? r.QuotaArn.split(':')[3] : (r._region || 'us-east-1'),
        created_at: r.Created ? new Date(r.Created).toISOString() : undefined,
      });
    }
    res.json({ success: true, data: db.getQuotaRequests(), synced: requests.length });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Root credentials status
// MFA / 访问密钥用 GetAccountSummary 取实时状态；密码状态与最后使用时间用凭证报告补充。
// 说明：凭证报告(Credential Report)由 AWS 缓存，最长约 4 小时才刷新，单靠它会显示过期状态
// （例如刚删的 MFA / 访问密钥仍显示存在）。GetAccountSummary 是实时的，因此优先采用。
awsRouter.get('/root-credentials/:accountId', async (req: Request, res: Response) => {
  try {
    const accountId = String(req.params.accountId);

    // 优先：AssumeRoot 审计会话直接读取真实 root 凭证（权威、实时、按具体密钥）
    try {
      const live = await (aws as any).auditRootCredentials(accountId);
      if (!live.accessKeysError) {
        const keys = live.accessKeys || [];
        return res.json({ success: true, data: {
          accountId,
          source: 'live-root',
          liveStatus: true,
          passwordEnabled: live.passwordEnabled,                                   // 可能为 null（该项无权限时）
          mfaActive: live.mfaError ? null : (live.mfaDevices || []).length > 0,
          accessKeys: keys,                                                        // [{ id, status, createDate }]
          accessKey1Active: keys.length >= 1,
          accessKey2Active: keys.length >= 2,
          accessKeysCount: keys.length,
        }});
      }
      // ListAccessKeys 被审计策略拒绝 → 落到下面的 GetAccountSummary + 凭证报告
    } catch { /* AssumeRoot 未开通/无权限 → 回退到凭证报告 */ }

    const { IAMClient, GenerateCredentialReportCommand, GetCredentialReportCommand, GetAccountSummaryCommand } = require('@aws-sdk/client-iam');
    const creds = await (aws as any).assumeToAccount(accountId);
    const iam = new IAMClient({ region: 'us-east-1', credentials: creds });

    // 实时状态：root 的 MFA 是否启用、访问密钥数量（非缓存）
    let summaryMap: any = {};
    try {
      const summary = await iam.send(new GetAccountSummaryCommand({}));
      summaryMap = summary.SummaryMap || {};
    } catch { /* 忽略，回退到凭证报告 */ }
    const mfaLive = typeof summaryMap.AccountMFAEnabled === 'number' ? summaryMap.AccountMFAEnabled > 0 : null;
    const akCount = typeof summaryMap.AccountAccessKeysPresent === 'number' ? summaryMap.AccountAccessKeysPresent : null;

    // 凭证报告：提供密码状态、最后使用时间等细节（AWS 缓存，最长约 4 小时）
    await iam.send(new GenerateCredentialReportCommand({}));
    await new Promise(r => setTimeout(r, 2000));

    let report;
    try { report = await iam.send(new GetCredentialReportCommand({})); }
    catch {
      await new Promise(r => setTimeout(r, 3000));
      report = await iam.send(new GetCredentialReportCommand({}));
    }

    const csv = Buffer.from(report.Content).toString('utf-8');
    const lines = csv.split('\n');
    const headers = lines[0].split(',');
    const rootData = lines[1]?.split(',') || [];

    const getField = (name: string) => {
      const idx = headers.indexOf(name);
      return idx >= 0 ? rootData[idx] : null;
    };

    const result = {
      accountId,
      passwordEnabled: getField('password_enabled') === 'true',
      passwordLastUsed: getField('password_last_used'),
      // MFA / 访问密钥优先用实时 GetAccountSummary，取不到再回退凭证报告
      mfaActive: mfaLive != null ? mfaLive : (getField('mfa_active') === 'true'),
      accessKey1Active: akCount != null ? akCount >= 1 : (getField('access_key_1_active') === 'true'),
      accessKey2Active: akCount != null ? akCount >= 2 : (getField('access_key_2_active') === 'true'),
      accessKey1LastUsed: getField('access_key_1_last_used_date'),
      accessKey2LastUsed: getField('access_key_2_last_used_date'),
      accessKeysCount: akCount,
      liveStatus: mfaLive != null, // MFA / 访问密钥是否为实时数据
      reportGeneratedAt: report.GeneratedTime ? new Date(report.GeneratedTime).toISOString() : null,
    };

    res.json({ success: true, data: result });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Delete root access key (requires root login — cannot be done via role)
awsRouter.post('/root-credentials/:accountId/delete-key', requireAdmin, async (req: Request, res: Response) => {
  res.status(400).json({ error: '删除根用户 Access Key 需要使用根用户登录 AWS Console 操作，无法通过 IAM Role 完成。请登录对应账户的 AWS Console 手动删除。' });
});

// Generate temporary ADMIN credentials for an account (1–12 hours) — for copy into AWS CLI / SDK.
// Any root_access user may request 1 hour; only the stable, current database admin identity may request a longer session.
awsRouter.get('/temp-credentials/:accountId', requireRootAccess, async (req: Request, res: Response) => {
  res.set({
    'Cache-Control': 'private, no-store, max-age=0',
    Pragma: 'no-cache',
  });
  try {
    const accountId = String(req.params.accountId);
    if (!/^\d{12}$/.test(accountId)) {
      return res.status(400).json({ error: '无效的账户 ID' });
    }
    const rawDuration = req.query.durationHours;
    const durationHours = rawDuration == null ? 1 : Number(rawDuration);
    if (!Number.isInteger(durationHours) || durationHours < 1 || durationHours > 12) {
      return res.status(400).json({ error: '有效期必须是 1–12 的整数小时' });
    }
    const currentUser = (res.locals as any).rootAccessUser;
    if (durationHours > 1 && currentUser.role !== 'admin') {
      return res.status(403).json({ error: '只有管理员可生成超过 1 小时的 Admin 临时凭证' });
    }

    const creds = await aws.getTempAdminCredentials(accountId, durationHours);
    db.addAuditLog(
      currentUser.id,
      'TEMP_CREDENTIALS',
      `AWS 账户 ${accountId} · 生成 Admin 临时凭证（有效期 ${creds.durationHours} 小时，到期 ${new Date(creds.expiration).toISOString()}）`,
      currentUser.username,
      req.ip,
    );
    (res.locals as any).audited = true;
    res.json({ success: true, data: creds });
  } catch (e: any) {
    const statusCode = [400, 409, 503].includes(e?.statusCode) ? e.statusCode : 500;
    res.status(statusCode).json({ error: e.message });
  }
});

// Delete member account root user MFA via centralized root access (sts:AssumeRoot).
// Highly privileged & destructive: full-admin only, always audited.
awsRouter.post('/root-credentials/:accountId/delete-mfa', requireRootAccess, async (req: Request, res: Response) => {
  try {
    const accountId = String(req.params.accountId);
    if (!/^\d{12}$/.test(accountId)) {
      return res.status(400).json({ error: '无效的账户 ID' });
    }
    const result = await aws.deleteRootMFA(accountId);
    const user = (req as any).user;
    db.addAuditLog(
      user?.userId,
      'ROOT_MFA_DELETE',
      `AWS 账户 ${accountId} · 删除根用户 MFA（${result.removed.length} 个设备）`,
      user?.username,
      req.ip,
    );
    (res.locals as any).audited = true;
    res.json({ success: true, data: result });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Allow a member account root user to recover its password via centralized root access (sts:AssumeRoot).
// Uses the IAMCreateRootUserPassword task policy and is restricted to users with root-access permission.
awsRouter.post('/root-credentials/:accountId/recover-password', requireRootAccess, async (req: Request, res: Response) => {
  try {
    const accountId = String(req.params.accountId);
    if (!/^\d{12}$/.test(accountId)) {
      return res.status(400).json({ error: '无效的账户 ID' });
    }
    const result = await aws.recoverRootPassword(accountId);
    const user = (req as any).user;
    db.addAuditLog(
      user?.userId,
      'ROOT_PASSWORD_RECOVER',
      `AWS 账户 ${accountId} · 允许恢复根用户密码（IAMCreateRootUserPassword）`,
      user?.username,
      req.ip,
    );
    (res.locals as any).audited = true;
    res.json({ success: true, data: result });
  } catch (e: any) {
    if (e?.code === 'ROOT_PASSWORD_ALREADY_EXISTS') {
      return res.status(409).json({ error: e.message });
    }
    res.status(500).json({ error: e.message });
  }
});

// Delete a member account root user access key via centralized root access (sts:AssumeRoot).
// Destructive & privileged: root-access permission only, always audited.
awsRouter.post('/root-credentials/:accountId/delete-access-key', requireRootAccess, async (req: Request, res: Response) => {
  try {
    const accountId = String(req.params.accountId);
    if (!/^\d{12}$/.test(accountId)) {
      return res.status(400).json({ error: '无效的账户 ID' });
    }
    const accessKeyId = String((req.body || {}).accessKeyId || '').trim();
    if (!/^[A-Z0-9]{16,128}$/.test(accessKeyId)) {
      return res.status(400).json({ error: '无效的 Access Key ID' });
    }
    const result = await aws.deleteRootAccessKey(accountId, accessKeyId);
    const user = (req as any).user;
    db.addAuditLog(
      user?.userId,
      'ROOT_ACCESSKEY_DELETE',
      `AWS 账户 ${accountId} · 删除根用户访问密钥 ${accessKeyId}`,
      user?.username,
      req.ip,
    );
    (res.locals as any).audited = true;
    res.json({ success: true, data: result });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

const CLEANUP_REGION_PATTERN = /^[a-z]{2}(?:-gov)?-[a-z0-9-]+-\d$/;
const DELETABLE_CLEANUP_TYPES = new Set<aws.CleanupResourceType>(['EC2', 'EBS', 'Lambda', 'IAMUser']);

function isValidCleanupResourceId(type: aws.CleanupResourceType, id: string): boolean {
  if (type === 'EC2') return /^i-[0-9a-f]{8,32}$/.test(id);
  if (type === 'EBS') return /^vol-[0-9a-f]{8,32}$/.test(id);
  if (type === 'Lambda') return /^[A-Za-z0-9-_]{1,64}$/.test(id);
  if (type === 'IAMUser') return /^[A-Za-z0-9_+=,.@-]{1,64}$/.test(id);
  return false;
}

// Scan resources created/launched in the last 7 days. IAM and S3 are global;
// regional services use the requested region. Partial service failures are returned as warnings.
awsRouter.get('/resources/:accountId/:region', async (req: Request, res: Response) => {
  try {
    const accountId = String(req.params.accountId || '').trim();
    const region = String(req.params.region || '').trim();
    if (!/^\d{12}$/.test(accountId)) return res.status(400).json({ error: '无效的账户 ID' });
    if (!CLEANUP_REGION_PATTERN.test(region)) return res.status(400).json({ error: '无效的 AWS 区域' });

    const result = await aws.scanResources(accountId, region);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ success: true, data: result });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Delete selected recent resources. EC2/EBS/Lambda retain the existing admin/partadmin
// compatibility; IAM identity deletion additionally requires a current strict-admin identity.
awsRouter.post('/resources/:accountId/delete', requireAdmin, async (req: Request, res: Response) => {
  try {
    const accountId = String(req.params.accountId || '').trim();
    if (!/^\d{12}$/.test(accountId)) return res.status(400).json({ error: '无效的账户 ID' });

    const region = typeof req.body?.region === 'string' ? req.body.region.trim() : '';
    const requestedResources = req.body?.resources;
    if (!CLEANUP_REGION_PATTERN.test(region)) return res.status(400).json({ error: '无效的 AWS 区域' });
    if (!Array.isArray(requestedResources) || requestedResources.length === 0) {
      return res.status(400).json({ error: '待删除资源列表不能为空' });
    }
    if (requestedResources.length > 100) return res.status(400).json({ error: '单次最多删除 100 个资源' });

    const resources: { type: aws.CleanupResourceType; id: string; name?: string }[] = [];
    const seen = new Set<string>();
    for (const raw of requestedResources) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return res.status(400).json({ error: '资源列表格式无效' });
      }
      const type = String(raw.type || '') as aws.CleanupResourceType;
      const id = String(raw.id || '').trim();
      if (!DELETABLE_CLEANUP_TYPES.has(type)) {
        return res.status(400).json({ error: `不支持删除资源类型 ${type || '(空)'}` });
      }
      if (!isValidCleanupResourceId(type, id)) {
        return res.status(400).json({ error: `${type} 资源 ID 格式无效` });
      }
      const key = `${type}:${id}`;
      if (seen.has(key)) return res.status(400).json({ error: `资源列表存在重复项 ${key}` });
      seen.add(key);
      const name = typeof raw.name === 'string'
        ? raw.name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 256)
        : undefined;
      resources.push({ type, id, name: name || id });
    }

    if (resources.some(resource => resource.type === 'IAMUser')) {
      const tokenUser = (req as any).user;
      const currentUser = tokenUser?.username ? db.getUser(tokenUser.username) : null;
      if (!currentUser
        || String(currentUser.id) !== String(tokenUser?.userId)
        || currentUser.username !== tokenUser?.username) {
        return res.status(401).json({ error: '用户身份已变更，请重新登录' });
      }
      if (currentUser.role !== 'admin') {
        return res.status(403).json({ error: '删除 IAM 用户仅限管理员' });
      }
    }

    const results = await aws.deleteResources(accountId, region, resources);
    const okResults = results.filter(result => result.ok);
    const failedResults = results.filter(result => !result.ok);
    const iamCleanup = okResults
      .filter(result => result.type === 'IAMUser' && result.iamCleanup)
      .map(result => {
        const summary = result.iamCleanup!;
        const dependencies = Object.values(summary).reduce((total, count) => total + count, 0);
        return `${result.id}(依赖${dependencies}项${result.alreadyAbsent ? '，用户已不存在' : ''})`;
      });
    const auditParts = [
      `AWS 账户 ${accountId} · ${region} · 最近 ${aws.CLEANUP_WINDOW_DAYS} 天资源删除 ${okResults.length}/${results.length} 成功`,
      `成功: ${okResults.slice(0, 30).map(result => `${result.type}:${result.id}`).join(', ') || '无'}`,
    ];
    if (failedResults.length > 0) {
      auditParts.push(`失败: ${failedResults.slice(0, 20).map(result => `${result.type}:${result.id}`).join(', ')}`);
    }
    if (iamCleanup.length > 0) auditParts.push(`IAM 清理: ${iamCleanup.join(', ')}`);

    const user = (req as any).user;
    db.addAuditLog(
      user?.userId,
      'RESOURCE_DELETE',
      auditParts.join('；'),
      user?.username,
      req.ip,
    );
    (res.locals as any).audited = true;
    res.setHeader('Cache-Control', 'no-store');
    res.json({ success: true, data: results });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Export full audit log (up to the 5,000 retained records)
awsRouter.get('/audit/export', requireAuditAccess, async (req: Request, res: Response) => {
  try {
    const format = String(req.query.format || 'csv').toLowerCase();
    if (format !== 'csv' && format !== 'json') {
      return res.status(400).json({ error: '仅支持 csv 或 json 格式' });
    }

    const logs = db.getAuditLog(5000);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `audit-logs-${timestamp}.${format}`;

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Export-Count', String(logs.length));
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    if (format === 'json') {
      res.type('application/json; charset=utf-8');
      return res.send(JSON.stringify({
        exported_at: new Date().toISOString(),
        total: logs.length,
        data: logs.map(enrichAuditLog),
      }, null, 2));
    }

    res.type('text/csv; charset=utf-8');
    return res.send(auditLogsToCsv(logs));
  } catch (e: any) {
    return res.status(500).json({ error: e.message || '导出审计日志失败' });
  }
});

// Audit log — returns the full retained set (up to the 5,000 record cap) by default
awsRouter.get('/audit', requireAuditAccess, async (req: Request, res: Response) => {
  try {
    const requested = Number(req.query.limit || 5000);
    const limit = Number.isFinite(requested) ? Math.min(5000, Math.max(1, Math.floor(requested))) : 5000;
    const logs = db.getAuditLog(limit).map(enrichAuditLog);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ success: true, data: logs, total: logs.length });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});
