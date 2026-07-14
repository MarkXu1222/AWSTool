import React, { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Card,
  Col,
  Descriptions,
  Dropdown,
  Empty,
  Input,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  DownOutlined,
  DownloadOutlined,
  FileExcelOutlined,
  FileTextOutlined,
  ReloadOutlined,
  SearchOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { api } from '../api';

type AuditOutcome = 'success' | 'error' | 'completed';

type AuditDisplay = {
  category: string;
  operation: string;
  target: string;
  result: string;
  outcome: AuditOutcome;
};

type AuditRecord = {
  id?: number;
  created_at: string;
  username?: string;
  action?: string;
  detail?: string;
  ip?: string;
  method?: string;
  path?: string;
  status?: number;
  duration_ms?: number;
  params?: Record<string, unknown>;
  display?: AuditDisplay;
};

const fallbackActions: Record<string, { category: string; operation: string }> = {
  LOGIN: { category: '登录与安全', operation: '登录系统' },
  LOGOUT: { category: '登录与安全', operation: '退出登录' },
  MFA_SETUP: { category: '登录与安全', operation: '启用 MFA' },
  PASSWORD_CHANGE: { category: '登录与安全', operation: '修改密码' },
  PASSWORD_RESET: { category: '用户管理', operation: '重置用户密码' },
  USER_CREATE: { category: '用户管理', operation: '创建用户' },
  USER_UPDATE: { category: '用户管理', operation: '修改用户资料与权限' },
  USER_DELETE: { category: '用户管理', operation: '删除用户' },
  QUOTA_INCREASE: { category: '配额管理', operation: '提交配额提升申请' },
  REGION_ENABLE: { category: '区域管理', operation: '启用区域' },
  REGION_BATCH_ENABLE: { category: '区域管理', operation: '批量启用区域' },
  REGION_DISABLE: { category: '区域管理', operation: '禁用区域' },
};

const categoryColors: Record<string, string> = {
  系统概览: 'blue',
  账户管理: 'geekblue',
  配额管理: 'orange',
  区域管理: 'cyan',
  账单分析: 'gold',
  资源清理: 'volcano',
  安全检查: 'red',
  登录与安全: 'green',
  用户管理: 'purple',
  审计日志: 'magenta',
  系统操作: 'default',
};

function cleanIP(value?: string): string {
  return value?.replace(/::ffff:/g, '') || '';
}

function fallbackDisplay(record: AuditRecord): AuditDisplay {
  if (record.display) return record.display;
  const meta = fallbackActions[record.action || ''];
  const isError = typeof record.status === 'number' && record.status >= 400;
  return {
    category: meta?.category || '系统操作',
    operation: meta?.operation || (record.action === 'API_CALL' ? '访问系统功能' : record.action || '系统操作'),
    target: record.detail || record.path || '',
    result: isError ? '失败' : record.status ? '成功' : '已完成',
    outcome: isError ? 'error' : record.status ? 'success' : 'completed',
  };
}

function formatTime(value: string): { date: string; time: string } {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { date: value || '-', time: '' };
  return {
    date: date.toLocaleDateString('zh-CN'),
    time: date.toLocaleTimeString('zh-CN', { hour12: false }),
  };
}

function resultTag(display: AuditDisplay) {
  if (display.outcome === 'error') {
    return <Tag icon={<CloseCircleOutlined />} color="error">{display.result}</Tag>;
  }
  if (display.outcome === 'success') {
    return <Tag icon={<CheckCircleOutlined />} color="success">{display.result}</Tag>;
  }
  return <Tag color="processing">{display.result}</Tag>;
}

const AuditLogPage: React.FC = () => {
  const [logs, setLogs] = useState<AuditRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState('');
  const [category, setCategory] = useState<string>('all');
  const [result, setResult] = useState<'all' | 'normal' | 'error'>('all');
  const [exporting, setExporting] = useState<'csv' | 'json' | null>(null);

  useEffect(() => { fetchLogs(); }, []);

  const fetchLogs = async () => {
    setLoading(true);
    try {
      const res = await api.getAuditLog(500);
      if (res.success) setLogs(res.data || []);
      else message.error(res.error || '加载审计日志失败');
    } catch (e: any) {
      message.error(e.message || '加载审计日志失败');
    } finally {
      setLoading(false);
    }
  };

  const categories = useMemo(() => (
    [...new Set(logs.map(log => fallbackDisplay(log).category))]
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b, 'zh-CN'))
  ), [logs]);

  const filteredLogs = useMemo(() => {
    const normalizedKeyword = keyword.trim().toLowerCase();
    return logs.filter(log => {
      const display = fallbackDisplay(log);
      if (category !== 'all' && display.category !== category) return false;
      if (result === 'error' && display.outcome !== 'error') return false;
      if (result === 'normal' && display.outcome === 'error') return false;
      if (!normalizedKeyword) return true;

      const haystack = [
        log.username,
        display.category,
        display.operation,
        display.target,
        log.method,
        log.path,
        log.status,
        log.ip,
        log.detail,
        log.params ? JSON.stringify(log.params) : '',
      ].join(' ').toLowerCase();
      return haystack.includes(normalizedKeyword);
    });
  }, [logs, keyword, category, result]);

  const successfulCount = useMemo(() => (
    logs.filter(log => fallbackDisplay(log).outcome !== 'error').length
  ), [logs]);
  const failedCount = logs.length - successfulCount;
  const userCount = useMemo(() => new Set(logs.map(log => log.username).filter(Boolean)).size, [logs]);

  const handleExport = async (format: 'csv' | 'json') => {
    setExporting(format);
    try {
      const count = await api.exportAuditLog(format);
      message.success(count > 0
        ? `已导出 ${count} 条审计日志（${format.toUpperCase()}）`
        : `审计日志已导出（${format.toUpperCase()}）`);
    } catch (e: any) {
      message.error(e.message || '导出审计日志失败');
    } finally {
      setExporting(null);
    }
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <h2 className="page-header-title">审计日志</h2>
          <p className="page-header-subtitle">按业务操作查看用户行为；页面加载最近 500 条，导出包含完整保留记录</p>
        </div>
        <Space wrap>
          <Dropdown
            menu={{
              items: [
                { key: 'csv', icon: <FileExcelOutlined />, label: '导出 CSV（Excel）' },
                { key: 'json', icon: <FileTextOutlined />, label: '导出 JSON（完整技术数据）' },
              ],
              onClick: ({ key }) => handleExport(key as 'csv' | 'json'),
            }}
            trigger={['click']}
          >
            <Button icon={<DownloadOutlined />} loading={exporting !== null}>
              {exporting ? '导出中' : '导出完整日志'} <DownOutlined />
            </Button>
          </Dropdown>
          <Button icon={<ReloadOutlined />} onClick={fetchLogs} loading={loading}>刷新</Button>
        </Space>
      </div>

      <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
        <Col xs={12} sm={6}>
          <Card size="small"><Statistic title="已加载日志" value={logs.length} /></Card>
        </Col>
        <Col xs={12} sm={6}>
          <Card size="small"><Statistic title="操作用户" value={userCount} prefix={<UserOutlined />} /></Card>
        </Col>
        <Col xs={12} sm={6}>
          <Card size="small"><Statistic title="成功 / 完成" value={successfulCount} valueStyle={{ color: '#389e0d' }} /></Card>
        </Col>
        <Col xs={12} sm={6}>
          <Card size="small"><Statistic title="失败" value={failedCount} valueStyle={{ color: failedCount ? '#cf1322' : undefined }} /></Card>
        </Col>
      </Row>

      <Card size="small" style={{ marginBottom: 12 }} bodyStyle={{ padding: 12 }}>
        <Space wrap style={{ width: '100%' }}>
          <Input
            allowClear
            prefix={<SearchOutlined />}
            placeholder="搜索用户、操作、账户 ID、区域或路径"
            value={keyword}
            onChange={event => setKeyword(event.target.value)}
            style={{ width: 330, maxWidth: '100%' }}
          />
          <Select
            value={category}
            onChange={setCategory}
            style={{ width: 150 }}
            options={[
              { label: '全部分类', value: 'all' },
              ...categories.map(item => ({ label: item, value: item })),
            ]}
          />
          <Select
            value={result}
            onChange={setResult}
            style={{ width: 130 }}
            options={[
              { label: '全部结果', value: 'all' },
              { label: '成功 / 完成', value: 'normal' },
              { label: '失败', value: 'error' },
            ]}
          />
          <Typography.Text type="secondary">
            当前显示 {filteredLogs.length} / {logs.length} 条
          </Typography.Text>
        </Space>
      </Card>

      <Card size="small" bodyStyle={{ padding: 0 }}>
        <Table<AuditRecord>
          dataSource={filteredLogs}
          rowKey={(record, index) => `${record.id || 'legacy'}-${record.created_at}-${index}`}
          size="middle"
          loading={loading}
          tableLayout="fixed"
          scroll={{ x: 1040 }}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无符合条件的审计日志" /> }}
          pagination={{
            pageSize: 30,
            showSizeChanger: true,
            pageSizeOptions: ['20', '30', '50', '100'],
            showTotal: total => `共 ${total} 条`,
          }}
          expandable={{
            expandedRowRender: record => {
              const params = record.params && Object.keys(record.params).length > 0
                ? JSON.stringify(record.params, null, 2)
                : '';
              return (
                <div style={{ padding: '4px 8px 12px' }}>
                  <Descriptions size="small" bordered column={{ xs: 1, sm: 2, lg: 3 }}>
                    <Descriptions.Item label="用户">{record.username || '-'}</Descriptions.Item>
                    <Descriptions.Item label="IP">{cleanIP(record.ip) || '-'}</Descriptions.Item>
                    <Descriptions.Item label="原始动作">{record.action || '-'}</Descriptions.Item>
                    <Descriptions.Item label="HTTP 方法">{record.method || '-'}</Descriptions.Item>
                    <Descriptions.Item label="状态码">{record.status ?? '-'}</Descriptions.Item>
                    <Descriptions.Item label="耗时">{record.duration_ms !== undefined ? `${record.duration_ms} ms` : '-'}</Descriptions.Item>
                    <Descriptions.Item label="API 路径" span={3}>
                      <Typography.Text code copyable={!!record.path}>{record.path || '-'}</Typography.Text>
                    </Descriptions.Item>
                    <Descriptions.Item label="请求参数" span={3}>
                      {params ? (
                        <pre style={{ margin: 0, maxHeight: 260, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                          {params}
                        </pre>
                      ) : '-'}
                    </Descriptions.Item>
                    <Descriptions.Item label="原始详情" span={3}>
                      <Typography.Text copyable={!!record.detail}>{record.detail || '-'}</Typography.Text>
                    </Descriptions.Item>
                  </Descriptions>
                </div>
              );
            },
            rowExpandable: record => Boolean(record.path || record.params || record.detail || record.method),
          }}
          columns={[
            {
              title: '时间',
              dataIndex: 'created_at',
              width: 135,
              sorter: (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
              render: (value: string) => {
                const formatted = formatTime(value);
                return (
                  <div style={{ fontVariantNumeric: 'tabular-nums' }}>
                    <div style={{ fontSize: 12 }}>{formatted.date}</div>
                    <div style={{ fontSize: 12, color: '#8c8c8c' }}>{formatted.time}</div>
                  </div>
                );
              },
            },
            {
              title: '用户',
              dataIndex: 'username',
              width: 90,
              render: (username?: string) => <strong>{username || '-'}</strong>,
            },
            {
              title: '分类',
              width: 105,
              render: (_value, record) => {
                const display = fallbackDisplay(record);
                return <Tag color={categoryColors[display.category] || 'default'}>{display.category}</Tag>;
              },
            },
            {
              title: '操作',
              width: 360,
              render: (_value, record) => {
                const display = fallbackDisplay(record);
                return (
                  <div style={{ minWidth: 0, maxWidth: '100%' }}>
                    <div style={{ fontWeight: 600, marginBottom: display.target ? 3 : 0 }}>{display.operation}</div>
                    {display.target && (
                      <Typography.Text
                        type="secondary"
                        ellipsis={{ tooltip: display.target }}
                        style={{ display: 'block', maxWidth: '100%', fontSize: 12 }}
                      >
                        {display.target}
                      </Typography.Text>
                    )}
                  </div>
                );
              },
            },
            {
              title: '结果',
              width: 145,
              render: (_value, record) => {
                const display = fallbackDisplay(record);
                return (
                  <div>
                    {resultTag(display)}
                    {(record.status !== undefined || record.duration_ms !== undefined) && (
                      <div style={{ fontSize: 11, color: '#8c8c8c', marginTop: 2 }}>
                        {record.status !== undefined ? `HTTP ${record.status}` : ''}
                        {record.status !== undefined && record.duration_ms !== undefined ? ' · ' : ''}
                        {record.duration_ms !== undefined ? `${record.duration_ms}ms` : ''}
                      </div>
                    )}
                  </div>
                );
              },
            },
            {
              title: 'IP',
              dataIndex: 'ip',
              width: 155,
              render: (ip?: string) => (
                <Typography.Text code style={{ whiteSpace: 'nowrap', fontSize: 12 }}>
                  {cleanIP(ip) || '-'}
                </Typography.Text>
              ),
            },
          ]}
        />
      </Card>
    </div>
  );
};

export default AuditLogPage;
