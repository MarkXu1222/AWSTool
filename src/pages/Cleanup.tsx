import React, { useState, useEffect } from 'react';
import { Card, Table, Button, Select, Space, message, Tag, Alert, Checkbox, Badge, Steps, Input, Dropdown, Popconfirm } from 'antd';
import { DeleteOutlined, SearchOutlined, WarningOutlined, DollarOutlined, DownloadOutlined, FileExcelOutlined, FileTextOutlined, ArrowRightOutlined } from '@ant-design/icons';
import type { AwsAccount, ScannedResource } from '../types/aws';
import { exportToCSV, exportToJSON } from '../utils/export';
import DangerConfirm from '../components/DangerConfirm';

const AWS_REGIONS = [
  'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
  'eu-west-1', 'eu-west-2', 'eu-central-1',
  'ap-southeast-1', 'ap-southeast-2', 'ap-northeast-1',
  'ap-south-1', 'sa-east-1',
];

const SERVICE_COLORS: Record<string, string> = {
  EC2: 'volcano', EBS: 'orange', S3: 'green', Lambda: 'purple', RDS: 'blue',
};

interface CostByService {
  service: string;
  cost: number;
}

interface CostByRegion {
  region: string;
  cost: number;
}

const CleanupPage: React.FC = () => {
  const [accounts, setAccounts] = useState<AwsAccount[]>([]);
  const [selectedAccount, setSelectedAccount] = useState<string>('');
  const [selectedRegion, setSelectedRegion] = useState<string>('us-east-1');
  const [resources, setResources] = useState<ScannedResource[]>([]);
  const [selectedResources, setSelectedResources] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [deleteResults, setDeleteResults] = useState<{ id: string; success: boolean; error?: string }[]>([]);
  const [searchText, setSearchText] = useState('');
  const [showFirstConfirm, setShowFirstConfirm] = useState(false);
  const [showFinalConfirm, setShowFinalConfirm] = useState(false);

  // Step flow: 0=选账户, 1=查账单确认, 2=扫描删除
  const [currentStep, setCurrentStep] = useState(0);
  const [costByService, setCostByService] = useState<CostByService[]>([]);
  const [costByRegion, setCostByRegion] = useState<CostByRegion[]>([]);
  const [costLoading, setCostLoading] = useState(false);

  useEffect(() => { loadAccounts(); }, []);

  const loadAccounts = async () => {
    const result = await window.awsAPI.listAccounts();
    if (result.success && result.data) setAccounts(result.data);
  };

  // Step 1: 查该账户的账单，了解资源分布
  const analyzeCost = async () => {
    if (!selectedAccount) { message.warning('请先选择账户'); return; }
    setCostLoading(true);
    try {
      // Get last 30 days cost by service
      const now = new Date();
      const startDate = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate()).toISOString().split('T')[0];
      const endDate = now.toISOString().split('T')[0];

      const result = await window.awsAPI.getCostByService(selectedAccount, startDate, endDate);
      if (result.success && result.data) {
        // Parse cost by service
        const serviceMap: Record<string, number> = {};
        result.data.forEach(period => {
          (period.Groups || []).forEach(group => {
            const service = group.Keys[0] || 'Other';
            const amount = parseFloat(group.Metrics.UnblendedCost.Amount || '0');
            serviceMap[service] = (serviceMap[service] || 0) + amount;
          });
        });

        const sorted = Object.entries(serviceMap)
          .map(([service, cost]) => ({ service, cost }))
          .filter(s => s.cost > 0)
          .sort((a, b) => b.cost - a.cost);

        setCostByService(sorted);
        setCurrentStep(1);
        message.success('账单分析完成，请查看资源分布后选择区域扫描');
      } else {
        message.error(result.error || '获取账单失败');
      }
    } catch (err: any) {
      message.error(err.message);
    } finally {
      setCostLoading(false);
    }
  };

  // Step 2: 扫描资源
  const scanResources = async () => {
    setLoading(true);
    setResources([]);
    setSelectedResources([]);
    setDeleteResults([]);
    setSearchText('');
    try {
      const result = await window.awsAPI.scanResources(selectedAccount, selectedRegion);
      if (result.success && result.data) {
        setResources(result.data);
        setCurrentStep(2);
        if (result.data.length === 0) {
          message.info('该区域没有发现资源');
        } else {
          message.success(`发现 ${result.data.length} 个资源`);
        }
      } else {
        message.error(result.error || '扫描失败');
      }
    } catch (err: any) { message.error(err.message); }
    finally { setLoading(false); }
  };

  // Step 3: 删除
  const handleCleanup = async () => {
    if (selectedResources.length === 0) { message.warning('请先选择要删除的资源'); return; }
    setCleaning(true);
    try {
      const toDelete = resources
        .filter(r => selectedResources.includes(r.id))
        .map(r => ({ type: r.type, id: r.id }));

      const result = await window.awsAPI.cleanupResources(selectedAccount, selectedRegion, toDelete);
      if (result.success && result.data) {
        setDeleteResults(result.data);
        const successCount = result.data.filter(r => r.success).length;
        const failCount = result.data.filter(r => !r.success).length;
        if (failCount === 0) message.success(`成功删除 ${successCount} 个资源`);
        else message.warning(`成功 ${successCount} 个，失败 ${failCount} 个`);

        const deletedIds = new Set(result.data.filter(r => r.success).map(r => r.id));
        setResources(prev => prev.filter(r => !deletedIds.has(r.id)));
        setSelectedResources(prev => prev.filter(id => !deletedIds.has(id)));
      } else {
        message.error(result.error || '清理失败');
      }
    } catch (err: any) { message.error(err.message); }
    finally {
      setCleaning(false);
      setShowFinalConfirm(false);
    }
  };

  const selectAll = () => setSelectedResources(filteredResources.map(r => r.id));
  const selectNone = () => setSelectedResources([]);
  const selectByType = (type: string) => setSelectedResources(resources.filter(r => r.type === type).map(r => r.id));

  const filteredResources = resources.filter(r =>
    !searchText ||
    r.name?.toLowerCase().includes(searchText.toLowerCase()) ||
    r.id?.toLowerCase().includes(searchText.toLowerCase()) ||
    r.type?.toLowerCase().includes(searchText.toLowerCase()) ||
    r.details?.toLowerCase().includes(searchText.toLowerCase())
  );

  const resourcesByService = resources.reduce<Record<string, number>>((acc, r) => {
    acc[r.type] = (acc[r.type] || 0) + 1;
    return acc;
  }, {});

  const handleExportCSV = () => {
    exportToCSV(
      filteredResources.map(r => ({ '服务': r.type, 'ID': r.id, '名称': r.name, 'ARN': r.arn, '详情': r.details })),
      `cleanup_scan_${selectedAccount}_${selectedRegion}`
    );
    message.success('已导出 CSV');
  };

  const handleExportJSON = () => {
    exportToJSON({ account: selectedAccount, region: selectedRegion, resources: filteredResources },
      `cleanup_scan_${selectedAccount}_${selectedRegion}`);
    message.success('已导出 JSON');
  };

  const totalCost = costByService.reduce((sum, s) => sum + s.cost, 0);

  const columns = [
    {
      title: '', key: 'select', width: 40,
      render: (_: any, record: ScannedResource) => (
        <Checkbox checked={selectedResources.includes(record.id)}
          onChange={(e) => {
            if (e.target.checked) setSelectedResources(prev => [...prev, record.id]);
            else setSelectedResources(prev => prev.filter(id => id !== record.id));
          }} />
      ),
    },
    {
      title: '服务', dataIndex: 'type', key: 'type', width: 100,
      filters: Object.keys(resourcesByService).map(t => ({ text: t, value: t })),
      onFilter: (value: any, record: ScannedResource) => record.type === value,
      render: (type: string) => <Tag color={SERVICE_COLORS[type] || 'default'}>{type}</Tag>,
    },
    { title: '名称', dataIndex: 'name', key: 'name', render: (name: string) => <strong>{name}</strong> },
    { title: 'ID', dataIndex: 'id', key: 'id', render: (id: string) => <code style={{ fontSize: 12 }}>{id}</code> },
    { title: '详情', dataIndex: 'details', key: 'details', render: (d: string) => <span style={{ color: '#999' }}>{d}</span> },
  ];

  return (
    <div className="page-container">
      <Card
        title={<span style={{ fontSize: 18, fontWeight: 600 }}>🧹 资源清理</span>}
        extra={
          resources.length > 0 ? (
            <Dropdown menu={{
              items: [
                { key: 'csv', label: '导出 CSV', icon: <FileExcelOutlined />, onClick: handleExportCSV },
                { key: 'json', label: '导出 JSON', icon: <FileTextOutlined />, onClick: handleExportJSON },
              ]
            }}>
              <Button icon={<DownloadOutlined />}>导出</Button>
            </Dropdown>
          ) : null
        }
        
      >
        {/* Flow Steps */}
        <Steps current={currentStep} size="small" style={{ marginBottom: 24 }}
          items={[
            { title: '选择账户' },
            { title: '查看账单分布' },
            { title: '扫描并清理' },
          ]} />

        {/* Step 0: 选账户 */}
        <Space wrap style={{ marginBottom: 16 }}>
          <Select placeholder="选择账户" style={{ width: 280 }} value={selectedAccount || undefined}
            onChange={(v) => { setSelectedAccount(v); setCurrentStep(0); setCostByService([]); setResources([]); }}
            showSearch optionFilterProp="label"
            options={accounts.map((a) => ({ label: `${a.Name} (${a.Id})`, value: a.Id }))} />
          {selectedAccount && currentStep === 0 && (
            <Button type="primary" icon={<DollarOutlined />} onClick={analyzeCost} loading={costLoading}>
              分析账单 → 查看资源分布
            </Button>
          )}
        </Space>

        {/* Step 1: 账单分析结果 */}
        {currentStep >= 1 && costByService.length > 0 && (
          <Card size="small" style={{ marginBottom: 16 }}
            title={<span>📊 近30天账单分析（总费用: <span style={{ color: 'var(--status-warning, #ff9500)' }}>${totalCost.toFixed(2)}</span>）</span>}>
            <Row gutter={16}>
              <Col span={16}>
                <Table size="small" pagination={false} dataSource={costByService.slice(0, 10)} rowKey="service"
                  columns={[
                    { title: '服务', dataIndex: 'service', key: 'service' },
                    {
                      title: '费用 (USD)', dataIndex: 'cost', key: 'cost',
                      render: (c: number) => <span style={{ color: c > 10 ? '#ff4d4f' : c > 1 ? '#faad14' : '#52c41a', fontWeight: 600 }}>${c.toFixed(4)}</span>,
                    },
                    {
                      title: '占比', key: 'pct',
                      render: (_: any, r: CostByService) => <Tag color="blue">{totalCost > 0 ? ((r.cost / totalCost) * 100).toFixed(1) : 0}%</Tag>,
                    },
                  ]} />
              </Col>
              <Col span={8}>
                <Alert message="💡 清理建议" type="info"
                  description={
                    <ul style={{ paddingLeft: 16, margin: '8px 0' }}>
                      <li>费用最高的服务通常有最多资源</li>
                      <li>选择对应区域扫描并清理</li>
                      <li>S3 是全局服务，在 us-east-1 区域扫描</li>
                    </ul>
                  } />
              </Col>
            </Row>
            <Space style={{ marginTop: 16 }}>
              <Select placeholder="选择区域扫描" style={{ width: 180 }} value={selectedRegion}
                onChange={setSelectedRegion}
                options={AWS_REGIONS.map((r) => ({ label: r, value: r }))} />
              <Button type="primary" icon={<ArrowRightOutlined />} onClick={scanResources} loading={loading}>
                扫描该区域资源
              </Button>
            </Space>
          </Card>
        )}

        {/* Step 2: 资源列表 */}
        {currentStep >= 2 && (
          <>
            <Alert message="⚠️ 删除操作不可恢复" type="warning" showIcon icon={<WarningOutlined />}
              style={{ marginBottom: 12 }} />

            <Space wrap style={{ marginBottom: 12 }}>
              <Input placeholder="搜索资源..." prefix={<SearchOutlined />} value={searchText}
                onChange={(e) => setSearchText(e.target.value)} allowClear style={{ width: 250 }} />
              <Button size="small" onClick={selectAll}>全选</Button>
              <Button size="small" onClick={selectNone}>取消全选</Button>
              {Object.keys(resourcesByService).map(type => (
                <Button key={type} size="small" onClick={() => selectByType(type)}>
                  选 {type} ({resourcesByService[type]})
                </Button>
              ))}
            </Space>

            {selectedResources.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                <Button danger icon={<DeleteOutlined />} size="large"
                  onClick={() => setShowFirstConfirm(true)}>
                  删除选中的 {selectedResources.length} 个资源
                </Button>
              </div>
            )}

            {/* 第一次确认：Popconfirm */}
            <Popconfirm
              open={showFirstConfirm}
              title="⚠️ 第一次确认"
              description={
                <div style={{ maxWidth: 300 }}>
                  <p>你将删除 <strong>{selectedResources.length}</strong> 个资源：</p>
                  <ul style={{ paddingLeft: 16 }}>
                    {Object.entries(resourcesByService).filter(([type]) =>
                      selectedResources.some(id => resources.find(r => r.id === id && r.type === type))
                    ).map(([type, count]) => (
                      <li key={type}>{type}: {resources.filter(r => selectedResources.includes(r.id) && r.type === type).length} 个</li>
                    ))}
                  </ul>
                  <p style={{ color: '#ff4d4f', fontWeight: 600 }}>确定要继续吗？</p>
                </div>
              }
              onConfirm={() => { setShowFirstConfirm(false); setShowFinalConfirm(true); }}
              onCancel={() => setShowFirstConfirm(false)}
              okText="继续 → 最终确认"
              cancelText="取消"
              okButtonProps={{ danger: true }}
            >
              <span />
            </Popconfirm>

            {/* 第二次确认：输入文字确认 */}
            <DangerConfirm
              open={showFinalConfirm}
              title="最终确认 — 不可逆操作"
              description={
                <div>
                  <p>你即将<strong style={{ color: '#ff4d4f' }}>永久删除</strong>以下资源：</p>
                  <ul style={{ paddingLeft: 16, margin: '8px 0' }}>
                    <li>账户: <code>{selectedAccount}</code></li>
                    <li>区域: <Tag color="purple">{selectedRegion}</Tag></li>
                    <li>数量: <Tag color="red">{selectedResources.length} 个资源</Tag></li>
                  </ul>
                  <p style={{ color: '#ff4d4f', fontWeight: 600 }}>删除后无法恢复！</p>
                </div>
              }
              confirmText="确认删除"
              loading={cleaning}
              onConfirm={handleCleanup}
              onCancel={() => setShowFinalConfirm(false)}
            />

            {deleteResults.length > 0 && (
              <Alert message="删除结果" closable style={{ marginBottom: 12 }}
                type={deleteResults.every(r => r.success) ? 'success' : 'warning'}
                description={
                  <ul style={{ margin: '4px 0', paddingLeft: 20 }}>
                    {deleteResults.map(r => (
                      <li key={r.id} style={{ color: r.success ? '#52c41a' : '#ff4d4f' }}>
                        {r.id}: {r.success ? '✓ 已删除' : `✗ ${r.error}`}
                      </li>
                    ))}
                  </ul>
                } />
            )}

            <Table columns={columns} dataSource={filteredResources} rowKey="id" loading={loading}
              size="middle" pagination={{ pageSize: 20, showTotal: (t) => `共 ${t} 个资源` }} />
          </>
        )}
      </Card>
    </div>
  );
};

export default CleanupPage;
