/**
 * POC Cash —— 商机创建与提交。
 *
 * admin-only（菜单与后端双重拦截）。这里创建的是**真实商机**并提交给
 * AWS 审核，不是草稿，所以提交前有二次确认。
 *
 * 金额联动（docs/poc-cash-guide.md 第 4 节，81 条实操记录 100% 吻合）：
 *   ARR = MRR × 12 ；POC 可申请 = ARR / 10
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Card, Form, Input, InputNumber, Select, Button, Space, Radio, Alert,
  Descriptions, Typography, Divider, message, Modal, Tag, DatePicker, Result, Tabs,
  Table, Tooltip,
} from 'antd';
import { RocketOutlined, CopyOutlined, DownloadOutlined } from '@ant-design/icons';
import dayjs, { Dayjs } from 'dayjs';
import { api } from '../api';

const { TextArea } = Input;
const { Text, Paragraph } = Typography;

interface Meta {
  configured: boolean;
  partners: {
    key: string; label: string;
    apnAccountId: string;
    requiredTags: string[];
    /** 该主体是否配了跨账户 role；false 时前端置灰不可选 */
    configured?: boolean;
    /** 该主体是否配了 POC 发票信息；false 时 POC 表单禁用 */
    fundingEnabled?: boolean;
    fundingInvoiceEntity?: string | null;
  }[];
  useCases: string[];
  industries: string[];
  stages?: string[];
  closedLost?: string;
}
interface Solution { id: string; name: string; category: string; status: string }
interface CreateResult {
  opportunityId: string; arn?: string; title: string;
  stage?: string; reviewStatus?: string;
  solutionId?: string; solutionAssociated: boolean;
  submitted: boolean; engagementId?: string; taskStatus?: string;
  amounts: { mrrUsd: number; arrUsd: number; pocUsd: number };
  warnings: string[];
}

const MYR_RATE = 4.27;   // 实测 114 条记录，USD→MYR 比值集中在 4.24~4.36
const HOURLY_MYR = 339;  // 标准人时单价
const POC_CAP_USD = 9900; // 实测上限，114 条无一超过

interface OppBrief {
  id: string; companyName: string; industry?: string;
  stage?: string; reviewStatus?: string; createdDate?: string; mrrUsd?: number;
}

interface StageStatus {
  id: string; title?: string; companyName: string;
  stage?: string; reviewStatus?: string;
  targetCloseDate?: string; lastModifiedDate?: string;
  mrrUsd?: number; solutionIds: string[];
  editable: boolean; reason: string;
  nextStage: string | null; readyForPoc: boolean;
  /** Pending Submission 时为 true —— 显示「提交给 AWS 审核」按钮 */
  submittable?: boolean;
  amounts?: { mrrUsd: number; arrUsd: number; pocUsd: number };
}

interface PocRow {
  applicationId: string; name?: string;
  status?: string; stage?: string;
  opportunityId?: string; awsAccountId?: string; bucket?: string | null;
  activityName?: string; startDate?: string; endDate?: string;
  arrUsd?: string; calculatorUrl?: string;
  requestMyr?: number | null;
  purchaseOrder?: string | null;
  /** AWS 批准金额（审批后回填，不等于到账） */
  approvedAmount?: string | null; approvedCurrency?: string | null;
  /** true = AWS 未回填 ApprovedAmount，按已批准件的申请额展示 */
  approvedFromRequest?: boolean;
  createdAt?: string;
  /** 名下的 Cash Claim；null = 请款状态查询失败 */
  claims?: ClaimInfo[] | null;
  /** 端到端进度（预批 → 请款 → 付款） */
  progress?: { phase: string; label: string; detail?: string; done: boolean };
  claimDeadline?: string | null;
}

interface ClaimInfo {
  applicationId: string; status?: string; stage?: string;
  claimAmount: string | null; claimCurrency: string | null;
  invoiceRef: string | null; scheduledPaymentDate: string | null;
  disbursed?: boolean | null;
}

/** 金额与 Partner Central 控制台一致：直接截掉小数（38133.58 → 38,133） */
const consoleAmount = (v: string | number | null | undefined) => {
  const n = Number(v);
  return v === null || v === undefined || v === '' || !Number.isFinite(n)
    ? null : Math.trunc(n).toLocaleString('en-US');
};

/** 端到端进度 → 颜色。只有付款完成才算绿色 */
const PHASE_COLOR: Record<string, string> = {
  completed: 'success',
  fund_draft: 'default', claim_draft: 'default', claim_todo: 'warning',
  fund_review: 'processing', claim_review: 'processing', payment_pending: 'cyan',
  fund_action: 'warning', claim_action: 'warning', claim_unknown: 'default',
  fund_rejected: 'error', claim_rejected: 'error', canceled: 'default',
};

/** 进度筛选分组 */
const PHASE_GROUPS: { text: string; value: string; phases: string[] }[] = [
  { text: '预批中', value: 'fund', phases: ['fund_draft', 'fund_review', 'fund_action'] },
  { text: '待请款', value: 'claim_todo', phases: ['claim_todo', 'claim_unknown'] },
  { text: '请款中', value: 'claim', phases: ['claim_draft', 'claim_review', 'claim_action', 'claim_rejected'] },
  { text: '待付款', value: 'payment', phases: ['payment_pending'] },
  { text: '已完成', value: 'done', phases: ['completed'] },
  { text: '已取消/被拒', value: 'closed', phases: ['canceled', 'fund_rejected'] },
];

const CLAIM_STATUS_LABEL: Record<string, string> = {
  PENDING_SUBMISSION: '待提交', IN_REVIEW: '审核中', ACTION_REQUIRED: '需补充',
  APPROVED: '已批准', REJECTED: '已拒绝', CANCELED: '已取消',
};

/** POC 申请状态 → 颜色。只有 APPROVED 是终态成功。 */
const pocColor = (s?: string) =>
  s === 'APPROVED' ? 'success'
    : s === 'REJECTED' ? 'error'
      : s === 'ACTION_REQUIRED' ? 'warning'
        : s === 'PENDING_SUBMISSION' ? 'default'
          : s === 'CANCELED' ? 'default' : 'processing';

const POC_LABEL: Record<string, string> = {
  PENDING_SUBMISSION: '待提交', IN_REVIEW: '审核中',
  ACTION_REQUIRED: '需补充', APPROVED: '已批准',
  REJECTED: '已拒绝', CANCELED: '已取消',
};

/** 审核状态 → 展示颜色。Approved 才是真正可以继续操作的状态。 */
const reviewColor = (s?: string) =>
  s === 'Approved' ? 'success'
    : s === 'Rejected' ? 'error'
      : s === 'Action Required' ? 'warning'
        : s === 'Pending Submission' ? 'default' : 'processing';

