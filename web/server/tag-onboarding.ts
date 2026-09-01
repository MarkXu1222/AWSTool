import {
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
    return `${stackSet.name}: ${stackSet.instanceCount}/${stackSet.expectedInstanceCount}, 缺少 ${stackSet.missingInstanceCount}, 进行中 ${stackSet.pendingInstanceCount}, 失败 ${stackSet.failedInstanceCount}${operation}`;
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

async function runDeployReIndexes(job: TagOnboardingJob): Promise<void> {
  const [payerEnabledRegions, defaultRegions, memberEnabledRegions] = await Promise.all([
    tagCompliance.getEnabledRegions(job.payerAccountId),
    tagCompliance.getDefaultRegions(job.payerAccountId),
    tagCompliance.getMemberEnabledRegions(job.payerAccountId),
  ]);
  const aggregatorRegion = 'us-east-1';
  if (!payerEnabledRegions.includes(aggregatorRegion)) {
    const reason = `payer 管理账户 ${job.payerAccountId} 未启用聚合区域 ${aggregatorRegion}，无法创建 Resource Explorer 聚合索引。`;
    throw new PermanentOnboardingError(reason, {
      code: 'AGGREGATOR_REGION_NOT_ENABLED',
      reason,
      resolutionSteps: [
        `在 payer 管理账户中启用 ${aggregatorRegion}。`,
        '等待区域状态变为 ENABLED 后，返回本页面点击“从失败阶段重试”。',
      ],
      automaticRetry: false,
      manualRetryAllowed: true,
      affectedRegions: [aggregatorRegion],
    });
  }

  const payerRegionSet = new Set(payerEnabledRegions);
  const affectedAccountsByRegion: Record<string, string[]> = {};
  for (const [accountId, regions] of Object.entries(memberEnabledRegions)) {
    for (const region of regions) {
      if (payerRegionSet.has(region)) continue;
      (affectedAccountsByRegion[region] ||= []).push(accountId);
    }
  }
  const memberOnlyRegions = Object.keys(affectedAccountsByRegion).sort();
  if (memberOnlyRegions.length > 0) {
    for (const accounts of Object.values(affectedAccountsByRegion)) accounts.sort();
    const affectedAccountCount = new Set(Object.values(affectedAccountsByRegion).flat()).size;
    const regionList = memberOnlyRegions.join(', ');
    const reason = `检测到 ${memberOnlyRegions.length} 个成员区域尚未在 payer 管理账户启用（涉及 ${affectedAccountCount} 个成员账户）：${regionList}。CloudFormation StackSets 要求管理账户先启用所有目标区域，因此无法下发 Resource Explorer 索引。`;
    throw new PermanentOnboardingError(reason, {
      code: 'PAYER_REGIONS_NOT_ENABLED',
      reason,
      resolutionSteps: [
        `在 payer 管理账户 ${job.payerAccountId} 的 AWS Account > Regions 中启用：${regionList}。`,
        '等待所有区域状态从 ENABLING 变为 ENABLED；区域尚在启用中时不要重试。',
        '返回本页面点击“从失败阶段重试”，系统会重新扫描区域并继续补齐 StackSet。',
      ],
      automaticRetry: false,
      manualRetryAllowed: true,
      affectedRegions: memberOnlyRegions,
      affectedAccountsByRegion,
    });
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
  });
  advance(job, 'verify', `${result.created ? '新增' : '更新'}组织 ${orgId}，S3 回读成功`);
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
    && org.tag_value === job.tagValue;
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
  requestedBy?: string;
}): { job: TagOnboardingJob; reused: boolean } {
  const payerAccountId = String(input.payerAccountId || '').trim();
  const tagValue = String(input.tagValue || '').trim();
  if (!/^\d{12}$/.test(payerAccountId)) throw new Error('请提供 12 位 payer 账户 ID');
  if (!tagValue) throw new Error('tag_value 必填');
  if (tagValue.length > 256) throw new Error('tag_value 不能超过 256 个字符');
  if (!tagCompliance.isConfigured()) throw new Error('MAP Tag 合规功能尚未配置');

  const result = createOrReuseTagOnboardingJob({
    payerAccountId,
    tagValue,
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
