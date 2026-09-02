import React, { useState, useEffect, useMemo } from 'react';
import { Card, Table, Tag, Button, message, DatePicker, Input, Modal, Select, InputNumber, Space, Alert, Upload } from 'antd';
import { ReloadOutlined, SearchOutlined, FilePdfOutlined, UploadOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { api } from '../api';
import { exportToCSV } from '../utils/export';
import { scanAccountIdsFromXlsx } from '../utils/account-import';
const { RangePicker } = DatePicker;

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
  const [concurrency, setConcurrency] = useState<number>(10);
  const [exporting, setExporting] = useState(false);
  const [accountImporting, setAccountImporting] = useState(false);
  const [accountImportSummary, setAccountImportSummary] = useState<AccountImportSummary | null>(null);
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
  useEffect(() => { fetchCosts(); loadAccounts(); }, []);
  const loadAccounts = async () => {
    try {
      const res = await api.listAccounts();
      if (res.success) setAccounts(res.data);
    } catch {}
  };
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
    setSelectedAccountIds([]);
    setSelectedMonths([dayjs().subtract(1, 'month').format('YYYY-M')]);
    setConcurrency(10);
    setAccountImportSummary(null);
    setExportModalOpen(true);
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
    const taskCount = selectedAccountIds.length * selectedMonths.length;
    if (taskCount > 200) return message.warning(`任务过多 (${taskCount})，请分批`);
    setExporting(true);
    const hide = message.loading(`正在导出 ${taskCount} 份账单 PDF（预计 ${Math.ceil(taskCount * 15 / concurrency)} 秒）...`, 0);
    try {
      const summary = await api.exportBillingInvoices({
        accountIds: selectedAccountIds,
        months: selectedMonths,
        concurrency,
      });
      hide();
      message.success(`导出完成 (${summary})`);
      setExportModalOpen(false);
    } catch (err: any) {
      hide();
      message.error(err.message || '导出失败');
    } finally {
      setExporting(false);
    }
  };
  const taskCount = selectedAccountIds.length * selectedMonths.length;
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
            <Button size="small" type="primary" icon={<FilePdfOutlined />} onClick={openExportModal}>批量导出账单 PDF</Button>
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
        onOk={handleExportInvoices}
        onCancel={() => setExportModalOpen(false)}
        okText={`导出 ${taskCount || 0} 份 PDF`}
        cancelText="取消"
        confirmLoading={exporting}
        width={720}
        okButtonProps={{ disabled: !selectedAccountIds.length || !selectedMonths.length || taskCount > 200 }}
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="从 AWS Console → Billing → Bills 页面抓取官方账单摘要，打包为 zip 下载。"
          description="账号已加密免登录访问；每份约需 10-20 秒。任务总数 ≤ 200。"
        />
        <div style={{ marginBottom: 12 }}>
          <div style={{ marginBottom: 4, fontWeight: 500 }}>账号 <span style={{ color: '#999', fontWeight: 400 }}>({selectedAccountIds.length}/{accounts.length})</span></div>
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
            mode="multiple"
            style={{ width: '100%' }}
            placeholder="选择要导出的账号"
            value={selectedAccountIds}
            onChange={(value) => { setSelectedAccountIds(value); setAccountImportSummary(null); }}
            showSearch
            optionFilterProp="label"
            maxTagCount={5}
            options={accounts.map((a: any) => ({
              label: `${a.Name || a.Id} (${a.Id})`,
              value: a.Id,
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
          <div style={{ marginBottom: 4, fontWeight: 500 }}>月份 <span style={{ color: '#999', fontWeight: 400 }}>({selectedMonths.length} 个)</span></div>
          <Space style={{ marginBottom: 6 }} size={4}>
            <Button size="small" onClick={() => setSelectedMonths(monthCandidates.slice(0, 3).map(m => m.value))}>近 3 个月</Button>
            <Button size="small" onClick={() => setSelectedMonths(monthCandidates.slice(0, 6).map(m => m.value))}>近 6 个月</Button>
            <Button size="small" onClick={() => setSelectedMonths(monthCandidates.map(m => m.value))}>近 12 个月</Button>
            <Button size="small" onClick={() => setSelectedMonths([])}>清空</Button>
          </Space>
          <Select
            mode="multiple"
            style={{ width: '100%' }}
            placeholder="选择月份"
            value={selectedMonths}
            onChange={setSelectedMonths}
            options={monthCandidates}
          />
        </div>
        <div>
          <div style={{ marginBottom: 4, fontWeight: 500 }}>并发数</div>
          <InputNumber min={1} max={15} value={concurrency} onChange={v => setConcurrency(v || 10)} style={{ width: 120 }} />
          <span style={{ color: '#999', marginLeft: 12, fontSize: 12 }}>建议 10，最大 15</span>
        </div>
        {taskCount > 0 && (
          <div style={{ marginTop: 14, padding: 10, background: 'var(--color-bg-subtle, #f5f5f5)', borderRadius: 4, fontSize: 12 }}>
            <div>总任务: <strong>{taskCount}</strong> 份 PDF ({selectedAccountIds.length} 账号 × {selectedMonths.length} 月份)</div>
            <div>预估耗时: <strong>{Math.ceil(taskCount * 15 / concurrency)}</strong> 秒（并发 {concurrency}，每份约 15s）</div>
            {taskCount > 200 && <div style={{ color: 'var(--color-danger, #ff4d4f)' }}>⚠️ 超出 200 上限，请减少</div>}
          </div>
        )}
      </Modal>
    </div>
  );
};
export default BillingPage;