const PocCashPage: React.FC = () => {
  const [form] = Form.useForm();
  const [meta, setMeta] = useState<Meta | null>(null);
  const [solutions, setSolutions] = useState<Solution[]>([]);
  const [solutionsState, setSolutionsState] = useState<'loading' | 'ok' | 'error'>('loading');
  const [solutionDefault, setSolutionDefault] = useState<string | null>(null);
  // 异步回调（套用模板）要读最新的 Solution 状态，不能用点击那一刻闭包里的旧值
  const solutionsInfoRef = useRef({ state: solutionsState, list: solutions, def: solutionDefault });
  solutionsInfoRef.current = { state: solutionsState, list: solutions, def: solutionDefault };
  // 参考已有商机
  const [opps, setOpps] = useState<OppBrief[]>([]);
  const [oppsLoading, setOppsLoading] = useState(false);
  const [refFrom, setRefFrom] = useState<string | null>(null);
  const [titleMode, setTitleMode] = useState<'auto' | 'manual'>('auto');
  const [autoTitle, setAutoTitle] = useState('');
  const [mrr, setMrr] = useState<number | null>(null);
  const [people, setPeople] = useState(2);
  const [days, setDays] = useState(5);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<CreateResult | null>(null);
  // 阶段检查
  const [tab, setTab] = useState('create');
  const [checkId, setCheckId] = useState('');
  const [stageInfo, setStageInfo] = useState<StageStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [advancing, setAdvancing] = useState(false);
  /** 补提交（Pending Submission → Submitted）进行中 */
  const [submittingOpp, setSubmittingOpp] = useState(false);
  /**
   * 当前生效的 APN 主体，全页面共享。
   *
   * 不能只靠创建表单里的 partnerKey 字段 —— 「阶段检查」等 Tab 不在那个
   * Form 里，只读表单字段会在切 Tab 后拿到 undefined，请求便悄悄落到
   * 默认主体（webby）上，查别的主体的商机会一律报「找不到」。
   */
  const [activePartner, setActivePartner] = useState<string>('');
  /** 异步回调里读「当前」主体，用来丢弃切换前发出的请求的响应 */
  const activePartnerRef = useRef('');
  // POC 资金申请
  const [pocForm] = Form.useForm();
  const [pocPreview, setPocPreview] = useState<any>(null);
  const [pocBucket, setPocBucket] = useState<string | null>(null);
  const [pocAcctErr, setPocAcctErr] = useState('');
  const [pocBusy, setPocBusy] = useState(false);
  const [pocResult, setPocResult] = useState<any>(null);
  const [pocRows, setPocRows] = useState<PocRow[]>([]);
  const [pocLoading, setPocLoading] = useState(false);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    api.pocCashMeta().then((m: Meta) => {
      setMeta(m);
      // 默认选第一个「已配置」的主体；全都没配则退回第一个，
      // 让页面照常渲染并由 configured 提示去引导排错
      const first = m.partners.find(p => p.configured !== false) || m.partners[0];
      if (first) {
        form.setFieldValue('partnerKey', first.key);
        setActivePartner(first.key);
      }
    }).catch((e: any) => message.error(e.message || '加载失败'));
  }, []);

  /**
   * 切换主体后重新拉取该主体账户下的数据。
   *
   * Solutions 与商机列表都是**按 APN 账户隔离**的，不重拉会让
   * Mergebytes 的表单里列出 Webby 的 Solution / 商机，选中即出错。
   */
  useEffect(() => {
    // 凭证未配置或没有可用主体时不会去查，Solution 区按「查询失败」展示，别一直显示加载中
    if (meta && (!meta.configured || !activePartner)) setSolutionsState('error');
    if (!meta?.configured || !activePartner) return;
    let stale = false;   // 快速切换时丢弃过期响应，避免回填错主体的数据

    // 旧主体选中的 Solution 不属于新主体，清掉；新列表到了再预选
    setSolutions([]); setSolutionDefault(null); setSolutionsState('loading');
    form.setFieldValue('solutionId', undefined);
    form.setFields([{ name: 'solutionId', errors: [] }]);
    api.pocCashSolutions(activePartner)
      .then((r: any) => {
        if (stale) return;
        // request() 对非 2xx 不抛错，{ error } 会被 resolve 回来
        if (r?.error || !Array.isArray(r?.solutions)) { setSolutionsState('error'); return; }
        const list: Solution[] = r.solutions;
        const def: string | null = r.defaultSolutionId ?? null;
        setSolutions(list); setSolutionDefault(def); setSolutionsState('ok');
        // 已选的（例如套用模板带来的）仍在列表里就保留，否则换成默认值
        const cur = form.getFieldValue('solutionId');
        if (!cur || !list.some(s => s.id === cur)) form.setFieldValue('solutionId', def ?? undefined);
        // 必选规则随列表变化，清掉切换前残留的「请选择」报错
        form.setFields([{ name: 'solutionId', errors: [] }]);
      })
      .catch(() => { if (!stale) setSolutionsState('error'); });

    setOppsLoading(true);
    setOpps([]);
    api.pocCashOpportunities(undefined, activePartner)
      .then((r: any) => { if (!stale) setOpps(r.opportunities || []); })
      .catch(() => { /* 同上 */ })
      .finally(() => { if (!stale) setOppsLoading(false); });

    return () => { stale = true; };
  }, [meta?.configured, activePartner]);

  /**
   * 套用已有商机作为模板。
   *
   * 复用客户资料、Marketing 字段和 Solution。新项目的标题、Use Case 和业务描述都要重新填写，
   * 否则旧项目的内容会与新标题不一致。
   */
  const applyTemplate = async (id: string) => {
    const requested = activePartner;
    try {
      const t = await api.pocCashTemplate(id, requested);
      // 等待期间切了主体：模板属于旧主体，丢弃
      if (activePartnerRef.current !== requested) return;
      const sol = solutionsInfoRef.current;
      form.setFieldsValue({
        companyName: t.companyName,
        industry: t.industry,
        websiteUrl: t.websiteUrl,
        countryCode: t.countryCode,
        postalCode: t.postalCode,
        projectName: undefined,
        titleOverride: undefined,
        customerUseCase: undefined,
        customerBusinessProblem: undefined,
        mrrUsd: undefined,
        marketingSource: t.marketingSource === 'Marketing Activity'
          ? 'Marketing Activity' : 'None',
        marketingAwsFundingUsed: t.marketingAwsFundingUsed === 'Yes' ? 'Yes' : 'No',
        solutionId: sol.state === 'ok'
          ? (t.solutionIds?.find((sid: string) => sol.list.some(s => s.id === sid))
            ?? sol.def ?? undefined)
          : t.solutionIds?.[0],
      });
      setRefFrom(id);
      setTitleMode('auto');
      setMrr(null);
      setAutoTitle('');
      message.success(`已套用 ${id} 的客户信息${t.title ? `（原标题：${t.title}）` : ''}`);
    } catch (e: any) {
      message.error(e.message || '读取模板失败');
    }
  };

  // 标题预览：自动模式下随客户名/项目名实时更新（防抖，避免每次按键都打后端）
  // 公司名被服务端修正成权威写法时的提示（null = 未修正）
  const [companyFix, setCompanyFix] = useState<{ from: string; to: string } | null>(null);
  const companyName = Form.useWatch('companyName', form);
  const projectName = Form.useWatch('projectName', form);
  const partnerKey = Form.useWatch('partnerKey', form);
  // 控制 AwsFundingUsed 的显隐：它只在 Source='Marketing Activity' 时有效
  const marketingSource = Form.useWatch('marketingSource', form);
  useEffect(() => {
    if (titleMode !== 'auto' || !partnerKey || !companyName || !projectName) {
      setAutoTitle('');
      return;
    }
    const t = setTimeout(() => {
      api.pocCashPreviewTitle({ partnerKey, companyName, projectName })
        .then((r: any) => {
          setAutoTitle(r.title);
          // 公司名被收敛成权威写法时提前告知 —— 商机一旦 Approved，
          // 公司名和标题都改不了，必须在提交前就让人看见
          setCompanyFix(r.companyNameCorrected
            ? { from: r.originalCompanyName, to: r.companyName } : null);
        })
        .catch(() => { setAutoTitle(''); setCompanyFix(null); });
    }, 250);
    return () => clearTimeout(t);
  }, [titleMode, partnerKey, companyName, projectName]);

  // 所有金额由 MRR 单向推导，避免手工换算出错
  const amounts = useMemo(() => {
    if (!mrr || mrr <= 0) return null;
    const arr = mrr * 12;
    const poc = Math.round(arr / 10);
    const requestMyr = poc * MYR_RATE;
    const totalMyr = HOURLY_MYR * 8 * people * days;
    const partnerMyr = totalMyr - requestMyr;
    return {
      arr, poc, requestMyr, totalMyr, partnerMyr,
      partnerPct: totalMyr > 0 ? (partnerMyr / totalMyr) * 100 : 0,
    };
  }, [mrr, people, days]);

  const doSubmit = async (values: any) => {
    const willSubmit = values.submit !== false;
    const payload = {
      ...values,
      targetCloseDate: (values.targetCloseDate as Dayjs).format('YYYY-MM-DD'),
      titleOverride: titleMode === 'manual' ? values.titleOverride : undefined,
    };
    let preview: { title: string; companyName: string };
    try {
      preview = await api.pocCashPreviewTitle({
        partnerKey: values.partnerKey,
        companyName: values.companyName,
        projectName: values.projectName || '',
        titleOverride: payload.titleOverride,
      });
      if ((preview as any)?.error || !preview?.title) {
        throw new Error((preview as any)?.error || '无法预览最终商机标题');
      }
    } catch (e: any) {
      message.error(e.message || '标题预览失败');
      return;
    }

    Modal.confirm({
      title: '确认创建商机？',
      width: 580,
      content: (
        <div style={{ lineHeight: 1.9 }}>
          <Text strong>{preview.title}</Text>
          <div style={{ marginTop: 8 }}>客户：{preview.companyName || values.companyName}</div>
          <div>Solution：{values.solutionId
            ? `${values.solutionId}${(() => {
              const s = solutions.find(x => x.id === values.solutionId);
              return s ? ` — ${s.name}` : '';
            })()}`
            // 列表没加载成功时留空不等于不关联 —— 服务端会按默认规则决定
            : solutionsState === 'ok' ? '不关联' : '未选（由服务端按默认规则决定）'}</div>
          <div>
            MRR：{Number(values.mrrUsd).toLocaleString()} USD/月
            {amounts && <Text type="secondary">
              （ARR {amounts.arr.toLocaleString()}，POC 可申请 {amounts.poc.toLocaleString()} USD）
            </Text>}
          </div>
          <Alert style={{ marginTop: 12 }} type="warning" showIcon
            message={willSubmit
              ? '将创建真实商机并提交 AWS 审核。提交后商机被锁定，直到审批完成才能修改。'
              : '将创建商机但不提交，之后可在控制台手动提交。'} />
        </div>
      ),
      okText: willSubmit ? '创建并提交' : '创建（不提交）',
      cancelText: '再检查一下',
      onOk: async () => {
        setSubmitting(true);
        try {
          const r = await api.pocCashCreate(payload);
          // request() 对非 2xx 不抛错，会把 { error } 原样 resolve 回来。
          // 不在这里拦住，下面的结果页会渲染出「商机 undefined 已创建」，
          // 并在解引用 r.amounts.mrrUsd 时整页崩成错误边界（实测）。
          if (r?.error || !r?.opportunityId) {
            throw new Error(r?.error || '创建失败：服务端未返回商机 ID');
          }
          setResult(r);
          if (r.warnings?.length) {
            message.warning(`商机 ${r.opportunityId} 已创建，但有 ${r.warnings.length} 条警告`);
          } else {
            message.success(`商机 ${r.opportunityId} ${r.submitted ? '已提交' : '已创建'}`);
          }
        } catch (e: any) {
          message.error(e.message || '创建失败');
        } finally {
          setSubmitting(false);
        }
      },
    });
  };

  // ⚠️ 必须定义在下面 `if (result) return` 之前：结果页的「查看阶段」按钮
  // 闭包引用了它，若定义在 early return 之后，该语句永不执行，
  // 点击时会因 TDZ 抛 ReferenceError（编译期发现不了）。
  const doCheck = async (id?: string) => {
    const target = (id || checkId).trim().toUpperCase();
    if (!/^O\d+$/.test(target)) {
      message.warning('请选择或填写商机 ID，格式如 O28604112');
      return;
    }
    setChecking(true);
    try {
      const s = await api.pocCashStage(target, activePartner);
      setStageInfo(s);
      setCheckId(target);
    } catch (e: any) {
      message.error(e.message || '查询失败');
      setStageInfo(null);
    } finally {
      setChecking(false);
    }
  };

  /** 当前主体的元信息，用于在表单上展示账户号与 Solution 情况 */
  const activeP = (meta?.partners || []).find(p => p.key === activePartner);
  const requiredTags = activeP?.requiredTags || [];

  const resetAll = () => {
    setResult(null); form.resetFields(); setMrr(null); setAutoTitle('');
    setTitleMode('auto'); setPeople(2); setDays(5); setRefFrom(null);
    // resetFields 会清空 partnerKey，这里把当前主体写回去，
    // 避免重置后表单主体与 activePartner（及已加载的列表）不一致
    if (activePartner) form.setFieldValue('partnerKey', activePartner);
    form.setFieldValue('solutionId', solutionDefault ?? undefined);
  };

  /**
   * 补提交商机给 AWS。
   *
   * 提交后商机会被 AWS 锁定直到审批完成，属于不可逆操作，故二次确认。
   */
  const doSubmitOpportunity = () => {
    if (!stageInfo) return;
    const noSolution = !stageInfo.solutionIds?.length;
    Modal.confirm({
      title: '确认提交给 AWS 审核？',
      width: 560,
      content: (
        <div style={{ lineHeight: 1.9 }}>
          <Text strong>{stageInfo.title || stageInfo.id}</Text>
          <div style={{ marginTop: 8 }}>
            {stageInfo.id} · {stageInfo.companyName}
          </div>
          {noSolution && (
            <Alert style={{ marginTop: 12 }} type="warning" showIcon
              message="该商机未关联 Solution"
              description="AWS 审核时可能要求补充。" />
          )}
          <Alert style={{ marginTop: 12 }} type="warning" showIcon
            message="提交后商机会被 AWS 锁定，直到审批完成才能修改阶段。" />
        </div>
      ),
      okText: '提交',
      cancelText: '再想想',
      onOk: async () => {
        setSubmittingOpp(true);
        try {
          const r = await api.pocCashSubmitOpportunity(stageInfo.id, activePartner);
          // request() 对非 2xx 不抛错，必须自己判（同创建商机）
          if (r?.error || !r?.status) {
            throw new Error(r?.error || '提交失败：服务端未返回状态');
          }
          setStageInfo(r.status);
          if (r.warnings?.length) {
            message.warning(`已提交，但有 ${r.warnings.length} 条提示`);
          } else {
            message.success(`商机 ${r.opportunityId} 已提交给 AWS`);
          }
        } catch (e: any) {
          message.error(e.message || '提交失败');
        } finally {
          setSubmittingOpp(false);
        }
      },
    });
  };

  const doAdvance = (to: string) => {
    if (!stageInfo) return;
    Modal.confirm({
      title: '确认推进阶段？',
      content: (
        <div style={{ lineHeight: 1.9 }}>
          <Text strong>{stageInfo.title || stageInfo.id}</Text>
          <div style={{ marginTop: 8 }}>
            <Tag>{stageInfo.stage}</Tag> → <Tag color="blue">{to}</Tag>
          </div>
          <Text type="secondary">阶段会同步到 AWS，请确认项目确实推进到了该阶段。</Text>
        </div>
      ),
      okText: '推进',
      cancelText: '取消',
      onOk: async () => {
        setAdvancing(true);
        try {
          const after = await api.pocCashAdvanceStage(stageInfo.id, to, activePartner);
          setStageInfo(after);
          message.success(`已推进到 ${after.stage}`);
        } catch (e: any) {
          message.error(e.message || '推进失败');
        } finally {
          setAdvancing(false);
        }
      },
    });
  };

  // ===== POC 资金申请 =====

  const loadPocRows = async () => {
    const requested = activePartnerRef.current;
    if (!requested) return;
    setPocLoading(true);
    try {
      const r = await api.pocFundingList(requested);
      // 加载期间切了主体：丢弃旧主体的结果，避免列出别家的申请
      if (activePartnerRef.current !== requested) return;
      // request() 对非 2xx 不抛错，{ error } 会被当成正常结果返回
      if (r?.error) { message.error(r.error); return; }
      setPocRows(r.applications || []);
    } catch (e: any) {
      message.error(e.message || '加载 POC 列表失败');
    } finally {
      setPocLoading(false);
    }
  };

  /**
   * 主体切换后的统一清理（无论从哪个选择器切换）。
   *
   * POC 表单里已选的商机、预览与进展列表都属于旧主体，留着会拿新主体的
   * 凭证去查旧主体的商机，或把两家的申请混在一张表里。
   */
  useEffect(() => {
    activePartnerRef.current = activePartner;
    setCheckId('');
    setStageInfo(null);
    pocForm.setFieldsValue({ opportunityId: undefined });
    setPocPreview(null);
    setPocResult(null);
    setPocRows([]);
    if (activePartner && tab === 'progress') loadPocRows();
  }, [activePartner]);

  // 结果页的提前 return 必须放在所有 hook 之后：放在 hook 前面时，
  // 创建成功那次渲染会少跑 hook，触发 React #300 整页崩溃。
  if (result) {
    return (
      <Card>
        <Result
          status={result.warnings?.length ? 'warning' : 'success'}
          title={`商机 ${result.opportunityId} ${result.submitted ? '已提交' : '已创建'}`}
          subTitle={result.title}
          extra={[
            <Button key="stage" type="primary" onClick={() => {
              const id = result.opportunityId;
              setResult(null); setTab('stage'); setCheckId(id); doCheck(id);
            }}>查看阶段</Button>,
            <Button key="new" onClick={resetAll}>再建一个</Button>,
            <Button key="copy" icon={<CopyOutlined />} onClick={() => {
              navigator.clipboard.writeText(result.opportunityId);
              message.success('已复制商机 ID');
            }}>复制 ID</Button>,
          ]}
        />
        <Descriptions bordered size="small" column={2}>
          <Descriptions.Item label="Opportunity ID">{result.opportunityId}</Descriptions.Item>
          <Descriptions.Item label="状态">
            <Tag color={result.reviewStatus === 'Submitted' ? 'processing' : 'default'}>
              {result.stage} / {result.reviewStatus}
            </Tag>
          </Descriptions.Item>
          <Descriptions.Item label="Solution">
            {result.solutionAssociated
              ? <Tag color="success">{result.solutionId}</Tag>
              : <Tag color="error">未关联</Tag>}
          </Descriptions.Item>
          <Descriptions.Item label="Engagement">{result.engagementId || '—'}</Descriptions.Item>
          {/* amounts 理论上必有，但残缺响应不该让整页崩掉 —— 这里的
              解引用曾是「商机 undefined 已创建」白屏的直接崩溃点 */}
          <Descriptions.Item label="MRR">
            {result.amounts ? `${result.amounts.mrrUsd.toLocaleString()} USD/月` : '—'}
          </Descriptions.Item>
          <Descriptions.Item label="ARR">
            {result.amounts ? `${result.amounts.arrUsd.toLocaleString()} USD` : '—'}
          </Descriptions.Item>
          <Descriptions.Item label="POC 可申请" span={2}>
            {result.amounts ? (
              <>
                <Text strong>{result.amounts.pocUsd.toLocaleString()} USD</Text>
                <Text type="secondary">
                  {' '}≈ {(result.amounts.pocUsd * MYR_RATE).toLocaleString(undefined,
                    { maximumFractionDigits: 2 })} MYR
                </Text>
              </>
            ) : '—'}
          </Descriptions.Item>
          {result.arn && (
            <Descriptions.Item label="ARN" span={2}>
              <Text copyable style={{ fontSize: 12 }}>{result.arn}</Text>
            </Descriptions.Item>
          )}
        </Descriptions>

        {(result.warnings?.length ?? 0) > 0 && (
          <Alert style={{ marginTop: 16 }} type="warning" showIcon
            message="以下步骤未成功，但商机本身已创建"
            description={<ul style={{ margin: 0, paddingLeft: 18 }}>
              {(result.warnings || []).map((w, i) => <li key={i}>{w}</li>)}
            </ul>} />
        )}

        <Alert style={{ marginTop: 16 }} type="info" showIcon message="下一步"
          description={`等 AWS 审批通过（ReviewStatus 变为 Approved）后才能把阶段推到 `
            + `Technical Validation，然后做定价计算器`
            + (result.amounts
              ? `（目标 ARR ${result.amounts.arrUsd.toLocaleString()} USD）` : '')
            + `并提交 POC 资金申请。`} />
      </Card>
    );
  }

  /** 账户 ID → 项目桶。不在任何 payer 下的账户（客户自有/APN 账户）
   *  查不到属正常，留空即可，不编造。 */
  const lookupAccount = async (id: string) => {
    setPocBucket(null); setPocAcctErr('');
    if (!/^\d{12}$/.test(id)) return;
    try {
      const a = await api.pocFundingAccount(id);
      setPocBucket(a.payer || null);
      if (!a.payer) setPocAcctErr('该账户不在任何 payer 下，项目桶将留空');
    } catch (e: any) {
      setPocAcctErr(e.message || '账户不在平台缓存中');
    }
  };

  const doPocPreview = async () => {
    const v = pocForm.getFieldsValue();
    if (!v.opportunityId) { message.warning('请先选择商机'); return; }
    setPocBusy(true);
    try {
      setPocPreview(await api.pocFundingPreview({
        partnerKey: activePartner,
        opportunityId: v.opportunityId, awsAccountId: v.awsAccountId,
        people: v.people, days: v.days, leadDays: v.leadDays,
      }));
    } catch (e: any) {
      message.error(e.message || '预览失败');
      setPocPreview(null);
    } finally {
      setPocBusy(false);
    }
  };

  const doPocCreate = (values: any) => {
    const willSubmit = values.submit !== false;
    Modal.confirm({
      title: willSubmit ? '确认创建并提交 POC 申请？' : '确认创建 POC 申请？',
      width: 560,
      content: (
        <div style={{ lineHeight: 1.9 }}>
          <div>主体 {activeP?.label}
            <Text type="secondary">（发票 {activeP?.fundingInvoiceEntity}）</Text></div>
          <div>商机 <Text code>{values.opportunityId}</Text></div>
          <div>AWS 账户 {values.awsAccountId}
            {pocBucket && <Text type="secondary">（{pocBucket}）</Text>}</div>
          {pocPreview?.amounts && (
            <div>申请额 <Text strong>
              {pocPreview.amounts.pocUsd.toLocaleString()} USD
            </Text>（{pocPreview.amounts.requestMyr.toLocaleString()} MYR）</div>
          )}
          <Alert style={{ marginTop: 12 }} type="warning" showIcon
            message={willSubmit
              ? '会生成定价计算器链接并提交给 AWS 审核，提交后不可修改。'
              : '只创建不提交，可在列表里确认后再提交。'} />
        </div>
      ),
      okText: willSubmit ? '创建并提交' : '创建',
      cancelText: '再检查一下',
      onOk: async () => {
        setPocBusy(true);
        try {
          const r = await api.pocFundingCreate({ ...values, partnerKey: activePartner });
          // request() 对 HTTP 400 不抛错，而是把 { error } 当正常结果返回。
          // 不在这里拦住，下面的结果页会渲染出「undefined 已创建」，
          // 真实失败原因被这条假的成功提示盖掉（与创建商机同一类问题）。
          if (r?.error || !r?.applicationId) {
            message.error(r?.error || 'POC 申请创建失败：服务端未返回申请号');
            return;
          }
          setPocResult(r);
          if (r.warnings?.length) {
            message.warning(`${r.applicationId} 已创建，${r.warnings.length} 条提醒`);
          } else {
            message.success(`${r.applicationId} ${r.submitted ? '已提交' : '已创建'}`);
          }
          // 创建完直接跳到进展页 —— 用户下一步就是看状态，不用自己切
          setTab('progress');
          loadPocRows();
        } catch (e: any) {
          message.error(e.message || '创建失败');
        } finally {
          setPocBusy(false);
        }
      },
    });
  };

  const doPocSubmit = (row: PocRow) => {
    Modal.confirm({
      title: '提交给 AWS 审核？',
      content: <div style={{ lineHeight: 1.8 }}>
        <Text code>{row.applicationId}</Text>
        <div>{row.name}</div>
        <Text type="secondary">提交后商机锁定，需等 AWS 审批完成。</Text>
      </div>,
      okText: '提交',
      onOk: async () => {
        try {
          const r = await api.pocFundingSubmit(row.applicationId, activePartner);
          message.success(`已提交：${r.status} / ${r.stage}`);
          loadPocRows();
        } catch (e: any) {
          message.error(e.message || '提交失败');
        }
      },
    });
  };

  /** 导出 CSV：服务器留存快照，同时浏览器下载一份 */
  const doExport = async () => {
    setExporting(true);
    try {
      const r = await api.pocFundingExport(activePartner);
      if (r?.error) { message.error(r.error); return; }
      const blob = new Blob([r.csv], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = r.file || 'poc-cash.csv';
      a.click();
      URL.revokeObjectURL(a.href);
      message.success(`已导出 ${r.rows} 条，服务器留存 ${r.file}`);
    } catch (e: any) {
      message.error(e.message || '导出失败');
    } finally {
      setExporting(false);
    }
  };

  const renderPocForm = () => (
    <Form form={pocForm} layout="vertical" onFinish={doPocCreate}
      disabled={activeP?.fundingEnabled === false}
      initialValues={{ people: 2, days: 3, leadDays: 14, considering: 'Other', submit: true }}>
      {renderPartnerPicker()}
      {activeP?.fundingEnabled === false && (
        <Alert style={{ marginBottom: 16, maxWidth: 900 }} type="warning" showIcon
          message={`${activeP.label} 未配置 POC 发票信息，暂不能提 POC 资金申请`} />
      )}
      <Alert style={{ marginBottom: 16, maxWidth: 900 }} type="info" showIcon
        message="POC 必须先有商机"
        description="商机要已到 Technical Validation 且 ReviewStatus 为 Approved / Action Required。计算器链接、金额、发票信息由平台自动生成。" />

      <Space align="start" wrap size="large">
        <Form.Item name="opportunityId" label="商机" rules={[{ required: true }]}
          extra="只有满足前置条件的商机才能提 POC">
          <Select style={{ width: 420 }} showSearch allowClear loading={oppsLoading}
            placeholder="按客户名 / 商机 ID 搜索" optionFilterProp="label"
            onChange={() => setPocPreview(null)}
            options={opps.map(o => ({ value: o.id, label: `${o.companyName} — ${o.id}` }))} />
        </Form.Item>
        <Form.Item name="awsAccountId" label="AWS 账户 ID"
          rules={[{ required: true, pattern: /^\d{12}$/, message: '12 位数字' }]}
          extra={pocBucket
            ? <Text type="success">项目桶：{pocBucket}</Text>
            : (pocAcctErr ? <Text type="warning">{pocAcctErr}</Text> : 'POC 在哪个账户执行')}>
          <Input style={{ width: 200 }} maxLength={12} placeholder="782818417417"
            onChange={e => lookupAccount(e.target.value.trim())} />
        </Form.Item>
      </Space>

      <Form.Item name="description" label="业务描述"
        rules={[{ required: true, min: 50, message: '至少 50 字 —— AWS 会看是否具体' }]}
        extra="POC 要验证什么、用到哪些 AWS 服务、partner 做哪些事">
        <TextArea rows={5} style={{ maxWidth: 900 }} showCount />
      </Form.Item>

      <Space align="start" wrap size="large">
        <Form.Item name="people" label="人数"><InputNumber min={1} style={{ width: 90 }} /></Form.Item>
        <Form.Item name="days" label="天数" extra="实操中位数 4 天">
          <InputNumber min={1} style={{ width: 90 }} /></Form.Item>
        <Form.Item name="leadDays" label="几天后开始" extra="流程要求 ≥ 14 天">
          <InputNumber min={0} style={{ width: 110 }} /></Form.Item>
        <Form.Item name="considering" label="竞争对手">
          <Select style={{ width: 170 }} options={
            ['Other', 'No Competition', 'AliCloud', 'On-Premise']
              .map(v => ({ value: v, label: v }))} /></Form.Item>
        <Form.Item label=" ">
          <Button onClick={doPocPreview} loading={pocBusy}>预览金额</Button>
        </Form.Item>
      </Space>

      {pocPreview && (
        <>
          {!pocPreview.precheck?.ok && (
            <Alert style={{ maxWidth: 900, marginBottom: 12 }} type="error" showIcon
              message="商机不满足前置条件"
              description={<ul style={{ margin: 0, paddingLeft: 18 }}>
                {pocPreview.precheck.problems.map((p: string, i: number) =>
                  <li key={i}>{p}</li>)}</ul>} />
          )}
          <Descriptions bordered size="small" column={2}
            style={{ maxWidth: 900, marginBottom: 12 }}>
            <Descriptions.Item label="商机 MRR">
              {pocPreview.amounts.mrrUsd.toLocaleString()} USD/月</Descriptions.Item>
            <Descriptions.Item label="ARR（计算器目标）">
              {pocPreview.amounts.arrUsd.toLocaleString()} USD</Descriptions.Item>
            <Descriptions.Item label="POC 可申请">
              <Text strong>{pocPreview.amounts.pocUsd.toLocaleString()} USD</Text></Descriptions.Item>
            <Descriptions.Item label="实际申请额">
              {pocPreview.amounts.requestMyr.toLocaleString()} MYR</Descriptions.Item>
            <Descriptions.Item label="Total Cost">
              {pocPreview.amounts.totalMyr.toLocaleString()} MYR</Descriptions.Item>
            <Descriptions.Item label="Partner 投入">
              {pocPreview.amounts.partnerMyr.toLocaleString()} MYR
              <Text type={pocPreview.amounts.partnerPct < 10 ? 'danger' : 'secondary'}>
                {' '}（{pocPreview.amounts.partnerPct.toFixed(1)}%）</Text>
            </Descriptions.Item>
          </Descriptions>
          {pocPreview.warnings?.length > 0 && (
            <Alert style={{ maxWidth: 900, marginBottom: 12 }} type="warning" showIcon
              message="风险项" description={<ul style={{ margin: 0, paddingLeft: 18 }}>
                {pocPreview.warnings.map((w: string, i: number) => <li key={i}>{w}</li>)}
              </ul>} />
          )}
        </>
      )}

      <Form.Item name="submit" label="创建后是否提交">
        <Radio.Group optionType="button" buttonStyle="solid">
          <Radio.Button value={true}>创建并提交</Radio.Button>
          <Radio.Button value={false}>只创建</Radio.Button>
        </Radio.Group>
      </Form.Item>
      {pocPreview?.warnings?.length > 0 && (
        <Form.Item name="force" valuePropName="checked">
          <Radio.Group optionType="button" size="small">
            <Radio.Button value={true}>已确认风险，继续</Radio.Button>
          </Radio.Group>
        </Form.Item>
      )}
      <Form.Item>
        <Button type="primary" htmlType="submit" size="large" loading={pocBusy}
          disabled={!meta?.configured}>提交 POC 申请</Button>
      </Form.Item>
    </Form>
  );

  const renderPocTab = () => renderPocForm();

  const renderProgressTab = () => (
    <>
      {pocResult && (
        <Alert style={{ marginBottom: 16 }} closable onClose={() => setPocResult(null)}
          type={pocResult.warnings?.length ? 'warning' : 'success'} showIcon
          message={`${pocResult.applicationId || '(未返回申请号)'} ${pocResult.submitted ? '已提交' : '已创建'}`}
          description={<div style={{ lineHeight: 1.8 }}>
            {/* 残缺响应不再渲染成空白字段：以前金额/计算器取不到时
                会显示「申请额 USD （ MYR）」「计算器」这种半截文案 */}
            <div>{pocResult.name || '(无名称)'} · {pocResult.status || '状态未知'}
              {pocResult.stage ? ` / ${pocResult.stage}` : ''}</div>
            {pocResult.amounts?.pocUsd != null ? (
              <div>申请额 {pocResult.amounts.pocUsd.toLocaleString()} USD
                （{pocResult.amounts.requestMyr?.toLocaleString() ?? '—'} MYR）</div>
            ) : <div><Text type="secondary">申请额未返回</Text></div>}
            {pocResult.calculatorUrl ? (
              <div>计算器 <a href={pocResult.calculatorUrl} target="_blank"
                rel="noreferrer">{pocResult.calculatorUrl}</a></div>
            ) : <div><Text type="secondary">计算器链接未返回</Text></div>}
            {/* 金额不加千分位：与 CSV 台账口径一致，也便于直接和计算器页面对数 */}
            {pocResult.calculator?.total != null && (
              <div>计算器总额 {pocResult.calculator.total} USD · {pocResult.calculator.items.length} 项服务
                <div className="poc-calc-items">
                  {pocResult.calculator.items.map((it: { label: string; monthly: number }, i: number) =>
                    <Tag key={i}>{it.label} · {it.monthly} USD</Tag>)}
                </div>
              </div>
            )}
            {pocResult.warnings?.map((w: string, i: number) =>
              <div key={i}><Text type="warning">⚠️ {w}</Text></div>)}
          </div>} />
      )}
      {renderPartnerPicker()}
      <Space style={{ marginBottom: 12 }} wrap>
        <Button onClick={loadPocRows} loading={pocLoading}>刷新</Button>
        <Button icon={<DownloadOutlined />} onClick={doExport} loading={exporting}
          disabled={!pocRows.length}>导出 CSV 台账</Button>
        <Text type="secondary">
          共 {pocRows.length} 条 · 进度含 Cash Claim，请款付款后才算完成 · 金额与控制台一致不含小数
        </Text>
      </Space>
      {pocRows.length > 0 && (
        <Space size={[6, 6]} wrap style={{ marginBottom: 12 }}>
          {PHASE_GROUPS.map(g => {
            const n = pocRows.filter(r => g.phases.includes(r.progress?.phase || '')).length;
            return n ? <Tag key={g.value}>{g.text} {n}</Tag> : null;
          })}
        </Space>
      )}
      {/* 列宽按实测内容宽度分配，合计 1402 < 常见内容区宽度，
          正常屏下不触发横向滚动 —— 一旦滚动，右侧 fixed 的「操作」列会压住
          「周期」，日期被截成半截（改版前就是这个毛病）。
          调宽任何一列时记得同步下面的 scroll.x。 */}
      <Table<PocRow> rowKey="applicationId" size="small" loading={pocLoading}
        dataSource={pocRows} scroll={{ x: 1402 }} pagination={{ pageSize: 20 }}
        columns={[
          // 状态不设 fixed：列本身较宽，固定后会盖住相邻的 ID 列（实测截图里
          // Fund Request ID 被压掉了一半）。首列放 ID 更利于对账。
          {
            title: 'Fund Request ID', dataIndex: 'applicationId', width: 192,
            render: (v: string) => (
              <Text style={{ fontSize: 12, whiteSpace: 'nowrap' }} copyable={{ text: v }}>{v}</Text>
            ),
          },
          {
            // 端到端进度：预批 → 请款（Cash Claim）→ 付款，请款付款才算 POC 结束。
            // Tag 只放主状态，环节/金额/付款日降为下方次要行（塞进 Tag 会折行
            // 撑成大色块，盖过主键 Fund Request ID）。悬停看预批与每笔请款明细。
            title: '进度', key: 'progress', width: 176,
            filters: PHASE_GROUPS.map(g => ({ text: g.text, value: g.value })),
            onFilter: (v, r) => !!PHASE_GROUPS.find(g => g.value === v)
              ?.phases.includes(r.progress?.phase || ''),
            render: (_: any, r) => {
              const p = r.progress;
              const tip = (
                <div style={{ lineHeight: 1.8, fontSize: 12 }}>
                  <div>预批：{POC_LABEL[r.status || ''] || r.status || '—'}
                    {r.stage ? `（${r.stage}）` : ''}</div>
                  {r.claims === null && <div>请款：状态查询失败，请刷新</div>}
                  {r.claims?.length === 0 && r.status === 'APPROVED' && (
                    <div>请款：未提交{r.claimDeadline ? `，截止 ${r.claimDeadline}` : ''}</div>
                  )}
                  {(r.claims || []).map(c => (
                    <div key={c.applicationId}>
                      请款 {c.applicationId}：{CLAIM_STATUS_LABEL[c.status || ''] || c.status}
                      {c.stage ? `（${c.stage}）` : ''}
                      {c.claimAmount ? ` · ${consoleAmount(c.claimAmount)} ${c.claimCurrency || ''}` : ''}
                      {c.invoiceRef && !c.invoiceRef.startsWith('http') ? ` · 发票 ${c.invoiceRef}` : ''}
                      {c.scheduledPaymentDate ? ` · 付款日 ${c.scheduledPaymentDate}` : ''}
                    </div>
                  ))}
                </div>
              );
              return (
                // Tooltip 只接受单个子节点，Tag + 次要行包一层
                <Tooltip title={tip}>
                  <div>
                    <Tag color={p ? PHASE_COLOR[p.phase] || 'default' : pocColor(r.status)}
                      style={{ marginInlineEnd: 0 }}>
                      {p?.label || POC_LABEL[r.status || ''] || r.status}
                    </Tag>
                    {p?.detail && (
                      <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 2 }}
                        ellipsis>{p.detail}</Text>
                    )}
                  </div>
                </Tooltip>
              );
            },
          },
          {
            title: '项目桶', dataIndex: 'bucket', width: 128, ellipsis: true,
            // 项目桶 = 该 AWS 账户所属的 payer，取自平台账户缓存。
            // 客户自有账户不在我们的组织里，查不到是**正常结果**，不是故障 ——
            // 加 tooltip 说明，否则一列「—」看起来像功能坏了。
            render: (b: string | null) => b || (
              <Tooltip title="该 AWS 账户不在平台管理的任何组织内（客户自有账户），因此没有对应的项目桶">
                <Text type="secondary">—</Text>
              </Tooltip>
            ),
          },
          {
            title: '账户', dataIndex: 'awsAccountId', width: 118,
            // 12 位数字要给足宽度，否则会折成两行
            render: (v: string) => v
              ? <Text style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{v}</Text>
              : <Text type="secondary">—</Text>,
          },
          {
            title: '商机', dataIndex: 'opportunityId', width: 104,
            // 与「账户」同为 ID，统一 12px，避免两列字号打架
            render: (v: string) => v
              ? <Text style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{v}</Text>
              : <Text type="secondary">—</Text>,
          },
          {
            title: '申请额 (MYR)', dataIndex: 'requestMyr', width: 116, align: 'right',
            // 与控制台一致截掉小数
            render: (v: number | null) => consoleAmount(v) ?? '—',
          },
          {
            title: 'PO 号', dataIndex: 'purchaseOrder', width: 120, ellipsis: true,
            render: (v: string | null) => v
              ? <Text style={{ fontSize: 12 }}>{v}</Text>
              : <Text type="secondary" style={{ fontSize: 12 }}>待 AWS 回填</Text>,
          },
          {
            // 原「到账金额」列显示的其实是 ApprovedAmount —— 批准≠到账，
            // 到账信息在事后 Cash Claim 里，Funding 申请拿不到，故改为如实标注。
            title: 'AWS 批准额 (MYR)', dataIndex: 'approvedAmount', width: 128, align: 'right',
            // 与 Partner Central 控制台一致：直接截掉小数（控制台 38133.58 显示
            // 38,133，不是四舍五入）。悬停看 API 原值。
            render: (v: string | null, r) => {
              if (!v) {
                return <Text type="secondary" style={{ fontSize: 12 }}>
                  {r.status === 'APPROVED' ? '待 AWS 回填' : '—'}</Text>;
              }
              const text = `${consoleAmount(v)}`
                + `${r.approvedCurrency && r.approvedCurrency !== 'MYR' ? ` ${r.approvedCurrency}` : ''}`;
              return (
                <Tooltip title={`API 原值 ${v} ${r.approvedCurrency || ''}`.trim()}>
                  <Text style={{ whiteSpace: 'nowrap' }}>{text}</Text>
                </Tooltip>
              );
            },
          },
          {
            title: '周期', width: 172,
            render: (_: any, r) => r.startDate
              ? <Text style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                {r.startDate} ~ {r.endDate}</Text>
              : <Text type="secondary">—</Text>,
          },
          {
            title: '计算器', dataIndex: 'calculatorUrl', width: 72, align: 'center',
            render: (u: string) => u
              ? <a href={u} target="_blank" rel="noreferrer">打开</a>
              : <Text type="secondary">—</Text>,
          },
          {
            title: '操作', width: 76, fixed: 'right', align: 'center',
            render: (_: any, r) => r.status === 'PENDING_SUBMISSION'
              ? <Button size="small" type="link" onClick={() => doPocSubmit(r)}>提交</Button>
              : <Text type="secondary">—</Text>,
          },
        ]} />
    </>
  );

  const renderStageDetail = () => {
    if (!stageInfo) return null;
    const a = stageInfo.amounts;
    return (
      <>
        <Descriptions bordered size="small" column={2} style={{ maxWidth: 900 }}>
          <Descriptions.Item label="商机" span={2}>
            <Text strong>{stageInfo.title || '(无标题)'}</Text>
            <br /><Text type="secondary">{stageInfo.id} · {stageInfo.companyName}</Text>
          </Descriptions.Item>
          <Descriptions.Item label="当前阶段">
            <Tag color="blue">{stageInfo.stage || '—'}</Tag>
          </Descriptions.Item>
          <Descriptions.Item label="审核状态">
            <Tag color={reviewColor(stageInfo.reviewStatus)}>
              {stageInfo.reviewStatus || '—'}
            </Tag>
          </Descriptions.Item>
          <Descriptions.Item label="预计成交">
            {stageInfo.targetCloseDate || '—'}</Descriptions.Item>
          <Descriptions.Item label="最后修改">
            {stageInfo.lastModifiedDate
              ? stageInfo.lastModifiedDate.replace('T', ' ').slice(0, 19) : '—'}
          </Descriptions.Item>
          <Descriptions.Item label="Solution">
            {stageInfo.solutionIds.length
              ? stageInfo.solutionIds.map(s => <Tag key={s}>{s}</Tag>)
              : <Tag color="error">未关联</Tag>}
          </Descriptions.Item>
          <Descriptions.Item label="MRR / POC 额度">
            {a ? <>{a.mrrUsd.toLocaleString()} USD/月
              <Text type="secondary"> → POC {a.pocUsd.toLocaleString()} USD</Text></> : '—'}
          </Descriptions.Item>
        </Descriptions>

        {/* 三态：可改阶段 / 待提交（有操作可做）/ 被锁定。
            待提交不该显示成纯警告 —— 它是正常流程的一环，有按钮可点。 */}
        <Alert style={{ maxWidth: 900, marginTop: 16 }}
          type={stageInfo.editable ? 'success'
            : stageInfo.submittable ? 'info' : 'warning'} showIcon
          message={stageInfo.editable ? '可以操作'
            : stageInfo.submittable ? '待提交给 AWS' : '当前不可改阶段'}
          description={stageInfo.reason} />

        {stageInfo.readyForPoc && a && (
          <Alert style={{ maxWidth: 900, marginTop: 12 }} type="info" showIcon
            message="已到 Technical Validation —— 可以提 POC 资金申请了"
            description={`定价计算器目标 ARR ${a.arrUsd.toLocaleString()} USD，`
              + `POC 可申请 ${a.pocUsd.toLocaleString()} USD`
              + `（≈ ${(a.pocUsd * MYR_RATE).toLocaleString(undefined,
                { maximumFractionDigits: 0 })} MYR）`} />
        )}

        <div style={{ marginTop: 16 }}>
          <Space wrap>
            {/* 补提交入口：创建时选「暂不提交」的商机停在 Pending Submission，
                此前只提示「需先提交」却没有按钮，用户只能去控制台操作 */}
            {stageInfo.submittable && (
              <Button type="primary" icon={<RocketOutlined />} loading={submittingOpp}
                onClick={doSubmitOpportunity}>
                提交给 AWS 审核
              </Button>
            )}
            {stageInfo.editable && stageInfo.nextStage && (
              <Button type="primary" loading={advancing}
                onClick={() => doAdvance(stageInfo.nextStage!)}>
                推进到 {stageInfo.nextStage}
              </Button>
            )}
            {stageInfo.editable && (
              <Select style={{ width: 220 }} placeholder="跳到指定阶段"
                value={undefined} disabled={advancing}
                onChange={(v: string) => doAdvance(v)}
                options={[...(meta?.stages || []),
                  ...(meta?.closedLost ? [meta.closedLost] : [])]
                  .filter(s => s !== stageInfo.stage)
                  .map(s => ({ value: s, label: s }))} />
            )}
            <Button loading={checking} onClick={() => doCheck()}>刷新状态</Button>
          </Space>
        </div>
      </>
    );
  };

  /**
   * 「阶段检查」「POC 申请」「POC 进展」共用的主体选择器，绑定页面级 activePartner。
   * 切换后的清理（商机、预览、进展列表）统一在 activePartner 的 effect 里做。
   */
  const renderPartnerPicker = () => (
    <Space style={{ marginBottom: 12 }} wrap>
      <Text type="secondary">Partner 主体</Text>
      <Select
        style={{ width: 260 }}
        value={activePartner || undefined}
        // POC 表单整体 disabled 时选择器仍需可用，否则切不回已配置的主体
        disabled={false}
        onChange={(v: string) => {
          setActivePartner(v);
          form.setFieldValue('partnerKey', v);
        }}
        options={(meta?.partners || []).map(p => ({
          value: p.key,
          label: p.configured === false ? `${p.label}（未配置）` : p.label,
          disabled: p.configured === false,
        }))} />
      {activeP && (
        <Text type="secondary" style={{ fontSize: 12 }}>
          APN 账户 {activeP.apnAccountId}
        </Text>
      )}
    </Space>
  );

  const renderStageTab = () => (
    <>
      <Paragraph type="secondary" style={{ maxWidth: 900 }}>
        提交后商机会被 AWS 锁定，直到审核完成。用这里确认审到哪一步了 ——
        <Text code>Approved</Text> 或 <Text code>Action Required</Text> 才能继续改阶段，
        到 <Text code>Technical Validation</Text> 才能提 POC 资金申请。
      </Paragraph>

      {/* 本 Tab 不在创建表单里，必须有独立的主体切换 —— 否则查别的主体的
          商机会一直落到默认主体账户上，报「找不到」 */}
      {renderPartnerPicker()}

      <Space.Compact style={{ width: '100%', maxWidth: 620, marginBottom: 16 }}>
        <Select
          style={{ width: '100%' }} showSearch allowClear
          loading={oppsLoading}
          value={checkId || undefined}
          placeholder="选择或搜索商机（按客户名 / ID）"
          optionFilterProp="label"
          onChange={(v: string) => { setCheckId(v || ''); if (v) doCheck(v); }}
          options={opps.map(o => ({ value: o.id, label: `${o.companyName} — ${o.id}` }))}
          optionRender={(opt) => {
            const o = opps.find(x => x.id === opt.value);
            if (!o) return opt.label;
            return (
              <div style={{ lineHeight: 1.5 }}>
                <div>{o.companyName}</div>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {o.id} · {o.createdDate || ''} · {o.stage || '?'}
                  {o.reviewStatus ? ` / ${o.reviewStatus}` : ''}
                </Text>
              </div>
            );
          }}
        />
        <Button type="primary" loading={checking} onClick={() => doCheck()}>查询</Button>
      </Space.Compact>
      {renderStageDetail()}
    </>
  );

  const renderAmounts = () => (
    <>
      <Divider orientation="left">金额</Divider>
      <Space align="start" wrap size="large">
        <Form.Item name="mrrUsd" label="MRR（USD/月）" rules={[{ required: true }]}
          extra="ARR 与 POC 额度由它推导">
          <InputNumber style={{ width: 180 }} min={1} step={100}
            onChange={v => setMrr(typeof v === 'number' ? v : null)} />
        </Form.Item>
        <Form.Item label="POC 人数" extra="影响 Total Cost">
          <InputNumber style={{ width: 110 }} min={1} value={people}
            onChange={v => setPeople(typeof v === 'number' ? v : 1)} />
        </Form.Item>
        <Form.Item label="POC 天数" extra="实操中位数 4 天">
          <InputNumber style={{ width: 110 }} min={1} value={days}
            onChange={v => setDays(typeof v === 'number' ? v : 1)} />
        </Form.Item>
      </Space>

      {amounts && (
        <Alert style={{ maxWidth: 900, marginBottom: 16 }} type="info"
          message="金额联动预览"
          description={
            <Descriptions size="small" column={2} style={{ marginTop: 8 }}>
              <Descriptions.Item label="ARR（定价计算器目标）">
                {amounts.arr.toLocaleString()} USD</Descriptions.Item>
              <Descriptions.Item label="POC 可申请">
                <Text strong>{amounts.poc.toLocaleString()} USD</Text></Descriptions.Item>
              <Descriptions.Item label="Total Cost of Activity">
                {amounts.totalMyr.toLocaleString()} MYR
                <Text type="secondary"> （339×8×{people}人×{days}天）</Text>
              </Descriptions.Item>
              <Descriptions.Item label="Partner Contribution">
                {amounts.partnerMyr.toLocaleString(undefined, { maximumFractionDigits: 2 })} MYR
                <Text type={amounts.partnerPct < 10 ? 'danger' : 'secondary'}>
                  {' '}（{amounts.partnerPct.toFixed(1)}%）</Text>
              </Descriptions.Item>
              <Descriptions.Item label="实际申请额" span={2}>
                {amounts.requestMyr.toLocaleString(undefined, { maximumFractionDigits: 2 })} MYR
                <Text type="secondary"> （汇率 {MYR_RATE}）</Text>
              </Descriptions.Item>
            </Descriptions>
          } />
      )}
      {amounts && amounts.partnerMyr < 0 && (
        <Alert style={{ maxWidth: 900, marginBottom: 16 }} type="error" showIcon
          message="Partner Contribution 为负"
          description="总成本不够覆盖申请额，请增加人天或降低 MRR。" />
      )}
      {amounts && amounts.partnerMyr >= 0 && amounts.partnerPct < 10 && (
        <Alert style={{ maxWidth: 900, marginBottom: 16 }} type="warning" showIcon
          message={`Partner 投入仅占 ${amounts.partnerPct.toFixed(1)}%`}
          description="低于 10% 容易被质疑，建议增加人天。" />
      )}
      {amounts && amounts.poc > POC_CAP_USD && (
        <Alert style={{ maxWidth: 900, marginBottom: 16 }} type="warning" showIcon
          message={`POC 申请额 ${amounts.poc.toLocaleString()} USD 超过经验上限`}
          description={`实测 114 条记录中申请额无一超过 ${POC_CAP_USD.toLocaleString()} USD，`
            + `超过可能需走别的审批通道。`} />
      )}
    </>
  );

  const renderSubmitSection = () => (
    <>
      <Divider orientation="left">提交</Divider>
      <Form.Item name="submit" label="创建后是否提交给 AWS 审核">
        <Radio.Group optionType="button" buttonStyle="solid">
          <Radio.Button value={true}>创建并提交</Radio.Button>
          <Radio.Button value={false}>只创建，暂不提交</Radio.Button>
        </Radio.Group>
      </Form.Item>
      <Paragraph type="secondary" style={{ maxWidth: 900 }}>
        提交会先建 Engagement 再提交（AWS 要求，不能直接 Submit）。提交后商机进入
        {' '}<Text code>Submitted</Text> 并被锁定，直到 AWS 审批完成；
        审批通过后才能把阶段推到 Technical Validation 并申请 POC 资金。
      </Paragraph>
      <Form.Item>
        <Button type="primary" htmlType="submit" size="large" loading={submitting}
          disabled={!meta?.configured} icon={<RocketOutlined />}>
          创建商机
        </Button>
      </Form.Item>
    </>
  );

  const renderCreateTab = () => (
    <>
      {meta && !meta.configured && (
        <Alert style={{ marginBottom: 16 }} type="error" showIcon
          message="Partner Central 未配置"
          description="请先用 scripts/setup_partner_central_role.py 在 APN 账户创建信任中心账户的 role，再在 config.json 填 partnerCentral { roleArn, externalId }（或设环境变量 PARTNERCENTRAL_ROLE_ARN / PARTNERCENTRAL_EXTERNAL_ID）。" />
      )}

      <Form form={form} layout="vertical" onFinish={doSubmit}
        initialValues={{
          // 默认 None：绝大多数商机不涉及 MDF 资金。选 'Marketing Activity'
          // 必须同时给 AwsFundingUsed，否则 AWS 拒绝创建。
          countryCode: 'MY', submit: true,
          marketingSource: 'None', marketingAwsFundingUsed: 'No',
        }}>

        <Divider orientation="left">参考已有商机（可选）</Divider>
        <Form.Item
          extra="同一客户做新项目时，带出客户信息、Marketing 字段和 Solution。标题、Use Case、业务描述及 MRR 都需按新项目填写。">
          <Select
            style={{ width: '100%', maxWidth: 720 }}
            showSearch allowClear
            loading={oppsLoading}
            value={refFrom}
            placeholder={oppsLoading ? '加载中…' : '按客户名或商机 ID 搜索'}
            optionFilterProp="label"
            onChange={(v: string) => { if (v) applyTemplate(v); else setRefFrom(null); }}
            options={opps.map(o => ({
              value: o.id,
              label: `${o.companyName} — ${o.id}`,
              // 下拉项里多给点上下文，便于判断该用哪条
              title: `${o.stage || ''} ${o.reviewStatus || ''}`,
            }))}
            optionRender={(opt) => {
              const o = opps.find(x => x.id === opt.value);
              if (!o) return opt.label;
              return (
                <div style={{ lineHeight: 1.5 }}>
                  <div>{o.companyName}</div>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {o.id} · {o.createdDate || ''} · {o.stage || '?'}
                    {o.reviewStatus ? ` / ${o.reviewStatus}` : ''}
                    {o.mrrUsd ? ` · ${o.mrrUsd.toLocaleString()} USD/月` : ''}
                  </Text>
                </div>
              );
            }}
          />
        </Form.Item>
        {refFrom && (
          <Alert style={{ maxWidth: 720, marginBottom: 16 }} type="info" showIcon
            message={`已套用 ${refFrom} 的信息`}
            description="Use Case 和业务描述已留空，请按本次项目填写。"
            action={<Button size="small" onClick={() => setRefFrom(null)}>知道了</Button>} />
        )}

        <Divider orientation="left">Partner</Divider>
        <Form.Item name="partnerKey" label="Partner 主体" rules={[{ required: true }]}
          extra={activeP
            ? `APN 账户 ${activeP.apnAccountId}｜` + (
                solutionsState === 'loading' ? '正在查询 Solution…'
                : solutionsState === 'error' ? '查询 Solution 失败，留空将跳过关联'
                : solutions.length ? `${solutions.length} 个 Active Solution`
                : '暂无 Active Solution，创建时跳过关联')
            : '切换主体会同时切换 Solution 与商机列表（各主体数据互相隔离）'}>
          <Select style={{ maxWidth: 320 }}
            onChange={(v: string) => setActivePartner(v)}
            options={(meta?.partners || []).map(p => ({
              value: p.key,
              label: p.configured === false ? `${p.label}（未配置 role）` : p.label,
              disabled: p.configured === false,
            }))} />
        </Form.Item>

        <Divider orientation="left">客户</Divider>
        <Space align="start" wrap size="large">
          <Form.Item name="companyName" label="客户公司全称" rules={[{ required: true }]}
            extra={companyFix
              ? <span style={{ color: '#d46b08' }}>
                  将按权威写法提交为「{companyFix.to}」（商机批准后公司名无法再改）
                </span>
              : undefined}>
            {/* placeholder 原本写的是 (KL) —— 那是错误主体，等于在教人填错 */}
            <Input style={{ width: 360 }} placeholder="Korea Wallpaper (HQ) Sdn Bhd" />
          </Form.Item>
          <Form.Item name="industry" label="行业" rules={[{ required: true }]}>
            <Select style={{ width: 220 }} showSearch placeholder="选择行业"
              options={(meta?.industries || []).map(v => ({ value: v, label: v }))} />
          </Form.Item>
          <Form.Item name="websiteUrl" label="客户网址" rules={[{ required: true }]}>
            <Input style={{ width: 240 }} placeholder="https://example.com/" />
          </Form.Item>
          <Form.Item name="countryCode" label="国家"
            rules={[{ required: true, pattern: /^[A-Za-z]{2}$/, message: '2 位字母' }]}>
            <Input style={{ width: 90 }} maxLength={2} placeholder="MY" />
          </Form.Item>
          <Form.Item name="postalCode" label="邮编">
            <Input style={{ width: 120 }} placeholder="47170" />
          </Form.Item>
        </Space>

        <Divider orientation="left">项目</Divider>
        <Form.Item label="商机名称" required>
          <Radio.Group value={titleMode} onChange={e => setTitleMode(e.target.value)}
            optionType="button" buttonStyle="solid" style={{ marginBottom: 12 }}>
            <Radio.Button value="auto">自动生成</Radio.Button>
            <Radio.Button value="manual">手动输入</Radio.Button>
          </Radio.Group>

          {titleMode === 'auto' ? (
            <>
              <Form.Item name="projectName" noStyle
                rules={[{ required: titleMode === 'auto', message: '项目名称必填' }]}>
                <Input style={{ maxWidth: 520, display: 'block' }}
                  placeholder="项目描述，如 Application Service Migration" />
              </Form.Item>
              <div style={{ marginTop: 8 }}>
                {autoTitle
                  ? <Text code style={{ fontSize: 13 }}>{autoTitle}</Text>
                  : <Text type="secondary">填完客户名和项目描述后显示预览</Text>}
              </div>
            </>
          ) : (
            <Form.Item name="titleOverride" noStyle
              rules={[{ required: titleMode === 'manual', message: '标题必填' }]}>
              <Input style={{ maxWidth: 640 }}
                placeholder="Webby - Korea Wallpaper (HQ) Application Service Migration #ADPL #HarimauBlitz26" />
            </Form.Item>
          )}
          {/* 手填标题绕开自动生成，缺的标签会在提交时由服务端补上。
              这里提前说明，免得用户以为标题被莫名改写了。 */}
          {titleMode === 'manual' && requiredTags.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <Text type="secondary">
                提交时会自动补齐必填标签 <Text code>{requiredTags.join(' ')}</Text>（已有的不重复添加）
              </Text>
            </div>
          )}
          {titleMode === 'manual' && (
            <div style={{ marginTop: 8 }}>
              <Text type="secondary">下方的 Use Case 和业务描述请按手填标题自行填写，不会从标题自动生成。</Text>
            </div>
          )}
        </Form.Item>

        <Form.Item name="customerUseCase" label="Use Case" rules={[{ required: true }]}
          extra="请自行选择与本次项目相符的 AWS 标准值；不能输入任意文字或简写（如 Migration）">
          <Select style={{ maxWidth: 480 }} showSearch
            options={(meta?.useCases || []).map(v => ({ value: v, label: v }))} />
        </Form.Item>

        <Form.Item name="customerBusinessProblem" label="业务描述"
          rules={[{ required: true, min: 50, message: '至少 50 字 —— AWS 会看描述是否具体' }]}
          extra="按本次商机标题写清客户现状、项目目标、partner 做哪些事、用到哪些 AWS 服务">
          <TextArea rows={6} style={{ maxWidth: 900 }} showCount />
        </Form.Item>

        <Space align="start" wrap size="large">
          <Form.Item name="solutionId" label="关联 Solution"
            rules={[{ required: solutionsState === 'ok' && solutions.length > 0,
              message: '请选择要关联的 Solution' }]}
            extra={solutionsState === 'ok' && solutions.length > 1 && !solutionDefault
              ? '该主体有多个 Active Solution，请选择' : undefined}>
            <Select style={{ width: 400 }} allowClear showSearch optionFilterProp="label"
              loading={solutionsState === 'loading'}
              disabled={solutionsState === 'ok' && solutions.length === 0}
              placeholder={solutionsState === 'loading' ? '加载中…'
                : solutionsState === 'error' ? '查询失败，留空将跳过关联'
                : solutions.length ? '请选择 Solution'
                : '该主体暂无 Active Solution，将跳过关联'}
              options={solutions.map(s => ({ value: s.id, label: `${s.id} — ${s.name}` }))} />
          </Form.Item>
          <Form.Item name="targetCloseDate" label="预计成交日期" rules={[{ required: true }]}>
            <DatePicker style={{ width: 180 }}
              disabledDate={d => !!d && d < dayjs().endOf('day')} />
          </Form.Item>
          <Form.Item name="marketingSource" label="Marketing Source"
            extra="选 Marketing Activity 时必须填右侧 MDF 资金">
            <Select style={{ width: 200 }} options={[
              { value: 'None', label: 'None' },
              { value: 'Marketing Activity', label: 'Marketing Activity' },
            ]} />
          </Form.Item>
          {/* AwsFundingUsed 与 Source 是配对字段：Source='Marketing Activity'
              时必填，否则 AWS 报 ACTION_NOT_PERMITTED。Source='None' 时
              必须省略，所以这里整项隐藏而不是置灰。 */}
          {marketingSource === 'Marketing Activity' && (
            <Form.Item name="marketingAwsFundingUsed" label="用了 AWS MDF 资金？"
              rules={[{ required: true, message: '选 Marketing Activity 时必填' }]}
              extra="AWS 必填项，不填会被拒绝创建">
              <Select style={{ width: 160 }} options={[
                { value: 'No', label: 'No（未用 MDF）' },
                { value: 'Yes', label: 'Yes（MDF 资助）' },
              ]} />
            </Form.Item>
          )}
        </Space>
        {renderAmounts()}
        {renderSubmitSection()}
      </Form>
    </>
  );

  return (
    <Card title={<Space><RocketOutlined />POC Cash</Space>}>
      <Tabs activeKey={tab} onChange={(k) => {
        setTab(k);
        // 首次进入进展 Tab 才拉列表：要逐条 Get 补全，别在页面加载时就跑
        if (k === 'progress' && !pocRows.length && !pocLoading) loadPocRows();
      }} items={[
        { key: 'create', label: '创建商机', children: renderCreateTab() },
        { key: 'stage', label: '商机阶段检查', children: renderStageTab() },
        { key: 'poc', label: 'POC 申请', children: renderPocTab() },
        { key: 'progress', label: 'POC 进展', children: renderProgressTab() },
      ]} />
    </Card>
  );
};

export default PocCashPage;
