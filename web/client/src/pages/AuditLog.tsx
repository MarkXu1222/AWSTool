import React, { useState, useEffect } from 'react';
import { Card, Table, Tag, message, Button, Tooltip } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { api } from '../api';

// action → 中文标签 & 颜色
const actionMeta: Record<string, { label: string; color: string }> = {
  LOGIN:              { label: '登录',      color: 'blue' },
  LOGOUT:             { label: '登出',      color: 'default' },
  QUOTA_INCREASE:     { label: '提升配额',  color: 'orange' },
  PASSWORD_CHANGE:    { label: '修改密码',  color: 'green' },
  PASSWORD_RESET:     { label: '重置密码',  color: 'red' },
  USER_CREATE:        { label: '创建用户',  color: 'purple' },
  USER_UPDATE:        { label: '更新用户',  color: 'geekblue' },
  USER_DELETE:        { label: '删除用户',  color: 'red' },
  REGION_ENABLE:      { label: '启用区域',  color: 'cyan' },
  REGION_BATCH_ENABLE:{ label: '批量启用区域', color: 'cyan' },
  REGION_DISABLE:     { label: '禁用区域',  color: 'default' },
  MFA_SETUP:          { label: '启用MFA',   color: 'green' },
  API_CALL:           { label: 'API 调用',  color: 'default' },
};

// method → 颜色
const methodColor: Record<string, string> = {
  GET: 'blue',
  POST: 'green',
  PUT: 'orange',
  PATCH: 'orange',
  DELETE: 'red',
};

// Clean IPv6-mapped IPv4 addresses
function cleanIP(text: string | undefined): string {
  if (!text) return text ?? '';
  return text.replace(/::ffff:/g, '');
}

// HTTP status color
function statusColor(status?: number): string {
  if (!status) return 'default';
  if (status < 300) return 'green';
  if (status < 400) return 'blue';
  if (status < 500) return 'orange';
  return 'red';
}

const AuditLogPage: React.FC = () => {
  const [logs, setLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => { fetchLogs(); }, []);

  const fetchLogs = async () => {
    setLoading(true);
    try {
      const res = await api.getAuditLog();
      if (res.success) setLogs(res.data || []);
      else setLogs(res.data || res || []);
    } catch { message.error('加载审计日志失败'); }
    finally { setLoading(false); }
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <h2 className="page-header-title">审计日志</h2>
          <p className="page-header-subtitle">查看系统操作记录和登录行为</p>
        </div>
        <Button size="small" icon={<ReloadOutlined />} onClick={fetchLogs} loading={loading}>刷新</Button>
      </div>
      <Card size="small" bodyStyle={{ padding: 0 }}>
      <Table dataSource={logs} rowKey={(r, i) => `${r.created_at}-${i}`}
        size="small" loading={loading}
        pagination={{ pageSize: 30, showTotal: t => `共 ${t} 条` }}
        scroll={{ x: 1100 }}
        columns={[
          {
            title: '时间',
            dataIndex: 'created_at',
            width: 160,
            fixed: 'left',
            render: (t: string) => (
              <span style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
                {new Date(t).toLocaleString('zh-CN')}
              </span>
            ),
          },
          {
            title: '用户',
            dataIndex: 'username',
            width: 90,
            filters: [...new Set(logs.map(l => l.username))].filter(Boolean).map(u => ({ text: u, value: u as string })),
            onFilter: (value: any, record: any) => record.username === value,
            render: (u: string) => <strong>{u || '-'}</strong>,
          },
          {
            title: '操作',
            dataIndex: 'action',
            width: 110,
            filters: [...new Set(logs.map(l => l.action))].filter(Boolean).map(a => ({
              text: actionMeta[a as string]?.label || (a as string),
              value: a as string,
            })),
            onFilter: (value: any, record: any) => record.action === value,
            render: (a: string) => {
              const meta = actionMeta[a] || { label: a, color: 'default' };
              return <Tag color={meta.color}>{meta.label}</Tag>;
            },
          },
          {
            title: 'Method',
            dataIndex: 'method',
            width: 78,
            filters: [...new Set(logs.map(l => l.method))].filter(Boolean).map(m => ({ text: m as string, value: m as string })),
            onFilter: (value: any, record: any) => record.method === value,
            render: (m?: string) => m ? <Tag color={methodColor[m] || 'default'} style={{ minWidth: 44, textAlign: 'center' }}>{m}</Tag> : '-',
          },
          {
            title: '路径',
            dataIndex: 'path',
            ellipsis: { showTitle: true },
            render: (p?: string, record?: any) => (
              <code style={{ fontSize: 12 }}>
                {p || record?.detail || '-'}
              </code>
            ),
          },
          {
            title: '状态',
            dataIndex: 'status',
            width: 70,
            render: (s?: number) => s ? <Tag color={statusColor(s)}>{s}</Tag> : '-',
          },
          {
            title: '耗时',
            dataIndex: 'duration_ms',
            width: 74,
            sorter: (a: any, b: any) => (a.duration_ms || 0) - (b.duration_ms || 0),
            render: (d?: number) => d !== undefined ? (
              <span style={{ fontSize: 12, color: d > 3000 ? '#d4380d' : d > 1000 ? '#d48806' : '#666' }}>
                {d}ms
              </span>
            ) : '-',
          },
          {
            title: '参数',
            dataIndex: 'params',
            width: 200,
            render: (p?: any, record?: any) => {
              // 优先展示 params (中间件生成的)；无则展示 detail (业务显式写的)
              if (p && typeof p === 'object' && Object.keys(p).length > 0) {
                const text = JSON.stringify(p);
                const preview = text.length > 60 ? text.slice(0, 60) + '...' : text;
                return (
                  <Tooltip title={<pre style={{ maxWidth: 400, whiteSpace: 'pre-wrap', margin: 0 }}>{JSON.stringify(p, null, 2)}</pre>}>
                    <code style={{ fontSize: 11, cursor: 'help' }}>{preview}</code>
                  </Tooltip>
                );
              }
              if (record?.detail && record.action !== 'API_CALL') {
                return <span style={{ fontSize: 12 }}>{cleanIP(record.detail)}</span>;
              }
              return '-';
            },
          },
          {
            title: 'IP',
            dataIndex: 'ip',
            width: 130,
            render: (ip: string, record: any) => {
              const val = ip || (record.detail?.match(/IP:\s*(.+)/)?.[1] || '').replace('::ffff:', '');
              return val ? <code style={{ fontSize: 11 }}>{val}</code> : '-';
            },
          },
        ]}
      />
      </Card>
    </div>
  );
};

export default AuditLogPage;
