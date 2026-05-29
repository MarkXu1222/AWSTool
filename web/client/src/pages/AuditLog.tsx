import React, { useState, useEffect } from 'react';
import { Card, Table, Tag, message, Button } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { api } from '../api';

const actionColors: Record<string, string> = {
  LOGIN: 'blue',
  QUOTA_INCREASE: 'orange',
  PASSWORD_CHANGE: 'green',
  PASSWORD_RESET: 'red',
  USER_CREATE: 'purple',
  USER_DELETE: 'red',
  REGION_ENABLE: 'cyan',
  REGION_DISABLE: 'default',
  MFA_SETUP: 'green',
  LOGOUT: 'default',
};
const actionLabels: Record<string, string> = {
  LOGIN: '登录',
  QUOTA_INCREASE: '提升配额',
  PASSWORD_CHANGE: '修改密码',
  PASSWORD_RESET: '重置密码',
  USER_CREATE: '创建用户',
  USER_DELETE: '删除用户',
  REGION_ENABLE: '启用区域',
  REGION_DISABLE: '禁用区域',
  MFA_SETUP: '启用MFA',
  LOGOUT: '登出',
};

// Clean IPv6-mapped IPv4 addresses
function cleanIP(detail: string): string {
  if (!detail) return detail;
  return detail.replace(/::ffff:/g, '');
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
        size="small" loading={loading} pagination={{ pageSize: 20, showTotal: t => `共 ${t} 条` }} scroll={{ x: 600 }}
        columns={[
          { title: '时间', dataIndex: 'created_at', width: 155, render: (t: string) => <span style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>{new Date(t).toLocaleString('zh-CN')}</span> },
          { title: '用户', dataIndex: 'username', width: 80,
            filters: [...new Set(logs.map(l => l.username))].filter(Boolean).map(u => ({ text: u, value: u })),
            onFilter: (value: any, record: any) => record.username === value,
            render: (u: string) => <strong>{u || '-'}</strong> },
          { title: '操作', dataIndex: 'action', width: 100,
            filters: [...new Set(logs.map(l => l.action))].filter(Boolean).map(a => ({ text: actionLabels[a] || a, value: a })),
            onFilter: (value: any, record: any) => record.action === value,
            render: (a: string) => <Tag color={actionColors[a] || 'default'}>{actionLabels[a] || a}</Tag> },
          { title: '详情', dataIndex: 'detail', ellipsis: { showTitle: true }, render: (d: string) => <span style={{ fontSize: 12 }}>{cleanIP(d)}</span> },
        ]}
      />
      </Card>
    </div>
  );
};

export default AuditLogPage;
