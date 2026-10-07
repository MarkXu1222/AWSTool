import {
  db,
  createOrReuseTagOnboardingJob,
  getLatestTagOnboardingJob,
  getTagOnboardingJob,
  listActiveTagOnboardingJobs,
  recoverTagOnboardingJobs,
  retryTagOnboardingJob,
  TagOnboardingFailure,
  TagOnboardingJob,
  TagOnboardingPhase,
  TagOnboardingStep,
  TagOnboardingStepStatus,
  updateTagOnboardingJob,
} from './db';
import * as tagCompliance from './tag-compliance';

const RUNNER_INTERVAL_MS = 5_000;
const AWS_POLL_INTERVAL_MS = 15_000;
const MAX_ERROR_ATTEMPTS = 5;
const runningJobIds = new Set<string>();
const runningPayers = new Set<string>();
let runnerStarted = false;
let runnerTimer: ReturnType<typeof setInterval> | null = null;
let tickInProgress = false;

const PHASE_PROGRESS: Record<TagOnboardingPhase, number> = {
  provision_org: 5,
  wait_management_index: 20,
  deploy_re_indexes: 35,
  wait_stacksets: 55,
  upsert_org_config: 80,
  verify: 92,
  done: 100,
};

const STEP_DEFINITIONS: Array<{ key: TagOnboardingPhase; label: string }> = [
  { key: 'provision_org', label: '创建组织前置资源' },
  { key: 'wait_management_index', label: '等待管理账户聚合索引和 OrgView' },
  { key: 'deploy_re_indexes', label: '下发成员账户多区域索引' },
  { key: 'wait_stacksets', label: '等待 StackSet 覆盖全部成员账户' },
  { key: 'upsert_org_config', label: '写入 S3 组织配置' },
  { key: 'verify', label: '最终回读与前置条件校验' },
  { key: 'done', label: '接入完成' },
];

type OnboardingFailureDetails = Omit<TagOnboardingFailure, 'phase'>;

class PermanentOnboardingError extends Error {
  constructor(message: string, readonly failure?: OnboardingFailureDetails) {
    super(message);
    this.name = 'PermanentOnboardingError';
  }
}

