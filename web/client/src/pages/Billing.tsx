import React, { useState, useEffect, useMemo } from 'react';
import { Card, Table, Tag, Button, message, DatePicker, Input, Modal, Select, Space, Alert, Progress, Upload } from 'antd';
import { ReloadOutlined, SearchOutlined, FilePdfOutlined, DownloadOutlined, StopOutlined, PlusOutlined, UploadOutlined, HistoryOutlined, EyeOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { api, BillingExportJobView, BillingJobRequestError } from '../api';
import { exportToCSV } from '../utils/export';
import { scanAccountIdsFromXlsx } from '../utils/account-import';

const { RangePicker } = DatePicker;
const HISTORY_PAGE_SIZE = 10;

interface AccountImportSummary {
  fileName: string;
  detectedCount: number;
  matchedCount: number;
  duplicateCount: number;
  scannedCellCount: number;
  sheetCount: number;
  unmatchedAccountIds: string[];
}

const BillingPage: React.FC = () => {
  const [costData, setCostData] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [dateRange, setDateRange] = useState<[dayjs.Dayjs, dayjs.Dayjs]>([dayjs().subtract(1, 'month').startOf('month'), dayjs()]);
  const [totalCost, setTotalCost] = useState(0);
  const [searchText, setSearchText] = useState('');

  // 批量导出账单相关状态
  const [accounts, setAccounts] = useState<any[]>([]);
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
  const [selectedMonths, setSelectedMonths] = useState<string[]>([]);
  const [accountImporting, setAccountImporting] = useState(false);
  const [accountImportSummary, setAccountImportSummary] = useState<AccountImportSummary | null>(null);
  const [exportSubmitting, setExportSubmitting] = useState(false);
  const [exportJobId, setExportJobId] = useState<string | null>(null);
  const [exportJob, setExportJob] = useState<BillingExportJobView | null>(null);
  const [exportCancelling, setExportCancelling] = useState(false);
  const [exportDownloadingJobId, setExportDownloadingJobId] = useState<string | null>(null);
  const [exportPollError, setExportPollError] = useState<string | null>(null);
  const [exportLastUpdatedAt, setExportLastUpdatedAt] = useState<string | null>(null);
  const [historyModalOpen, setHistoryModalOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyJobs, setHistoryJobs] = useState<BillingExportJobView[]>([]);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyTotal, setHistoryTotal] = useState(0);

  // 生成近 12 个月的候选月份
  const monthCandidates = useMemo(() => {
    const arr: { value: string; label: string }[] = [];
    const now = dayjs();
    for (let i = 0; i < 12; i++) {
      const d = now.subtract(i, 'month');
      const value = d.format('YYYY-M');    // 后端解析 YYYY-M 或 YYYY-MM 均可
      const label = d.format('YYYY-MM');
      arr.push({ value, label });
    }
    return arr;
  }, []);

  useEffect(() => { fetchCosts(); loadAccounts(); void loadRecentExportJob(); }, []);

  const loadAccounts = async () => {
    try {
      const res = await api.listAccounts();
      if (res.success) setAccounts(res.data);
    } catch {}
  };

  const loadRecentExportJob = async () => {
    try {
      const res = await api.billingExportJobs({ page: 1, limit: 20, scope: 'mine' });
      const jobs = res.success && Array.isArray(res.data) ? res.data : [];
      const latest = jobs.find(job => ['queued', 'running', 'cancelling'].includes(job.status)) || jobs[0];
      if (latest) {
        const detail = await api.billingExportJob(latest.id);
        if (!detail.success) throw new Error(detail.error || '无法恢复最近的账单导出任务');
        setExportJob(detail.data);
        setExportJobId(detail.data.id);
        setExportLastUpdatedAt(new Date().toISOString());
        setExportPollError(null);
      }
    } catch (error: any) {
      // 账单主页面仍可使用；打开导出界面后可看到连接状态。
      setExportPollError(error?.message || '无法恢复最近的账单导出任务');
    }
  };

  const loadExportHistory = async (page = 1) => {
    setHistoryLoading(true);
    try {
      const res = await api.billingExportJobs({ page, limit: HISTORY_PAGE_SIZE, scope: 'mine' });
      if (!res.success) throw new Error(res.error || '获取导出记录失败');
      setHistoryJobs(res.data || []);
      setHistoryPage(res.pagination.page);
      setHistoryTotal(res.pagination.total);
    } catch (error: any) {
      message.error(error?.message || '获取导出记录失败');
    } finally {
      setHistoryLoading(false);
    }
  };

  // 任务在后台执行；关闭弹窗或页面后仍可通过最新任务恢复。
  useEffect(() => {
    if (!exportJobId) return;
    let stopped = false;
    let inFlight = false;
    let failures = 0;
    let timer: number | undefined;

    const schedule = (delayMs: number) => {
      if (stopped) return;
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => void tick(), Math.min(delayMs, 2_147_000_000));
    };
    const tick = async () => {
      if (stopped || inFlight) return;
      inFlight = true;
      try {
        const res = await api.billingExportJob(exportJobId);
        if (stopped) return;
        if (!res.success) throw new Error(res.error || '获取账单导出进度失败');
        failures = 0;
        const job = res.data;
        setExportJob(job);
        setExportLastUpdatedAt(new Date().toISOString());
        setExportPollError(null);
        if (['queued', 'running', 'cancelling'].includes(job.status)) {
          schedule(document.hidden ? 15_000 : 3_000);
        } else if (job.status !== 'completed') {
          setExportJobId(null);
        }
      } catch (error: any) {
        if (stopped) return;
        const status = error instanceof BillingJobRequestError ? error.status : 0;
        if ([401, 403, 404, 410].includes(status)
          || (status >= 400 && status < 500 && status !== 429)) {
          if (status === 401) return;
          const unavailableMessage = error.message || '账单导出任务已不可访问';
          setExportPollError(unavailableMessage);
          setExportJob((current: any) => current ? {
            ...current,
            status: status === 410 ? 'expired' : 'failed',
            downloadReady: false,
            error: unavailableMessage,
          } : null);
          setExportJobId(null);
          message.error(`${unavailableMessage}，可新建导出任务`);
          return;
        }
        failures += 1;
        setExportPollError(`${error.message || '进度连接异常'}；正在第 ${failures} 次自动重试`);
        const baseDelay = document.hidden ? 15_000 : 3_000;
        const exponentialDelay = Math.min(60_000, baseDelay * (2 ** Math.min(failures, 4)));
        const retryAfterMs = error instanceof BillingJobRequestError ? (error.retryAfterMs || 0) : 0;
        schedule(Math.max(exponentialDelay, retryAfterMs) + Math.floor(Math.random() * 1_000));
      } finally {
        inFlight = false;
      }
    };
    const onVisibilityChange = () => {
      if (document.hidden || stopped) return;
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
      void tick();
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    void tick();
    return () => {
      stopped = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [exportJobId]);

  const fetchCosts = async () => {
    setLoading(true);
    try {
      const start = dateRange[0].format('YYYY-MM-DD');
      const end = dateRange[1].format('YYYY-MM-DD');
      const res = await api.getCostByAccount(start, end);
      if (res.success) {
        setCostData(res.data);
        let total = 0;
        (res.data || []).forEach((p: any) => (p.Groups || []).forEach((g: any) => { total += parseFloat(g.Metrics?.UnblendedCost?.Amount || '0'); }));
        setTotalCost(total);
      } else message.error(res.error);
    } catch (e: any) { message.error(e.message); }
    finally { setLoading(false); }
  };

  const tableData = costData.flatMap((p: any) => (p.Groups || []).map((g: any) => ({
    key: `${p.TimePeriod.Start}-${g.Keys[0]}`, period: `${p.TimePeriod.Start} ~ ${p.TimePeriod.End}`,
    accountId: g.Keys[0], cost: parseFloat(g.Metrics.UnblendedCost.Amount || '0'),
  }))).sort((a, b) => b.cost - a.cost);

  const filtered = tableData.filter(d => !searchText || d.accountId.includes(searchText));

  // 批量导出账单
  const openExportModal = () => {
    if (!exportJob) {
      setSelectedAccountIds([]);
      setSelectedMonths([dayjs().subtract(1, 'month').format('YYYY-M')]);
      setAccountImportSummary(null);
    }
    setExportModalOpen(true);
  };

  const startNewExport = () => {
    setExportJob(null);
    setExportJobId(null);
    setExportPollError(null);
    setExportLastUpdatedAt(null);
    setSelectedAccountIds([]);
    setSelectedMonths([dayjs().subtract(1, 'month').format('YYYY-M')]);
    setAccountImportSummary(null);
  };

  const handleAccountWorkbook = async (file: File) => {
    if (!accounts.length) {
      message.warning('账户列表尚未加载完成，请稍后重试');
      return;
    }

    setAccountImporting(true);
    setAccountImportSummary(null);
    try {
      const result = await scanAccountIdsFromXlsx(file);
      const knownAccountIds = new Set(accounts.map(account => String(account.Id)));
      const matchedAccountIds = result.accountIds.filter(accountId => knownAccountIds.has(accountId));
      const unmatchedAccountIds = result.accountIds.filter(accountId => !knownAccountIds.has(accountId));

      setAccountImportSummary({
        fileName: file.name,
        detectedCount: result.accountIds.length,
        matchedCount: matchedAccountIds.length,
        duplicateCount: result.duplicateCount,
        scannedCellCount: result.scannedCellCount,
        sheetCount: result.sheetCount,
        unmatchedAccountIds,
      });

      if (result.accountIds.length === 0) {
        message.warning('Excel 中未识别到独立的 12 位 AWS 账户 ID');
        return;
      }
      if (matchedAccountIds.length === 0) {
        message.warning('识别到的账户均不在当前平台账户列表中，已保留原选择');
        return;
      }

      setSelectedAccountIds(matchedAccountIds);
      message.success(`已从 Excel 识别并勾选 ${matchedAccountIds.length} 个账户`);
    } catch (error: any) {
      message.error(error?.message || 'Excel 识别失败，请检查文件格式');
    } finally {
      setAccountImporting(false);
    }
  };

  const handleExportInvoices = async () => {
    if (!selectedAccountIds.length) return message.warning('请选择至少一个账号');
    if (!selectedMonths.length) return message.warning('请选择至少一个月份');
    const count = selectedAccountIds.length * selectedMonths.length;
    if (count > 200) return message.warning(`任务过多 (${count})，请分批`);
    setExportSubmitting(true);
    try {
      const res = await api.billingExportSubmit({ accountIds: selectedAccountIds, months: selectedMonths });
      if (!res.success) throw new Error(res.error || '提交失败');
      const job = res.data;
      setExportJob(job);
      setExportJobId(job.id);
      setExportLastUpdatedAt(new Date().toISOString());
      setExportPollError(null);
      message.success(`已提交 ${job.total} 份账单，正在后台执行`);
    } catch (err: any) {
      const activeJobId = err instanceof BillingJobRequestError && err.status === 409
        ? err.details?.activeJobId
        : undefined;
      if (typeof activeJobId === 'string') {
        try {
          const active = await api.billingExportJob(activeJobId);
          if (active.success) {
            const job = active.data;
            setExportJob(job);
            setExportJobId(job.id);
            setExportLastUpdatedAt(new Date().toISOString());
            setExportPollError(null);
            message.warning('你已有进行中的任务，已恢复其进度');
            return;
          }
        } catch (recoveryError: any) {
          message.error(recoveryError.message || '恢复进行中的任务失败');
          return;
        }
      }
      message.error(err.message || '提交失败');
    } finally {
      setExportSubmitting(false);
    }
  };

  const handleCancelExport = () => {
    if (!exportJobId) return;
    Modal.confirm({
      title: '取消账单导出？',
      content: '正在运行的浏览器会被关闭，已生成的临时文件会清理。',
      okText: '确认取消',
      okButtonProps: { danger: true },
      cancelText: '继续执行',
      onOk: async () => {
        setExportCancelling(true);
        try {
          const res = await api.billingExportCancel(exportJobId);
          if (!res.success) throw new Error(res.error || '取消失败');
          const job = res.data;
          setExportJob(job);
          setExportLastUpdatedAt(new Date().toISOString());
          setExportPollError(null);
          message.success(job.status === 'cancelled' ? '任务已取消' : '正在停止任务');
        } catch (err: any) {
          message.error(err.message || '取消失败');
        } finally {
          setExportCancelling(false);
        }
      },
    });
  };

  const handleDownloadExport = async (targetJob: BillingExportJobView | null = exportJob) => {
    if (!targetJob?.id) return;
    const targetJobId = targetJob.id;
    setExportDownloadingJobId(targetJobId);
    try {
      const destination = await api.prepareBillingExportDownload(targetJob.downloadFilename);
      if (destination.cancelled) return;
      // picker 必须是第一个 await；选择保存位置后再鉴权并确认服务器文件仍可下载。
      const latest = await api.billingExportJob(targetJobId);
      if (!latest.success) throw new Error(latest.error || '刷新导出状态失败');
      const job = latest.data;
      if (targetJobId === exportJobId) {
        setExportJob(job);
        setExportLastUpdatedAt(new Date().toISOString());
        setExportPollError(null);
      }
      if (job.status !== 'completed' || !job.downloadReady) {
        if (targetJobId === exportJobId && job.status === 'expired') setExportJobId(null);
        message.warning(job.status === 'expired' ? '该历史导出文件已不可用' : '导出文件尚未就绪');
        return;
      }
      const outcome = await api.downloadBillingExport(targetJobId, job.downloadFilename, destination.fileHandle);
      if (!outcome.cancelled) {
        message.success(outcome.streamed ? '账单压缩包已保存' : '账单压缩包已开始下载');
      }
    } catch (err: any) {
      if (err instanceof BillingJobRequestError && [403, 404, 410].includes(err.status)) {
        if (err.status === 410) {
          setHistoryJobs(current => current.map(job => job.id === targetJobId ? {
            ...job,
            status: 'expired',
            downloadReady: false,
            error: err.message,
          } : job));
        }
        if (targetJobId === exportJobId) {
          setExportJob((current) => current ? {
            ...current,
            status: err.status === 410 ? 'expired' : 'failed',
            downloadReady: false,
            error: err.message,
          } : null);
          setExportJobId(null);
        }
      }
      message.error(err.message || '下载失败');
    } finally {
      setExportDownloadingJobId(null);
    }
  };

  const openExportHistory = () => {
    setHistoryModalOpen(true);
    void loadExportHistory(1);
  };

  const openHistoricalJob = async (job: BillingExportJobView) => {
    try {
      const detail = await api.billingExportJob(job.id);
      if (!detail.success) throw new Error(detail.error || '获取导出详情失败');
      setExportJob(detail.data);
      setExportJobId(detail.data.id);
      setExportLastUpdatedAt(new Date().toISOString());
      setExportPollError(null);
      setHistoryModalOpen(false);
      setExportModalOpen(true);
    } catch (error: any) {
      message.error(error?.message || '获取导出详情失败');
    }
  };

  const taskCount = selectedAccountIds.length * selectedMonths.length;
  const exportActive = !!exportJob && ['queued', 'running', 'cancelling'].includes(exportJob.status);
  const exportPartialSuccess = exportJob?.status === 'completed' && Number(exportJob.failed) > 0;
  const exportDownloadReady = exportJob?.status === 'completed' && exportJob.downloadReady === true;
  const phaseLabels: Record<string, string> = {
    preflight: '环境检查 / 排队',
    capturing: '抓取 AWS 官方账单 PDF',
    packaging: '打包 ZIP',
    ready: '文件已就绪',
  };
  const statusLabels: Record<string, string> = {
    queued: '排队中', running: '执行中', cancelling: '正在取消', cancelled: '已取消',
    completed: '已完成', failed: '失败', interrupted: '服务重启中断', expired: '历史文件不可用',
  };
  const statusColors: Record<string, string> = {
    queued: 'blue', running: 'processing', cancelling: 'orange', cancelled: 'default',
    completed: 'success', failed: 'error', interrupted: 'warning', expired: 'default',
  };
  const failedExportResults = (exportJob?.results || []).filter(result => !result.ok);

  return (
    <div>
      <div className="page-header">
        <div>
          <h2 className="page-header-title">账单分析</h2>
          <p className="page-header-subtitle">按账户查看 AWS 费用分布</p>
        </div>
        <div className="stat-chips" style={{ margin: 0 }}>
          <span className="stat-chip">总费用 <strong>${totalCost.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong></span>
          <span className="stat-chip">账户数 <strong>{new Set(tableData.map(d => d.accountId)).size}</strong></span>
        </div>
      </div>
      <Card size="small" title="账单分析">
        <div className="filter-bar" style={{ justifyContent: 'space-between' }}>
          <Space size={8} wrap>
            <RangePicker value={dateRange} onChange={(d) => { if (d?.[0] && d?.[1]) setDateRange([d[0], d[1]]); }} picker="month" size="small" />
            <Button icon={<ReloadOutlined />} onClick={fetchCosts} loading={loading} type="primary" size="small">查询</Button>
          </Space>
          <Space size={8} wrap>
            <Input placeholder="搜索账户ID..." prefix={<SearchOutlined />} value={searchText} onChange={e => setSearchText(e.target.value)} allowClear size="small" style={{ width: 200 }} />
            <Button size="small" icon={<HistoryOutlined />} onClick={openExportHistory}>导出记录</Button>
            <Button size="small" type="primary" icon={<FilePdfOutlined />} onClick={openExportModal}>
              {exportActive ? '查看导出进度' : exportJob ? '查看最近导出' : '批量导出账单 PDF'}
            </Button>
            <Button size="small" onClick={() => exportToCSV(filtered.map(d => ({ 账期: d.period, 账户: d.accountId, '费用(USD)': d.cost.toFixed(4) })), 'billing')}>导出 CSV</Button>
          </Space>
        </div>
        <Table size="small" dataSource={filtered} loading={loading} pagination={{ pageSize: 20 }} rowKey="key"
          columns={[
            { title: '账期', dataIndex: 'period' },
            { title: '账户 ID', dataIndex: 'accountId', render: (id: string) => <code>{id}</code> },
            { title: '费用', dataIndex: 'cost', sorter: (a: any, b: any) => a.cost - b.cost, render: (c: number) => <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: 'var(--color-text-primary)' }}>${c.toFixed(2)}</span> },
            { title: '占比', key: 'pct', render: (_: any, r: any) => <Tag color="blue">{totalCost > 0 ? ((r.cost / totalCost) * 100).toFixed(1) : 0}%</Tag> },
          ]} />
      </Card>

      {/* 批量导出账单 PDF Modal */}
      <Modal
        title={<span><FilePdfOutlined style={{ marginRight: 6 }} />批量导出账单 PDF</span>}
        open={exportModalOpen}
        onOk={exportJob ? undefined : handleExportInvoices}
        onCancel={() => setExportModalOpen(false)}
        okText={`提交 ${taskCount || 0} 份 PDF`}
        cancelText="关闭"
        confirmLoading={exportSubmitting}
        width={760}
        okButtonProps={{ disabled: !selectedAccountIds.length || !selectedMonths.length || taskCount > 200 }}
        footer={exportJob ? (
          <Space wrap>
            <Button onClick={() => setExportModalOpen(false)}>关闭</Button>
            {exportActive && (
              <Button danger icon={<StopOutlined />} loading={exportCancelling} onClick={handleCancelExport}>
                取消任务
              </Button>
            )}
            {exportDownloadReady && (
              <Button type="primary" icon={<DownloadOutlined />} loading={exportDownloadingJobId === exportJob?.id} onClick={() => void handleDownloadExport(exportJob)}>
                下载 ZIP
              </Button>
            )}
            {!exportActive && (
              <Button icon={<PlusOutlined />} onClick={startNewExport}>新建导出</Button>
            )}
          </Space>
        ) : undefined}
      >
        {exportJob ? (
          <div>
            <div
              role="status"
              aria-live="polite"
              aria-atomic="true"
              style={{ position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0, 0, 0, 0)', whiteSpace: 'nowrap', border: 0 }}
            >
              {exportPartialSuccess ? '导出完成，部分项目失败' : (statusLabels[exportJob.status] || exportJob.status)}；
              {phaseLabels[exportJob.phase] || exportJob.phase}
            </div>
            {exportPollError && exportActive && (
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: 12 }}
                message="进度连接暂时中断"
                description={exportPollError}
              />
            )}
            <Alert
              type={exportPartialSuccess ? 'warning'
                : exportJob.status === 'completed' ? 'success'
                  : ['failed', 'interrupted'].includes(exportJob.status) ? 'error'
                    : exportJob.status === 'expired' ? 'warning' : 'info'}
              showIcon
              style={{ marginBottom: 16 }}
              message={
                <Space wrap>
                  <span>{exportPartialSuccess ? '已完成（部分失败）' : (statusLabels[exportJob.status] || exportJob.status)}</span>
                  <Tag color={exportPartialSuccess ? 'warning' : (statusColors[exportJob.status] || 'default')}>{phaseLabels[exportJob.phase] || exportJob.phase}</Tag>
                </Space>
              }
              description={exportJob.error || (exportPartialSuccess
                ? 'ZIP 已生成；失败项目未写入 PDF，请按下方失败原因排查后单独重试。'
                : exportActive
                  ? '任务在服务器后台运行，关闭此弹窗不会中断；稍后重新打开可恢复进度。'
                  : '任务执行记录已保留。')}
            />
            <Progress
              percent={exportJob.progress || 0}
              status={exportPartialSuccess ? 'normal'
                : exportJob.status === 'completed' ? 'success'
                  : ['failed', 'interrupted'].includes(exportJob.status) ? 'exception'
                    : exportActive ? 'active' : 'normal'}
            />
            <div style={{ marginTop: 12, padding: 12, background: 'var(--color-bg-subtle, #f5f5f5)', borderRadius: 6 }}>
              <Space size={18} wrap>
                {exportJob.createdBy && <span>创建人 <strong>{exportJob.createdBy}</strong></span>}
                <span>进度 <strong>{exportJob.done}/{exportJob.total}</strong></span>
                <span>成功 <strong style={{ color: '#52c41a' }}>{exportJob.ok}</strong></span>
                <span>失败 <strong style={{ color: exportJob.failed ? '#ff4d4f' : undefined }}>{exportJob.failed}</strong></span>
                <span>服务器并发 <strong>{exportJob.effectiveConcurrency}</strong></span>
                {exportJob.queuePosition && <span>队列位置 <strong>{exportJob.queuePosition}</strong></span>}
                {exportJob.etaSeconds && <span>预计剩余 <strong>约 {Math.ceil(exportJob.etaSeconds / 60)} 分钟</strong></span>}
                {exportLastUpdatedAt && <span>最后更新 <strong>{dayjs(exportLastUpdatedAt).format('HH:mm:ss')}</strong></span>}
              </Space>
              {exportJob.status === 'completed' && (
                <div style={{ marginTop: 8, color: 'rgba(0,0,0,0.55)', fontSize: 12 }}>
                  文件大小 {exportJob.fileSize ? `${(exportJob.fileSize / 1024 / 1024).toFixed(1)} MB` : '-'}；
                  服务器长期保留，可从“导出记录”随时重复下载
                </div>
              )}
            </div>
            {failedExportResults.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <div style={{ marginBottom: 8, fontWeight: 500 }}>失败明细（{failedExportResults.length}）</div>
                <Table
                  size="small"
                  rowKey={(row: any) => `${row.accountId}-${row.year}-${row.month}`}
                  dataSource={failedExportResults}
                  pagination={{ pageSize: 5, size: 'small' }}
                  columns={[
                    { title: '账户', dataIndex: 'accountId', width: 130, render: (value: string) => <code>{value}</code> },
                    { title: '月份', key: 'month', width: 90, render: (_: any, row: any) => `${row.year}-${String(row.month).padStart(2, '0')}` },
                    { title: '原因', dataIndex: 'error', ellipsis: true },
                  ]}
                />
              </div>
            )}
          </div>
        ) : (
          <>
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 12 }}
              message="从 AWS Console → Billing → Bills 页面抓取官方账单摘要，后台打包为 ZIP。"
              description="全部使用严格只读会话；实际并发由服务器统一控制。提交后可关闭弹窗，任务总数 ≤ 200。"
            />
            <div style={{ marginBottom: 12 }}>
              <label htmlFor="billing-export-account-select" style={{ display: 'block', marginBottom: 4, fontWeight: 500 }}>
                账号 <span style={{ color: '#999', fontWeight: 400 }}>({selectedAccountIds.length}/{accounts.length})</span>
              </label>
              <Space style={{ marginBottom: 6 }} size={4} wrap>
                <Button size="small" onClick={() => { setSelectedAccountIds(accounts.map(a => a.Id)); setAccountImportSummary(null); }}>全选</Button>
                <Button size="small" onClick={() => { setSelectedAccountIds([]); setAccountImportSummary(null); }}>清空</Button>
                <Upload
                  accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                  maxCount={1}
                  showUploadList={false}
                  beforeUpload={(file) => {
                    void handleAccountWorkbook(file);
                    return Upload.LIST_IGNORE;
                  }}
                >
                  <Button size="small" icon={<UploadOutlined />} loading={accountImporting} disabled={!accounts.length}>
                    上传 Excel 识别
                  </Button>
                </Upload>
              </Space>
              <Select
                id="billing-export-account-select"
                aria-label="选择要导出的 AWS 账户"
                mode="multiple"
                style={{ width: '100%' }}
                placeholder="选择要导出的账号"
                value={selectedAccountIds}
                onChange={(value) => { setSelectedAccountIds(value); setAccountImportSummary(null); }}
                showSearch
                optionFilterProp="label"
                maxTagCount={5}
                options={accounts.map((account: any) => ({
                  label: `${account.Name || account.Id} (${account.Id})`,
                  value: account.Id,
                }))}
              />
              <div style={{ marginTop: 5, color: '#999', fontSize: 12 }}>
                仅读取 .xlsx 的所有工作表并识别独立 12 位账户 ID；文件只在浏览器本地处理，不会上传。含前导零的 ID 请在 Excel 中设为文本。
              </div>
              {accountImportSummary && (
                <Alert
                  type={accountImportSummary.matchedCount > 0 && accountImportSummary.unmatchedAccountIds.length === 0 ? 'success' : 'warning'}
                  showIcon
                  style={{ marginTop: 8 }}
                  message={`Excel 识别：匹配 ${accountImportSummary.matchedCount}/${accountImportSummary.detectedCount} 个账户`}
                  description={(
                    <div>
                      <div>
                        {accountImportSummary.fileName} · {accountImportSummary.sheetCount} 个工作表 · 扫描 {accountImportSummary.scannedCellCount.toLocaleString()} 个单元格
                        {accountImportSummary.duplicateCount > 0 ? ` · 忽略 ${accountImportSummary.duplicateCount} 个重复 ID` : ''}
                      </div>
                      {accountImportSummary.unmatchedAccountIds.length > 0 && (
                        <div style={{ marginTop: 4 }}>
                          平台未匹配 {accountImportSummary.unmatchedAccountIds.length} 个：
                          <code>{accountImportSummary.unmatchedAccountIds.slice(0, 10).join(', ')}</code>
                          {accountImportSummary.unmatchedAccountIds.length > 10 ? '…' : ''}
                        </div>
                      )}
                    </div>
                  )}
                />
              )}
            </div>
            <div style={{ marginBottom: 12 }}>
              <label htmlFor="billing-export-month-select" style={{ display: 'block', marginBottom: 4, fontWeight: 500 }}>
                月份 <span style={{ color: '#999', fontWeight: 400 }}>({selectedMonths.length} 个)</span>
              </label>
              <Space style={{ marginBottom: 6 }} size={4} wrap>
                <Button size="small" onClick={() => setSelectedMonths(monthCandidates.slice(0, 3).map(month => month.value))}>近 3 个月</Button>
                <Button size="small" onClick={() => setSelectedMonths(monthCandidates.slice(0, 6).map(month => month.value))}>近 6 个月</Button>
                <Button size="small" onClick={() => setSelectedMonths(monthCandidates.map(month => month.value))}>近 12 个月</Button>
                <Button size="small" onClick={() => setSelectedMonths([])}>清空</Button>
              </Space>
              <Select
                id="billing-export-month-select"
                aria-label="选择账单月份"
                mode="multiple"
                style={{ width: '100%' }}
                placeholder="选择月份"
                value={selectedMonths}
                onChange={setSelectedMonths}
                options={monthCandidates}
              />
            </div>
            {taskCount > 0 && (
              <div style={{ marginTop: 14, padding: 10, background: 'var(--color-bg-subtle, #f5f5f5)', borderRadius: 4, fontSize: 12 }}>
                <div>总任务：<strong>{taskCount}</strong> 份 PDF（{selectedAccountIds.length} 个账号 × {selectedMonths.length} 个月份）</div>
                <div>执行方式：服务器有界并发，实时进度与动态剩余时间以任务状态为准。</div>
                {taskCount > 200 && <div style={{ color: 'var(--color-danger, #ff4d4f)' }}>超出 200 上限，请减少账号或月份。</div>}
              </div>
            )}
          </>
        )}
      </Modal>

      <Modal
        title={<span><HistoryOutlined style={{ marginRight: 6 }} />账单导出记录</span>}
        open={historyModalOpen}
        onCancel={() => setHistoryModalOpen(false)}
        width={980}
        footer={(
          <Space>
            <Button icon={<ReloadOutlined />} loading={historyLoading} onClick={() => void loadExportHistory(historyPage)}>刷新</Button>
            <Button onClick={() => setHistoryModalOpen(false)}>关闭</Button>
          </Space>
        )}
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="导出记录与 ZIP 在服务器长期保留"
          description="这里显示当前用户的全部历史任务；已完成且文件可用的记录可以随时重复下载。"
        />
        <Table<BillingExportJobView>
          size="small"
          rowKey="id"
          loading={historyLoading}
          dataSource={historyJobs}
          pagination={{
            current: historyPage,
            pageSize: HISTORY_PAGE_SIZE,
            total: historyTotal,
            showSizeChanger: false,
            showTotal: total => `共 ${total} 条记录`,
            onChange: page => void loadExportHistory(page),
          }}
          columns={[
            {
              title: '创建时间',
              dataIndex: 'createdAt',
              width: 150,
              render: (value: string) => dayjs(value).format('YYYY-MM-DD HH:mm'),
            },
            {
              title: '状态',
              dataIndex: 'status',
              width: 120,
              render: (value: string, record) => (
                <Tag color={record.status === 'completed' && record.failed > 0 ? 'warning' : (statusColors[value] || 'default')}>
                  {record.status === 'completed' && record.failed > 0 ? '完成（部分失败）' : (statusLabels[value] || value)}
                </Tag>
              ),
            },
            { title: '任务数', dataIndex: 'total', width: 75 },
            {
              title: '结果',
              key: 'result',
              width: 120,
              render: (_value, record) => <span><span style={{ color: '#52c41a' }}>{record.ok} 成功</span> / <span style={{ color: record.failed ? '#ff4d4f' : undefined }}>{record.failed} 失败</span></span>,
            },
            {
              title: 'ZIP 大小',
              dataIndex: 'fileSize',
              width: 100,
              render: (value?: number) => value ? `${(value / 1024 / 1024).toFixed(1)} MB` : '-',
            },
            {
              title: '操作',
              key: 'actions',
              width: 190,
              render: (_value, record) => (
                <Space size={4}>
                  <Button size="small" icon={<EyeOutlined />} onClick={() => void openHistoricalJob(record)}>详情</Button>
                  <Button
                    size="small"
                    type="primary"
                    icon={<DownloadOutlined />}
                    disabled={!record.downloadReady}
                    loading={exportDownloadingJobId === record.id}
                    onClick={() => void handleDownloadExport(record)}
                  >
                    下载
                  </Button>
                </Space>
              ),
            },
          ]}
        />
      </Modal>
    </div>
  );
};

export default BillingPage;
