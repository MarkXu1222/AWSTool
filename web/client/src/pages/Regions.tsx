import React, { useState, useEffect, useMemo } from 'react';
import { Card, Table, Tag, Button, Space, message, Checkbox, Popconfirm, Progress, Input, Alert, Tabs, Select, Tooltip } from 'antd';
import { GlobalOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { api } from '../api';
import { exportToCSV } from '../utils/export';

const OPT_IN_REGIONS = [
  'af-south-1', 'ap-east-1', 'ap-east-2', 'ap-south-2', 'ap-southeast-3',
  'ap-southeast-4', 'ap-southeast-5', 'ap-southeast-6', 'ap-southeast-7',
  'ca-west-1', 'eu-central-2', 'eu-south-1', 'eu-south-2',
  'il-central-1', 'me-central-1', 'me-south-1', 'mx-central-1',
];

// 区域中文名
const REGION_CN: Record<string, string> = {
  'af-south-1': '开普敦（南非）',
  'ap-east-1': '香港', 'ap-east-2': '台北',
  'ap-south-2': '海得拉巴（印度）',
  'ap-southeast-3': '雅加达（印尼）',
  'ap-southeast-4': '墨尔本（澳大利亚）',
  'ap-southeast-5': '马来西亚',
  'ap-southeast-6': '新西兰',
  'ap-southeast-7': '泰国',
  'ca-west-1': '卡尔加里（加拿大）',
  'eu-central-2': '苏黎世（瑞士）',
  'eu-south-1': '米兰（意大利）',
  'eu-south-2': '西班牙',
  'il-central-1': '特拉维夫（以色列）',
  'me-central-1': '阿联酋',
  'me-south-1': '巴林',
  'mx-central-1': '墨西哥',
};

const RegionsPage: React.FC = () => {
  const [regionData, setRegionData] = useState<any[]>([]);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanningPayer, setScanningPayer] = useState<string | null>(null);
  const [selectedAccounts, setSelectedAccounts] = useState<string[]>([]);
  const [enabling, setEnabling] = useState(false);
  const [expandedRegion, setExpandedRegion] = useState<string | null>(null);
  const [searchText, setSearchText] = useState('');
  const [viewMode, setViewMode] = useState<'regions' | 'account'>('regions');
  const [selectedAccountRegions, setSelectedAccountRegions] = useState<string[]>([]);
  // 按组织查看
  const [selectedPayer, setSelectedPayer] = useState<string | null>(null);
  const [payerOnlyGaps, setPayerOnlyGaps] = useState(true);
  // 已移出组织的账户（它们的区域数据仍在库里，会聚成「未知组织」）
  const [departed, setDeparted] = useState<any[]>([]);

  useEffect(() => { loadData(); }, []);

  const loadData = async () => {
    try {
      const [regRes, acctRes, depRes] = await Promise.all([
        api.getRegionStatus(),
        api.listAccounts(),
        api.getDepartedAccounts().catch(() => ({ success: false })),
      ]);
      if (regRes.success) setRegionData(regRes.data || []);
      if (acctRes.success) setAccounts(acctRes.data || []);
      if (depRes.success) setDeparted((depRes.data?.records || []).filter((r: any) => !r.rejoined_at));
    } catch {}
  };

  const handleScan = async () => {
    setScanning(true);
    message.info('正在扫描所有账户区域状态...');
    try {
      const res = await api.scanRegions();
      if (res.success) { setRegionData(res.data || []); message.success(`扫描完成`); }
      else message.error(res.error);
    } catch (e: any) { message.error(e.message); }
    finally { setScanning(false); }
  };

  const handleScanForPayer = async (group: { payer: string; accounts: { accountId: string }[] }) => {
    const accountIds = [...new Set(group.accounts.map(account => account.accountId).filter(Boolean))];
    if (accountIds.length === 0) {
      message.warning('该组织没有可扫描的账户');
      return;
    }

    setScanningPayer(group.payer);
    message.info(`正在扫描 ${group.payer} 的 ${accountIds.length} 个账户...`);
    try {
      const res = await api.scanRegions(accountIds);
      if (!res.success) {
        message.error(res.error || '组织扫描失败');
        return;
      }

      setRegionData(res.data || []);
      const scanned = Number(res.scanned ?? 0);
      if (scanned < accountIds.length) {
        message.warning(`${group.payer} 扫描完成：成功 ${scanned}/${accountIds.length} 个账户`);
      } else {
        message.success(`${group.payer} 扫描完成：${scanned} 个账户`);
      }
    } catch (e: any) { message.error(e.message); }
    finally { setScanningPayer(null); }
  };

  const handleBatchEnable = async (region: string) => {
    if (selectedAccounts.length === 0) { message.warning('请选择账户'); return; }
    setEnabling(true);
    try {
      const res = await api.enableRegionBatch(selectedAccounts, region);
      if (res.success) {
        const ok = res.data.filter((r: any) => r.success).length;
        message.success(`${ok} 个账户已提交启用 ${region}`);
        setSelectedAccounts([]);
        loadData();
      } else message.error(res.error);
    } catch (e: any) { message.error(e.message); }
    finally { setEnabling(false); }
  };

  const handleSingleEnable = async (accountId: string, region: string) => {
    try {
      const res = await api.enableRegion(accountId, region);
      if (res.success) { message.success(`${region} 启用中`); loadData(); }
      else message.error(res.error);
    } catch (e: any) { message.error(e.message); }
  };

  const departedIds = useMemo(() => new Set(departed.map(d => d.account_id)), [departed]);
  const scannedAccountIds = useMemo(
    () => new Set(regionData.map(rd => rd.account_id)),
    [regionData],
  );
  const unscannedAccountCount = useMemo(
    () => accounts.filter(account => account.Id && !departedIds.has(account.Id) && !scannedAccountIds.has(account.Id)).length,
    [accounts, departedIds, scannedAccountIds],
  );

  // 组织与账户以 accounts_cache 为准，region_data 只补充扫描结果。
  // 这样新组织在首次区域扫描前也能立即显示，且未扫描不会被误算为未开通。
  const payerGroups = useMemo(() => {
    type GroupAccount = {
      accountId: string;
      name: string;
      scanned: boolean;
      enabled: string[];
      disabled: string[];
      enabling: string[];
    };
    type Group = {
      payer: string;
      accounts: GroupAccount[];
      enabled: number;
      disabled: number;
      enabling: number;
      regionGaps: Map<string, string[]>;
    };

    const groups = new Map<string, Group>();
    const groupAccountById = new Map<string, { group: Group; account: GroupAccount }>();

    accounts.forEach(acct => {
      const accountId = String(acct.Id || '');
      if (!accountId || departedIds.has(accountId) || groupAccountById.has(accountId)) return;

      const payer = acct._payer || '(未知组织)';
      let group = groups.get(payer);
      if (!group) {
        group = { payer, accounts: [], enabled: 0, disabled: 0, enabling: 0, regionGaps: new Map() };
        groups.set(payer, group);
      }

      const account: GroupAccount = {
        accountId,
        name: acct.Name || accountId,
        scanned: false,
        enabled: [],
        disabled: [],
        enabling: [],
      };
      group.accounts.push(account);
      groupAccountById.set(accountId, { group, account });
    });

    regionData.forEach(rd => {
      if (departedIds.has(rd.account_id)) return;
      const joined = groupAccountById.get(rd.account_id);
      // 只合并当前账户；离场或无法归属的历史区域数据不污染活跃组织统计。
      if (!joined) return;

      const { group, account } = joined;
      account.scanned = true;
      (rd.regions || []).forEach((r: any) => {
        if (!OPT_IN_REGIONS.includes(r.region)) return;
        if (r.status === 'ENABLED') {
          account.enabled.push(r.region);
          group.enabled++;
        } else if (r.status === 'ENABLING') {
          account.enabling.push(r.region);
          group.enabling++;
        } else if (r.status === 'DISABLED') {
          account.disabled.push(r.region);
          group.disabled++;
          group.regionGaps.set(r.region, [...(group.regionGaps.get(r.region) || []), rd.account_id]);
        }
      });
    });

    return [...groups.values()]
      .map(group => {
        const scannedAccounts = group.accounts.filter(account => account.scanned).length;
        const slots = group.enabled + group.disabled + group.enabling;
        return {
          ...group,
          accountCount: group.accounts.length,
          scannedAccounts,
          unscannedAccounts: group.accounts.length - scannedAccounts,
          gapAccounts: group.accounts.filter(account => account.scanned && account.disabled.length > 0).length,
          slots,
          rate: slots > 0 ? Math.round((group.enabled / slots) * 100) : 0,
        };
      })
      .sort((a, b) => b.disabled - a.disabled || b.unscannedAccounts - a.unscannedAccounts || a.payer.localeCompare(b.payer));
  }, [accounts, regionData, departedIds]);

  // 已离场账户里，遗留了区域数据的那些 —— 展示出来解释这批数据的来历
  const departedWithRegions = useMemo(() => {
    const rdById = new Map(regionData.map((r: any) => [r.account_id, r]));
    return departed
      .filter(d => rdById.has(d.account_id))
      .map(d => {
        const rd: any = rdById.get(d.account_id);
        const optIn = (rd.regions || []).filter((r: any) => OPT_IN_REGIONS.includes(r.region));
        return {
          ...d,
          regionCount: optIn.length,
          enabledCount: optIn.filter((r: any) => r.status === 'ENABLED').length,
          lastScan: rd.updated_at,
        };
      });
  }, [departed, regionData]);

  const currentGroup = useMemo(
    () => payerGroups.find(g => g.payer === selectedPayer) || null,
    [payerGroups, selectedPayer],
  );

  // 选中组织的区域维度：每个区域在该组织内的开通情况
  const currentGroupRegions = useMemo(() => {
    if (!currentGroup) return [];
    return OPT_IN_REGIONS.map(region => {
      let enabled = 0, disabled = 0, enabling = 0;
      currentGroup.accounts.forEach(a => {
        if (a.enabled.includes(region)) enabled++;
        else if (a.enabling.includes(region)) enabling++;
        else if (a.disabled.includes(region)) disabled++;
      });
      return {
        region, enabled, disabled, enabling,
        total: enabled + disabled + enabling,
        gapAccountIds: currentGroup.regionGaps.get(region) || [],
      };
    }).filter(r => !payerOnlyGaps || r.disabled > 0);
  }, [currentGroup, payerOnlyGaps]);

  // 为整个组织启用某区域（只对该组织内未开通的账户下发）
  const handleEnableForPayer = async (region: string, accountIds: string[]) => {
    if (accountIds.length === 0) return;
    setEnabling(true);
    try {
      const res = await api.enableRegionBatch(accountIds, region);
      if (res.success) {
        const ok = res.data.filter((r: any) => r.success).length;
        const failed = res.data.filter((r: any) => !r.success);
        if (failed.length > 0) {
          message.warning(`${ok}/${accountIds.length} 个账户已提交启用 ${region}，${failed.length} 个失败：${failed[0].error?.slice(0, 60) || ''}`);
        } else {
          message.success(`${ok} 个账户已提交启用 ${region}`);
        }
        loadData();
      } else message.error(res.error);
    } catch (e: any) { message.error(e.message); }
    finally { setEnabling(false); }
  };

  // Build summary: for each opt-in region, count enabled/disabled
  const regionSummary = OPT_IN_REGIONS.map(region => {
    let enabled = 0, disabled = 0, enabling = 0;
    regionData.forEach(rd => {
      const info = (rd.regions || []).find((r: any) => r.region === region);
      if (info) {
        if (info.status === 'ENABLED') enabled++;
        else if (info.status === 'DISABLED') disabled++;
        else if (info.status === 'ENABLING') enabling++;
      }
    });
    return { region, enabled, disabled, enabling, total: enabled + disabled + enabling };
  });

  // Get disabled accounts for a specific region
  const getDisabledForRegion = (region: string) => {
    return regionData
      .filter(rd => (rd.regions || []).some((r: any) => r.region === region && r.status === 'DISABLED'))
      .map(rd => {
        const acct = accounts.find(a => a.Id === rd.account_id);
        return { accountId: rd.account_id, name: acct?.Name || rd.account_id, payer: acct?._payer || '' };
      });
  };

  // Get disabled regions for a specific account
  const getAccountRegionStatus = (accountId: string) => {
    const rd = regionData.find(r => r.account_id === accountId);
    if (!rd) return [];
    return (rd.regions || []).map((r: any) => ({ ...r, accountId }));
  };

  // Search filtered accounts
  const searchedAccounts = accounts.filter(a =>
    searchText && (a.Id?.includes(searchText) || a.Name?.toLowerCase().includes(searchText.toLowerCase()))
  );

  // Handle batch enable regions for single account
  const handleEnableRegionsForAccount = async (accountId: string, regions: string[]) => {
    setEnabling(true);
    try {
      for (const region of regions) {
        await api.enableRegion(accountId, region);
      }
      message.success(`${regions.length} 个区域已提交启用`);
      setSelectedAccountRegions([]);
      loadData();
    } catch (e: any) { message.error(e.message); }
    finally { setEnabling(false); }
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <h2 className="page-header-title">区域管理</h2>
          <p className="page-header-subtitle">管理 opt-in 区域开通状态（默认区域 us-east-1/us-west-2/eu-west-1/ap-southeast-1 等已自动开通）</p>
        </div>
        <Button icon={<ReloadOutlined />} onClick={handleScan} loading={scanning} disabled={scanningPayer !== null} size="small">
          {scanning ? '扫描中...' : '扫描所有账户'}
        </Button>
      </div>

      <Alert message="仅显示需手动开通的 opt-in 区域，默认区域（us-east-1, ap-southeast-1 等）已自动启用" type="info" style={{ marginBottom: 12 }} />

      {accounts.length === 0 && regionData.length === 0 ? (
        <Card size="small">
          <div style={{ textAlign: 'center', padding: 40, color: '#8a94a6' }}>
            <GlobalOutlined style={{ fontSize: 32, marginBottom: 8 }} />
            <p>暂无数据，请点击「扫描所有账户」获取区域状态</p>
          </div>
        </Card>
      ) : (
        <Tabs items={[
          {
            key: 'regions', label: '按区域查看',
            children: (<>
          {/* 区域总览表 */}
          <Card size="small" bodyStyle={{ padding: 0 }}>
            <Table size="small" dataSource={regionSummary} rowKey="region" pagination={false}
              columns={[
                { title: '区域', dataIndex: 'region', width: 150, render: (r: string) => <code style={{ fontSize: 12 }}>{r}</code> },
                { title: '名称', dataIndex: 'region', key: 'cn', width: 150, render: (r: string) => <span style={{ fontSize: 13 }}>{REGION_CN[r] || '-'}</span> },
                { title: '已开通', dataIndex: 'enabled', width: 80, align: 'center', render: (n: number) => <Tag color="green">{n}</Tag> },
                { title: '启用中', dataIndex: 'enabling', width: 80, align: 'center', render: (n: number) => n > 0 ? <Tag color="blue">{n}</Tag> : <span style={{ color: '#b6bdca' }}>0</span> },
                { title: '未开通', dataIndex: 'disabled', width: 80, align: 'center', render: (n: number) => n > 0 ? <Tag color="red">{n}</Tag> : <span style={{ color: '#b6bdca' }}>0</span> },
                { title: '开通率', key: 'rate', width: 120, render: (_: any, r: any) => r.total > 0 ? <Progress percent={Math.round((r.enabled / r.total) * 100)} size="small" strokeColor="#52c41a" /> : '-' },
                { title: '操作', key: 'action', width: 100, fixed: 'right' as const, render: (_: any, r: any) => r.disabled > 0 ? (
                  <Button size="small" type="link" onClick={() => setExpandedRegion(expandedRegion === r.region ? null : r.region)}>
                    {expandedRegion === r.region ? '收起' : `查看 (${r.disabled})`}
                  </Button>
                ) : unscannedAccountCount > 0
                  ? <Tooltip title={`还有 ${unscannedAccountCount} 个账户尚未扫描`}><span style={{ color: '#d46b08' }}>等待扫描</span></Tooltip>
                  : <span style={{ color: '#b6bdca' }}>全部开通</span> },
              ]}
              scroll={{ x: 780 }}
            />
          </Card>

          {/* 展开的未开通账户列表 */}
          {expandedRegion && (
            <Card size="small" title={`${expandedRegion} — 未开通账户`} style={{ marginTop: 12 }}
              extra={
                selectedAccounts.length > 0 ? (
                  <Popconfirm title={`确定为 ${selectedAccounts.length} 个账户启用 ${expandedRegion}？`}
                    onConfirm={() => handleBatchEnable(expandedRegion)} okText="启用" cancelText="取消">
                    <Button type="primary" size="small" loading={enabling}>批量启用 ({selectedAccounts.length})</Button>
                  </Popconfirm>
                ) : null
              }>
              <Space style={{ marginBottom: 8 }}>
                <Button size="small" onClick={() => setSelectedAccounts(getDisabledForRegion(expandedRegion).map(d => d.accountId))}>全选</Button>
                <Button size="small" onClick={() => setSelectedAccounts([])}>取消</Button>
              </Space>
              <Table size="small" dataSource={getDisabledForRegion(expandedRegion)} rowKey="accountId" pagination={{ pageSize: 20, size: 'small' }}
                columns={[
                  { title: '', width: 35, render: (_: any, r: any) => (
                    <Checkbox checked={selectedAccounts.includes(r.accountId)}
                      onChange={e => { if (e.target.checked) setSelectedAccounts([...selectedAccounts, r.accountId]); else setSelectedAccounts(selectedAccounts.filter(id => id !== r.accountId)); }} />
                  )},
                  { title: '账户 ID', dataIndex: 'accountId', width: 120, render: (id: string) => <code style={{ fontSize: 12 }}>{id}</code> },
                  { title: '名称', dataIndex: 'name' },
                  { title: '组织', dataIndex: 'payer', width: 90, render: (p: string) => <Tag>{p}</Tag> },
                  { title: '操作', width: 70, render: (_: any, r: any) => (
                    <Popconfirm title={`启用 ${expandedRegion}?`} onConfirm={() => handleSingleEnable(r.accountId, expandedRegion)} okText="启用">
                      <Button size="small" type="link">启用</Button>
                    </Popconfirm>
                  )},
                ]}
              />
            </Card>
          )}
        </>),
          },
          {
            key: 'account', label: '按账户查看',
            children: (
              <>
                <Input placeholder="搜索账户 ID 或名称..." prefix={<SearchOutlined />} value={searchText}
                  onChange={e => setSearchText(e.target.value)} allowClear size="small" style={{ marginBottom: 12, width: 320 }} />

                {searchText && searchedAccounts.length > 0 && searchedAccounts.slice(0, 5).map(acct => {
                  const acctRegions = getAccountRegionStatus(acct.Id);
                  const scanned = scannedAccountIds.has(acct.Id);
                  const disabled = acctRegions.filter((r: any) => r.status === 'DISABLED');
                  const enabled = acctRegions.filter((r: any) => r.status === 'ENABLED' || r.status === 'ENABLING');

                  return (
                    <Card key={acct.Id} size="small" style={{ marginBottom: 8 }}
                      title={<span><code>{acct.Id}</code> — <strong>{acct.Name}</strong> <Tag>{acct._payer}</Tag></span>}
                      extra={
                        scanned && selectedAccountRegions.length > 0 ? (
                          <Popconfirm title={`启用 ${selectedAccountRegions.length} 个区域？`}
                            onConfirm={() => handleEnableRegionsForAccount(acct.Id, selectedAccountRegions)}>
                            <Button size="small" type="primary" loading={enabling}>批量启用 ({selectedAccountRegions.length})</Button>
                          </Popconfirm>
                        ) : null
                      }>
                      {scanned ? (
                        <p style={{ marginBottom: 8, color: '#6B7280', fontSize: 12 }}>
                          已开通: <Tag color="green">{enabled.length}</Tag> 未开通: <Tag color="red">{disabled.length}</Tag>
                        </p>
                      ) : (
                        <Alert type="warning" showIcon message="该账户尚未扫描，区域状态未知" style={{ marginBottom: 8 }} />
                      )}
                      {disabled.length > 0 && (
                        <>
                          <Space style={{ marginBottom: 6 }}>
                            <Button size="small" onClick={() => setSelectedAccountRegions(disabled.map((r: any) => r.region))}>全选未开通</Button>
                            <Button size="small" onClick={() => setSelectedAccountRegions([])}>取消</Button>
                          </Space>
                          <Table size="small" dataSource={disabled} rowKey="region" pagination={false}
                            columns={[
                              { title: '', width: 30, render: (_: any, r: any) => (
                                <Checkbox checked={selectedAccountRegions.includes(r.region)}
                                  onChange={e => { if (e.target.checked) setSelectedAccountRegions([...selectedAccountRegions, r.region]); else setSelectedAccountRegions(selectedAccountRegions.filter(id => id !== r.region)); }} />
                              )},
                              { title: '区域', dataIndex: 'region', render: (r: string) => <span><code>{r}</code> <span style={{ color: 'rgba(0,0,0,0.45)', fontSize: 12 }}>{REGION_CN[r] || ''}</span></span> },
                              { title: '状态', dataIndex: 'status', width: 80, render: (s: string) => <Tag color="red">{s}</Tag> },
                              { title: '', width: 60, render: (_: any, r: any) => (
                                <Popconfirm title={`启用 ${r.region}?`} onConfirm={() => handleSingleEnable(acct.Id, r.region)}>
                                  <Button size="small" type="link">启用</Button>
                                </Popconfirm>
                              )},
                            ]} />
                        </>
                      )}
                      {scanned && disabled.length === 0 && <p style={{ color: '#52c41a' }}>所有 opt-in 区域已开通 ✓</p>}
                    </Card>
                  );
                })}

                {searchText && searchedAccounts.length === 0 && <p style={{ color: '#8a94a6', padding: 20, textAlign: 'center' }}>未找到匹配的账户</p>}
                {!searchText && <p style={{ color: '#8a94a6', padding: 20, textAlign: 'center' }}>输入账户 ID 或名称搜索</p>}
              </>
            ),
          },
          {
            key: 'payer', label: `按组织查看 (${payerGroups.length})`,
            children: (
              <>
                {/* 组织汇总 —— 缺口多的排前面 */}
                <Card size="small" bodyStyle={{ padding: 0 }}>
                  <Table
                    size="small"
                    dataSource={payerGroups}
                    rowKey="payer"
                    pagination={{ pageSize: 12, size: 'small', showTotal: t => `共 ${t} 个组织` }}
                    rowClassName={(r: any) => r.payer === selectedPayer ? 'ant-table-row-selected' : ''}
                    onRow={(r: any) => ({
                      onClick: () => setSelectedPayer(r.payer === selectedPayer ? null : r.payer),
                      style: { cursor: 'pointer' },
                    })}
                    columns={[
                      {
                        title: '组织', dataIndex: 'payer', width: 190,
                        sorter: (a: any, b: any) => a.payer.localeCompare(b.payer),
                        render: (p: string) => <Tag style={{ margin: 0 }}>{p}</Tag>,
                      },
                      {
                        title: '账户数', dataIndex: 'accountCount', width: 80, align: 'center' as const,
                        sorter: (a: any, b: any) => a.accountCount - b.accountCount,
                        render: (n: number) => <span style={{ fontSize: 12 }}>{n}</span>,
                      },
                      {
                        title: '扫描覆盖', key: 'scanCoverage', width: 150, align: 'center' as const,
                        sorter: (a: any, b: any) => a.scannedAccounts - b.scannedAccounts,
                        render: (_: any, r: any) => r.unscannedAccounts > 0
                          ? <Space size={4}><span style={{ fontSize: 12 }}>{r.scannedAccounts}/{r.accountCount}</span><Tag color="orange" style={{ margin: 0 }}>未扫 {r.unscannedAccounts}</Tag></Space>
                          : <Tag color="green" style={{ margin: 0 }}>已全扫</Tag>,
                      },
                      {
                        title: '有缺口账户', dataIndex: 'gapAccounts', width: 100, align: 'center' as const,
                        sorter: (a: any, b: any) => a.gapAccounts - b.gapAccounts,
                        render: (n: number, r: any) => r.scannedAccounts === 0
                          ? <Tooltip title="尚无区域扫描结果"><Tag style={{ margin: 0 }}>未知</Tag></Tooltip>
                          : n > 0
                            ? <Tooltip title={`${n} / ${r.scannedAccounts} 个已扫描账户至少缺一个 opt-in 区域`}><Tag color="orange" style={{ margin: 0 }}>{n}</Tag></Tooltip>
                            : <Tag color="green" style={{ margin: 0 }}>0</Tag>,
                      },
                      {
                        title: '已开通', dataIndex: 'enabled', width: 80, align: 'center' as const,
                        sorter: (a: any, b: any) => a.enabled - b.enabled,
                        render: (n: number) => <span style={{ fontSize: 12, color: '#389e0d' }}>{n}</span>,
                      },
                      {
                        title: '启用中', dataIndex: 'enabling', width: 80, align: 'center' as const,
                        render: (n: number) => n > 0 ? <Tag color="blue" style={{ margin: 0 }}>{n}</Tag> : <span style={{ color: '#b6bdca' }}>0</span>,
                      },
                      {
                        title: '未开通', dataIndex: 'disabled', width: 80, align: 'center' as const,
                        defaultSortOrder: 'descend' as const,
                        sorter: (a: any, b: any) => a.disabled - b.disabled,
                        render: (n: number) => n > 0 ? <Tag color="red" style={{ margin: 0 }}>{n}</Tag> : <span style={{ color: '#b6bdca' }}>0</span>,
                      },
                      {
                        title: '开通率', key: 'rate', width: 130,
                        sorter: (a: any, b: any) => a.rate - b.rate,
                        render: (_: any, r: any) => r.slots > 0
                          ? <Progress percent={r.rate} size="small" strokeColor={r.rate === 100 ? '#52c41a' : '#faad14'} />
                          : '-',
                      },
                      {
                        title: '操作', key: 'act', width: 140,
                        render: (_: any, r: any) => (
                          <Space size={0}>
                            <Button
                              type="link"
                              size="small"
                              loading={scanningPayer === r.payer}
                              disabled={scanning || (scanningPayer !== null && scanningPayer !== r.payer)}
                              onClick={(e) => { e.stopPropagation(); handleScanForPayer(r); }}
                            >
                              扫描
                            </Button>
                            <Button type="link" size="small" onClick={(e) => { e.stopPropagation(); setSelectedPayer(r.payer === selectedPayer ? null : r.payer); }}>
                              {r.payer === selectedPayer ? '收起' : '展开'}
                            </Button>
                          </Space>
                        ),
                      },
                    ]}
                  />
                </Card>

                {/* 选中组织的明细：区域维度 + 账户维度 */}
                {currentGroup && (
                  <Card
                    size="small"
                    style={{ marginTop: 12 }}
                    title={(
                      <span>
                        <Tag color="blue" style={{ margin: 0 }}>{currentGroup.payer}</Tag>
                        {' '}{currentGroup.accountCount} 个账户 · 已扫描 {currentGroup.scannedAccounts}
                        {currentGroup.unscannedAccounts > 0 && <> · <span style={{ color: '#d46b08' }}>未扫描 {currentGroup.unscannedAccounts}</span></>}
                        {' '}· 未开通 {currentGroup.disabled} 项
                      </span>
                    )}
                    extra={
                      <Space size={8}>
                        <Checkbox checked={payerOnlyGaps} onChange={e => setPayerOnlyGaps(e.target.checked)}>
                          <span style={{ fontSize: 12 }}>只看有缺口/未扫描</span>
                        </Checkbox>
                        <Button
                          size="small"
                          onClick={() => exportToCSV(
                            currentGroup.accounts.flatMap(a =>
                              a.disabled.map(region => ({
                                组织: currentGroup.payer, 账户ID: a.accountId, 账户名: a.name,
                                未开通区域: region, 区域名称: REGION_CN[region] || '',
                              }))),
                            `regions-gaps-${currentGroup.payer}`,
                          )}
                        >
                          导出缺口
                        </Button>
                      </Space>
                    }
                  >
                    {currentGroup.unscannedAccounts > 0 && (
                      <Alert
                        type="warning"
                        showIcon
                        message={`该组织有 ${currentGroup.unscannedAccounts} 个账户尚未扫描，区域统计仅覆盖 ${currentGroup.scannedAccounts} 个账户`}
                        style={{ marginBottom: 12 }}
                      />
                    )}
                    <Tabs
                      size="small"
                      items={[
                        {
                          key: 'byRegion', label: '按区域',
                          children: (
                            <Table
                              size="small"
                              dataSource={currentGroupRegions}
                              rowKey="region"
                              pagination={false}
                              locale={{
                                emptyText: payerOnlyGaps
                                  ? currentGroup.unscannedAccounts > 0
                                    ? '该组织尚有未扫描账户，区域统计不完整'
                                    : '该组织所有 opt-in 区域已全部开通 ✓'
                                  : '无数据',
                              }}
                              columns={[
                                { title: '区域', dataIndex: 'region', width: 150, render: (r: string) => <code style={{ fontSize: 12 }}>{r}</code> },
                                { title: '名称', dataIndex: 'region', key: 'cn', width: 160, render: (r: string) => <span style={{ fontSize: 12 }}>{REGION_CN[r] || '-'}</span> },
                                { title: '已开通', dataIndex: 'enabled', width: 80, align: 'center' as const, render: (n: number) => <span style={{ color: '#389e0d' }}>{n}</span> },
                                { title: '启用中', dataIndex: 'enabling', width: 80, align: 'center' as const, render: (n: number) => n > 0 ? <Tag color="blue" style={{ margin: 0 }}>{n}</Tag> : <span style={{ color: '#b6bdca' }}>0</span> },
                                { title: '未开通', dataIndex: 'disabled', width: 80, align: 'center' as const, render: (n: number) => n > 0 ? <Tag color="red" style={{ margin: 0 }}>{n}</Tag> : <span style={{ color: '#b6bdca' }}>0</span> },
                                {
                                  title: '操作', key: 'act', width: 170,
                                  render: (_: any, r: any) => r.disabled > 0 ? (
                                    <Popconfirm
                                      title={`为 ${currentGroup.payer} 下 ${r.disabled} 个账户启用 ${r.region}？`}
                                      description="逐个账户串行下发，账户多时需要一些时间"
                                      onConfirm={() => handleEnableForPayer(r.region, r.gapAccountIds)}
                                      okText="启用" cancelText="取消"
                                    >
                                      <Button size="small" type="link" loading={enabling}>为整组织启用 ({r.disabled})</Button>
                                    </Popconfirm>
                                  ) : currentGroup.unscannedAccounts > 0
                                    ? <span style={{ color: '#d46b08', fontSize: 12 }}>统计不完整</span>
                                    : <span style={{ color: '#b6bdca', fontSize: 12 }}>全部开通</span>,
                                },
                              ]}
                            />
                          ),
                        },
                        {
                          key: 'byAccount', label: '按账户',
                          children: (
                            <Table
                              size="small"
                              dataSource={payerOnlyGaps ? currentGroup.accounts.filter(a => !a.scanned || a.disabled.length > 0) : currentGroup.accounts}
                              rowKey="accountId"
                              pagination={{ pageSize: 15, size: 'small', showTotal: t => `共 ${t} 个账户` }}
                              locale={{ emptyText: payerOnlyGaps ? '该组织所有已扫描账户均无区域缺口' : '无数据' }}
                              columns={[
                                { title: '账户 ID', dataIndex: 'accountId', width: 130, render: (id: string) => <code style={{ fontSize: 12 }}>{id}</code> },
                                { title: '名称', dataIndex: 'name', width: 170, ellipsis: true, render: (n: string) => <span style={{ fontSize: 12 }}>{n}</span> },
                                {
                                  title: '扫描状态', dataIndex: 'scanned', width: 90, align: 'center' as const,
                                  sorter: (a: any, b: any) => Number(a.scanned) - Number(b.scanned),
                                  render: (scanned: boolean) => scanned
                                    ? <Tag color="green" style={{ margin: 0 }}>已扫描</Tag>
                                    : <Tag color="orange" style={{ margin: 0 }}>未扫描</Tag>,
                                },
                                {
                                  title: '已开通', dataIndex: 'enabled', width: 80, align: 'center' as const,
                                  sorter: (a: any, b: any) => a.enabled.length - b.enabled.length,
                                  render: (v: string[]) => <span style={{ fontSize: 12, color: '#389e0d' }}>{v.length}</span>,
                                },
                                {
                                  title: '未开通区域', dataIndex: 'disabled',
                                  sorter: (a: any, b: any) => a.disabled.length - b.disabled.length,
                                  defaultSortOrder: 'descend' as const,
                                  render: (regions: string[], row: any) => !row.scanned
                                    ? <span style={{ color: '#d46b08', fontSize: 12 }}>等待扫描后确认</span>
                                    : regions.length === 0
                                      ? <span style={{ color: '#52c41a', fontSize: 12 }}>全部开通 ✓</span>
                                      : (
                                      <Space size={[4, 4]} wrap>
                                        {regions.map(r => (
                                          <Popconfirm
                                            key={r}
                                            title={`为 ${row.accountId} 启用 ${r}？`}
                                            onConfirm={() => handleSingleEnable(row.accountId, r)}
                                            okText="启用" cancelText="取消"
                                          >
                                            <Tooltip title={`${REGION_CN[r] || r} — 点击启用`}>
                                              <Tag color="red" style={{ margin: 0, cursor: 'pointer', fontSize: 11 }}>{r}</Tag>
                                            </Tooltip>
                                          </Popconfirm>
                                        ))}
                                      </Space>
                                    ),
                                },
                              ]}
                            />
                          ),
                        },
                      ]}
                    />
                  </Card>
                )}

                {!currentGroup && (
                  <p style={{ color: '#8a94a6', padding: 16, textAlign: 'center', fontSize: 12 }}>
                    点击上方任一组织展开明细，可看到该组织下哪些账户缺哪些区域，并支持为整个组织批量启用
                  </p>
                )}

                {/* 已离场账户的遗留区域数据 —— 解释这批数据为何存在，并保留追溯线索 */}
                {departedWithRegions.length > 0 && (
                  <Card
                    size="small"
                    style={{ marginTop: 12 }}
                    title={<span style={{ fontSize: 13 }}>已移出组织的账户遗留数据（{departedWithRegions.length}）</span>}
                  >
                    <p style={{ color: 'rgba(0,0,0,0.55)', fontSize: 12, marginTop: 0 }}>
                      这些账户已不在任何被管理的组织内，不计入上方组织统计。区域数据是它们离开前扫描留下的，
                      保留在此仅供追溯。账户离开时 StackSet 会按 <code>RetainStacksOnAccountRemoval=false</code> 自动删除平台角色，
                      因此平台已无法再访问它们。
                    </p>
                    <Table
                      size="small"
                      dataSource={departedWithRegions}
                      rowKey="account_id"
                      pagination={false}
                      columns={[
                        { title: '账户 ID', dataIndex: 'account_id', width: 130, render: (id: string) => <code style={{ fontSize: 12 }}>{id}</code> },
                        { title: '名称', dataIndex: 'name', width: 140, render: (n: string) => <span style={{ fontSize: 12 }}>{n || '-'}</span> },
                        {
                          title: '原属组织', dataIndex: 'payer', width: 170,
                          render: (p: string) => p ? <Tag style={{ margin: 0, fontSize: 11 }}>{p}</Tag> : <span style={{ color: '#8a94a6', fontSize: 12 }}>未知</span>,
                        },
                        {
                          title: '移出时间', dataIndex: 'departed_at', width: 150,
                          render: (t: string, r: any) => t
                            ? <Tooltip title={r.actor ? `操作者：${r.actor}` : ''}><span style={{ fontSize: 12 }}>{new Date(t).toLocaleString('zh-CN')}</span></Tooltip>
                            : <Tooltip title={r.note || '未查证到移出事件'}><span style={{ color: '#8a94a6', fontSize: 12 }}>未查证</span></Tooltip>,
                        },
                        {
                          title: '遗留区域记录', key: 'rd', width: 130,
                          render: (_: any, r: any) => <span style={{ fontSize: 12 }}>{r.enabledCount}/{r.regionCount} 已开通</span>,
                        },
                        {
                          title: '最后扫描', dataIndex: 'lastScan', width: 150,
                          render: (t: string) => <span style={{ fontSize: 12, color: 'rgba(0,0,0,0.45)' }}>{t ? new Date(t).toLocaleString('zh-CN') : '-'}</span>,
                        },
                        {
                          title: '备注', dataIndex: 'note',
                          render: (n: string) => n ? <span style={{ fontSize: 11, color: 'rgba(0,0,0,0.45)' }}>{n}</span> : null,
                        },
                      ]}
                    />
                  </Card>
                )}
              </>
            ),
          },
        ]} />
      )}
    </div>
  );
};

export default RegionsPage;