function formatFailureMessage(failure: TagOnboardingFailure): string {
  const resolution = failure.resolutionSteps.length > 0
    ? `\n解决方案：\n${failure.resolutionSteps.map((step, index) => `${index + 1}. ${step}`).join('\n')}`
    : '';
  return `${failure.reason}${resolution}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function initialSteps(): TagOnboardingStep[] {
  const now = nowIso();
  return STEP_DEFINITIONS.map(step => ({ ...step, status: 'pending', updatedAt: now }));
}

function updateStep(
  steps: TagOnboardingStep[],
  key: TagOnboardingPhase,
  status: TagOnboardingStepStatus,
  detail?: string,
): TagOnboardingStep[] {
  const updatedAt = nowIso();
  return steps.map(step => step.key === key ? { ...step, status, detail, updatedAt } : step);
}

function completeSkippedPhases(steps: TagOnboardingStep[], phases: TagOnboardingPhase[], detail: string): TagOnboardingStep[] {
  return phases.reduce((current, phase) => updateStep(current, phase, 'completed', detail), steps);
}

function phaseTimedOut(job: TagOnboardingJob, timeoutMs: number): boolean {
  return Date.now() - new Date(job.phaseStartedAt).getTime() > timeoutMs;
}

function provisionSummary(result: tagCompliance.ProvisionResult): string {
  return result.steps.map(step => `${step.label}: ${step.status}${step.detail ? ` (${step.detail})` : ''}`).join('；');
}

function stackSetSummary(result: tagCompliance.OnboardingStackSetsStatus): string {
  return result.stackSets.map(stackSet => {
    const operation = stackSet.latestOperation?.status ? `, 操作 ${stackSet.latestOperation.status}` : '';
    const existing = stackSet.statusCounts.ACTIVE_EXISTING_INDEX ? `, 复用已有索引 ${stackSet.statusCounts.ACTIVE_EXISTING_INDEX}` : '';
    const upgrades = stackSet.indexUpgradeTargets.length ? `, 待升级聚合索引 ${stackSet.indexUpgradeTargets.length}` : '';
    const conflicts = stackSet.indexConflictTargets.length ? `, 索引冲突 ${stackSet.indexConflictTargets.length}` : '';
    return `${stackSet.name}: ${stackSet.instanceCount}/${stackSet.expectedInstanceCount}, 缺少 ${stackSet.missingInstanceCount}, 进行中 ${stackSet.pendingInstanceCount}, 失败 ${stackSet.failedInstanceCount}${existing}${upgrades}${conflicts}${operation}`;
  }).join('；');
}

function persistArtifacts(job: TagOnboardingJob, result: tagCompliance.ProvisionResult): TagOnboardingJob {
  return updateTagOnboardingJob(job.id, {
    artifacts: {
      orgId: result.orgId,
      rootOuId: result.rootOuId,
      searchRoleArn: result.searchRoleArn,
      viewArn: result.viewArn,
    },
  });
}

function advance(
  job: TagOnboardingJob,
  nextPhase: TagOnboardingPhase,
  detail: string,
  options?: { artifacts?: TagOnboardingJob['artifacts']; alsoComplete?: TagOnboardingPhase[] },
): TagOnboardingJob {
  let steps = updateStep(job.steps, job.phase, 'completed', detail);
  if (options?.alsoComplete?.length) steps = completeSkippedPhases(steps, options.alsoComplete, '无需额外等待，已就绪');
  const now = nowIso();
  return updateTagOnboardingJob(job.id, {
    status: 'queued',
    phase: nextPhase,
    progress: PHASE_PROGRESS[nextPhase],
    steps,
    artifacts: options?.artifacts,
    attempts: { ...job.attempts, [nextPhase]: 0 },
    phaseStartedAt: now,
    nextRunAt: now,
    lastError: undefined,
    failure: undefined,
  });
}

function waitForRetry(
  job: TagOnboardingJob,
  detail: string,
  delayMs = AWS_POLL_INTERVAL_MS,
): TagOnboardingJob {
  return updateTagOnboardingJob(job.id, {
    status: 'waiting_retry',
    steps: updateStep(job.steps, job.phase, 'waiting', detail),
    nextRunAt: new Date(Date.now() + delayMs).toISOString(),
    lastError: undefined,
    failure: undefined,
  });
}

function completeJob(job: TagOnboardingJob, detail: string): TagOnboardingJob {
  const now = nowIso();
  let steps = updateStep(job.steps, job.phase, 'completed', detail);
  steps = updateStep(steps, 'done', 'completed', '所有资源和 S3 配置已校验');
  return updateTagOnboardingJob(job.id, {
    status: 'completed',
    phase: 'done',
    progress: 100,
    steps,
    nextRunAt: undefined,
    lastError: undefined,
    failure: undefined,
    completedAt: now,
  });
}

function handleRunError(jobId: string, error: unknown): void {
  const current = getTagOnboardingJob(jobId);
  if (!current || current.status === 'completed') return;
  const message = error instanceof Error ? error.message : String(error);
  const phaseLabel = current.steps.find(step => step.key === current.phase)?.label || current.phase;
  const attempts = (current.attempts[current.phase] || 0) + 1;
  const permanent = error instanceof PermanentOnboardingError;
  const willRetryAutomatically = !permanent && attempts <= MAX_ERROR_ATTEMPTS;
  const failure: TagOnboardingFailure = permanent && error.failure
    ? { phase: current.phase, ...error.failure }
    : {
        code: permanent ? 'PERMANENT_ONBOARDING_ERROR' : 'AWS_API_ERROR',
        phase: current.phase,
        reason: permanent
          ? message
          : `${phaseLabel}调用 AWS 服务失败，请查看下方 AWS 原始错误。`,
        resolutionSteps: [
          '查看当前失败步骤和 AWS 原始错误，确认缺失权限、区域状态或资源状态。',
          '修复 AWS 侧问题后，返回本页面点击“从失败阶段重试”。',
        ],
        automaticRetry: willRetryAutomatically,
        manualRetryAllowed: true,
        awsMessage: permanent ? undefined : message,
      };
  const displayMessage = formatFailureMessage(failure);

  if (willRetryAutomatically) {
    const delayMs = Math.min(5 * 60_000, AWS_POLL_INTERVAL_MS * (2 ** (attempts - 1)));
    updateTagOnboardingJob(jobId, {
      status: 'waiting_retry',
      attempts: { ...current.attempts, [current.phase]: attempts },
      steps: updateStep(current.steps, current.phase, 'waiting', `第 ${attempts}/${MAX_ERROR_ATTEMPTS} 次失败，后台将自动重试。具体原因：${message}`),
      nextRunAt: new Date(Date.now() + delayMs).toISOString(),
      lastError: displayMessage,
      failure,
    });
    return;
  }

  updateTagOnboardingJob(jobId, {
    status: 'failed',
    attempts: { ...current.attempts, [current.phase]: attempts },
    steps: updateStep(current.steps, current.phase, 'failed', displayMessage),
    nextRunAt: undefined,
    lastError: displayMessage,
    failure: { ...failure, automaticRetry: false },
  });
}

async function runProvision(job: TagOnboardingJob): Promise<void> {
  const result = await tagCompliance.provisionOrg(job.payerAccountId);
  job = persistArtifacts(job, result);
  const failed = result.steps.filter(step => step.status === 'failed');
  if (failed.length > 0) throw new Error(provisionSummary(result));

  const pending = result.steps.filter(step => step.status === 'pending');
  if (result.needsRetry || pending.length > 0) {
    advance(job, 'wait_management_index', '组织信息、服务访问和基础角色已提交，等待管理账户索引生效');
  } else {
    advance(job, 'deploy_re_indexes', '组织前置资源已全部就绪', { alsoComplete: ['wait_management_index'] });
  }
}

async function runWaitManagementIndex(job: TagOnboardingJob): Promise<void> {
  const result = await tagCompliance.provisionOrg(job.payerAccountId);
  job = persistArtifacts(job, result);
  const failed = result.steps.filter(step => step.status === 'failed');
  if (failed.length > 0) throw new Error(provisionSummary(result));
  const pending = result.steps.filter(step => step.status === 'pending');
  if (result.needsRetry || pending.length > 0) {
    // 服务停机时间不应在读取 AWS 当前状态前直接导致失败；仅在确认仍 pending 后判断超时。
    if (phaseTimedOut(job, 45 * 60_000)) {
      throw new PermanentOnboardingError('管理账户 Resource Explorer 聚合索引在 45 分钟内仍未就绪');
    }
    waitForRetry(job, pending.map(step => `${step.label}: ${step.detail || 'AWS 正在处理'}`).join('；'));
    return;
  }
  advance(job, 'deploy_re_indexes', '管理账户聚合索引和 OrgView 已就绪');
}

/**
 * payer 管理账户还缺哪些区域：聚合区（必须）+ 成员账户已启用而 payer 未启用的区域。
 * StackSets 要求管理账户先启用全部目标区域，所以这些区域必须先在 payer 开通。
 */
export function findPayerMissingRegions(
  aggregatorRegion: string,
  payerEnabledRegions: string[],
  memberEnabledRegions: Record<string, string[]>,
): { regions: string[]; affectedAccountsByRegion: Record<string, string[]> } {
  const payerRegionSet = new Set(payerEnabledRegions);
  const affectedAccountsByRegion: Record<string, string[]> = {};
  for (const [accountId, regions] of Object.entries(memberEnabledRegions)) {
    for (const region of regions) {
      if (payerRegionSet.has(region)) continue;
      (affectedAccountsByRegion[region] ||= []).push(accountId);
    }
  }
  for (const accounts of Object.values(affectedAccountsByRegion)) accounts.sort();
  const regions = new Set(Object.keys(affectedAccountsByRegion));
  if (!payerRegionSet.has(aggregatorRegion)) regions.add(aggregatorRegion);
  return { regions: [...regions].sort(), affectedAccountsByRegion };
}

// 区域开通通常几分钟，偶尔更久；超时后才转为人工处理。
const PAYER_REGION_ENABLE_TIMEOUT_MS = 60 * 60_000;

async function runDeployReIndexes(job: TagOnboardingJob): Promise<void> {
  const [payerEnabledRegions, defaultRegions, memberEnabledRegions] = await Promise.all([
    tagCompliance.getEnabledRegions(job.payerAccountId),
    tagCompliance.getDefaultRegions(job.payerAccountId),
    tagCompliance.getMemberEnabledRegions(job.payerAccountId),
  ]);
  const aggregatorRegion = 'us-east-1';

  const missing = findPayerMissingRegions(aggregatorRegion, payerEnabledRegions, memberEnabledRegions);
  if (missing.regions.length > 0) {
    // 以前这里直接失败让人去控制台点；payer role/tool 有 account:EnableRegion，平台自己开通后等待生效。
    const results = await tagCompliance.enablePayerRegions(job.payerAccountId, missing.regions);
    const failed = results.filter(item => item.outcome === 'failed');
    const regionList = missing.regions.join(', ');
    if (failed.length > 0 || phaseTimedOut(job, PAYER_REGION_ENABLE_TIMEOUT_MS)) {
      const affectedAccountCount = new Set(Object.values(missing.affectedAccountsByRegion).flat()).size;
      const failedDetail = failed.map(item => `${item.region}: ${item.detail || '未知错误'}`).join('；');
      const reason = failed.length > 0
        ? `平台自动开通 payer 管理账户 ${job.payerAccountId} 的区域失败（涉及 ${affectedAccountCount} 个成员账户）：${failedDetail}`
        : `payer 管理账户 ${job.payerAccountId} 的区域在 60 分钟内仍未启用完成：${regionList}`;
      throw new PermanentOnboardingError(reason, {
        code: 'PAYER_REGIONS_NOT_ENABLED',
        reason,
        resolutionSteps: [
          `在 payer 管理账户 ${job.payerAccountId} 的 AWS Account > Regions 中确认以下区域的状态：${regionList}。`,
          '如有区域启用失败，手动启用并等待状态变为 ENABLED。',
          '返回本页面点击“从失败阶段重试”。',
        ],
        automaticRetry: false,
        manualRetryAllowed: true,
        affectedRegions: missing.regions,
        affectedAccountsByRegion: missing.affectedAccountsByRegion,
      });
    }
    const submitted = results.filter(item => item.outcome === 'submitted').map(item => item.region);
    const progress = results.map(item => `${item.region}(${item.outcome === 'submitted' ? '已提交开通' : item.outcome === 'enabled' ? '已启用，等待生效' : '启用中'})`).join(', ');
    console.log(`[MAP Onboarding] payer ${job.payerAccountId} 自动开通区域: ${progress}`);
    if (submitted.length > 0) {
      db.addAuditLog(null, 'REGION_ENABLE',
        `MAP 全自动接入自动开通 payer ${job.payerAccountId} 区域: ${submitted.join(', ')}（任务 ${job.id}）`,
        job.requestedBy || 'system');
    }
    // 开通是异步的；等 payer 真正可用后（DescribeRegions 显示 opted-in）再继续下发。
    waitForRetry(job, `正在自动开通 payer 管理账户区域，开通完成后自动继续：${progress}`, 60_000);
    return;
  }

  const memberLocalRegions = new Set<string>();
  for (const regions of Object.values(memberEnabledRegions)) {
    for (const region of regions) {
      if (region !== aggregatorRegion) memberLocalRegions.add(region);
    }
  }
  const localRegions = [...memberLocalRegions].sort();
  const payerLocalRegions = payerEnabledRegions.filter(region => region !== aggregatorRegion);
  const result = await tagCompliance.deployReIndexes(
    job.payerAccountId,
    aggregatorRegion,
    localRegions,
    payerLocalRegions,
    memberEnabledRegions,
    defaultRegions,
  );
  const failed = result.steps.filter(step => step.status === 'failed'
    || (step.key === 'payerLocalIndexes' && step.status === 'pending'));
  if (failed.length > 0) {
    throw new Error(failed.map(step => `${step.label}: ${step.detail || step.status}`).join('；'));
  }
  advance(job, 'wait_stacksets', `已按 ${Object.keys(memberEnabledRegions).length} 个成员账户的实际区域状态提交索引部署`, {
    artifacts: { aggregatorRegion, localRegions, memberEnabledRegions },
  });
}

async function runWaitStackSets(job: TagOnboardingJob): Promise<void> {
  const aggregatorRegion = job.artifacts.aggregatorRegion;
  const localRegions = job.artifacts.localRegions;
  const memberEnabledRegions = job.artifacts.memberEnabledRegions;
  if (!aggregatorRegion || !localRegions || !memberEnabledRegions) {
    throw new PermanentOnboardingError('任务缺少索引区域或成员区域矩阵，无法核验 StackSet');
  }

  const result = await tagCompliance.getOnboardingStackSetStatus(
    job.payerAccountId, aggregatorRegion, localRegions, memberEnabledRegions,
  );
  const detail = stackSetSummary(result);
  if (result.failed) throw new PermanentOnboardingError(`StackSet 配置无效或不存在：${detail}`);
  if (result.indexConflicts.length > 0) {
    // AWS 每个区域只允许一个索引，重试 StackSet 必然再次 AlreadyExists，直接给出可执行的人工步骤。
    const lines = result.indexConflicts.map(target => `${target.accountId} / ${target.region}（${target.stackSetName}）`);
    const reason = `${result.indexConflicts.length} 个成员账户×区域已有不符合要求的 Resource Explorer 索引，StackSet 无法覆盖：${lines.join('；')}`;
    throw new PermanentOnboardingError(reason, {
      code: 'EXISTING_INDEX_CONFLICT',
      reason,
      resolutionSteps: [
        '在上述账户的对应区域打开 Resource Explorer → Settings，查看已有索引的类型与状态。',
        '聚合区以外的区域若是 AGGREGATOR 索引，改为 LOCAL；索引状态异常（非 ACTIVE）的先删除后等待 StackSet 重建。',
        '处理完成后返回本页面点击“从失败阶段重试”。',
      ],
      automaticRetry: false,
      manualRetryAllowed: true,
      affectedRegions: [...new Set(result.indexConflicts.map(target => target.region))].sort(),
    });
  }
  if (!result.complete) {
    // deadline 不因 repair 重置；持续失败/缺失最多等待 90 分钟，之后进入 failed 供人工处理。
    if (phaseTimedOut(job, 90 * 60_000)) {
      throw new PermanentOnboardingError(`Resource Explorer / AutoTaggerRole StackSet 在 90 分钟内仍未完成：${detail}`);
    }
    const repair = await tagCompliance.repairOnboardingStackSetCoverage(
      job.payerAccountId, aggregatorRegion, localRegions, memberEnabledRegions, result,
    );
    waitForRetry(job, `${repair.detail}；${detail}`);
    return;
  }
  advance(job, 'upsert_org_config', `全部 ${result.memberAccountCount} 个 ACTIVE 成员账户的目标区域实例已完成`);
}

async function runUpsertConfig(job: TagOnboardingJob): Promise<void> {
  const { orgId, searchRoleArn, viewArn } = job.artifacts;
  if (!orgId || !searchRoleArn || !viewArn) {
    throw new PermanentOnboardingError('任务缺少 orgId、searchRoleArn 或 viewArn，不能写入 S3 配置');
  }
  const result = await tagCompliance.upsertOrgConfig({
    payerAccountId: job.payerAccountId,
    orgId,
    searchRoleArn,
    viewArn,
    tagValue: job.tagValue,
    // 没填额外标签时传 undefined（而非空串），让 upsert 保留该组织
    // 已有的配置，不要被一次重跑抹掉
    extraTagKey: job.extraTagKey || undefined,
    extraTagValue: job.extraTagValue || undefined,
  });
  const extraNote = job.extraTagKey
    ? `，额外标签 ${job.extraTagKey}=${job.extraTagValue}` : '';
  advance(job, 'verify',
    `${result.created ? '新增' : '更新'}组织 ${orgId}${extraNote}，S3 回读成功`);
}

async function runVerify(job: TagOnboardingJob): Promise<void> {
  const { orgId, searchRoleArn, viewArn, aggregatorRegion, localRegions, memberEnabledRegions } = job.artifacts;
  if (!orgId || !searchRoleArn || !viewArn || !aggregatorRegion || !localRegions || !memberEnabledRegions) {
    throw new PermanentOnboardingError('任务产物不完整，无法执行最终校验');
  }

  const [precheck, orgs, stackSets] = await Promise.all([
    tagCompliance.precheckOrg(job.payerAccountId),
    tagCompliance.getOrgsConfig(),
    tagCompliance.getOnboardingStackSetStatus(
      job.payerAccountId, aggregatorRegion, localRegions, memberEnabledRegions,
    ),
  ]);
  const org = orgs.find(item => item?.org_id === orgId);
  const configValid = org
    && org.search_role_arn === searchRoleArn
    && org.view_arn === viewArn
    && org.tag_value === job.tagValue
    // 额外标签也要核对，否则写失败时任务照样报成功
    && (org.extra_tag_key || '') === (job.extraTagKey || '')
    && (org.extra_tag_value || '') === (job.extraTagValue || '');
  const checksValid = precheck.reachable
    && precheck.orgId === orgId
    && precheck.checks.searchRole?.status === 'ok'
    && precheck.checks.orgView?.status === 'ok'
    && precheck.checks.stackSet?.status === 'ok';

  if (stackSets.failed) throw new PermanentOnboardingError(`最终校验发现 StackSet 配置无效：${stackSetSummary(stackSets)}`);
  if (!stackSets.complete || !configValid || !checksValid) {
    if (phaseTimedOut(job, 20 * 60_000)) {
      throw new PermanentOnboardingError('最终回读检查后仍未通过，且已超过 20 分钟');
    }
    waitForRetry(job, [
      `StackSet: ${stackSets.complete ? '完成' : '等待'}`,
      `S3 配置: ${configValid ? '通过' : '未通过'}`,
      `前置资源: ${checksValid ? '通过' : '未通过'}`,
    ].join('；'));
    return;
  }
  completeJob(job, `组织 ${orgId} 已完成前置资源、索引覆盖和 S3 配置校验`);
}

async function runJob(jobId: string): Promise<void> {
  let job = getTagOnboardingJob(jobId);
  if (!job || !['queued', 'waiting_retry'].includes(job.status)) return;
  job = updateTagOnboardingJob(job.id, {
    status: 'running',
    progress: PHASE_PROGRESS[job.phase],
    steps: updateStep(job.steps, job.phase, 'running', '后台处理中'),
    nextRunAt: undefined,
    lastError: undefined,
    failure: undefined,
  });

  try {
    switch (job.phase) {
      case 'provision_org': await runProvision(job); break;
      case 'wait_management_index': await runWaitManagementIndex(job); break;
      case 'deploy_re_indexes': await runDeployReIndexes(job); break;
      case 'wait_stacksets': await runWaitStackSets(job); break;
      case 'upsert_org_config': await runUpsertConfig(job); break;
      case 'verify': await runVerify(job); break;
      case 'done':
        if (job.status !== 'completed') completeJob(job, '任务已完成');
        break;
    }
  } catch (error) {
    handleRunError(job.id, error);
  }
}

async function tick(): Promise<void> {
  if (tickInProgress) return;
  tickInProgress = true;
  try {
    const now = Date.now();
    for (const job of listActiveTagOnboardingJobs()) {
      if (job.status === 'running') continue;
      if (job.nextRunAt && new Date(job.nextRunAt).getTime() > now) continue;
      if (runningJobIds.has(job.id) || runningPayers.has(job.payerAccountId)) continue;
      runningJobIds.add(job.id);
      runningPayers.add(job.payerAccountId);
      void runJob(job.id).finally(() => {
        runningJobIds.delete(job.id);
        runningPayers.delete(job.payerAccountId);
      });
    }
  } finally {
    tickInProgress = false;
  }
}

function wakeRunner(): void {
  if (runnerStarted) void tick();
}

export function startTagOnboardingRunner(): void {
  if (runnerStarted) return;
  runnerStarted = true;
  const recovered = recoverTagOnboardingJobs();
  if (recovered > 0) console.log(`[MAP Onboarding] 已恢复 ${recovered} 个中断任务`);
  void tick();
  runnerTimer = setInterval(() => void tick(), RUNNER_INTERVAL_MS);
  runnerTimer.unref?.();
}

export function submitTagOnboarding(input: {
  payerAccountId: string;
  tagValue: string;
  /** 额外自定义标签（可选），两者要么都给要么都不给 */
  extraTagKey?: string;
  extraTagValue?: string;
  requestedBy?: string;
}): { job: TagOnboardingJob; reused: boolean } {
  const payerAccountId = String(input.payerAccountId || '').trim();
  const tagValue = String(input.tagValue || '').trim();
  const extraTagKey = String(input.extraTagKey || '').trim();
  const extraTagValue = String(input.extraTagValue || '').trim();
  if (!/^\d{12}$/.test(payerAccountId)) throw new Error('请提供 12 位 payer 账户 ID');
  if (!tagValue) throw new Error('tag_value 必填');
  if (tagValue.length > 256) throw new Error('tag_value 不能超过 256 个字符');
  // 只填一半会让用户以为配好了，实际打不出标签 —— 提前拦住而不是到
  // upsert 阶段才失败（那时任务已经跑了十几分钟）
  if (!!extraTagKey !== !!extraTagValue) {
    throw new Error('额外标签的 key 与 value 必须同时填写或同时留空');
  }
  if (extraTagKey.toLowerCase() === tagCompliance.MAP_TAG_KEY) {
    throw new Error(
      `额外标签的 key 不能是 ${tagCompliance.MAP_TAG_KEY}，它由 tag_value 单独控制`);
  }
  if (!tagCompliance.isConfigured()) throw new Error('MAP Tag 合规功能尚未配置');

  const result = createOrReuseTagOnboardingJob({
    payerAccountId,
    tagValue,
    extraTagKey: extraTagKey || undefined,
    extraTagValue: extraTagValue || undefined,
    requestedBy: input.requestedBy,
    steps: initialSteps(),
  });
  wakeRunner();
  return result;
}

export function retryOnboarding(jobId: string): TagOnboardingJob {
  const job = retryTagOnboardingJob(jobId);
  wakeRunner();
  return job;
}

export { getTagOnboardingJob, getLatestTagOnboardingJob };
