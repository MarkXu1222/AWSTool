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
};

const actionLabels: Record<string, string> = {
  LOGIN: '登录',
  QUOTA_INCREASE: '提升配额',
  PASSWORD_CHANGE: '修改密码',
  PASSWORD_RESET: '重置密码',
  USER_CREATE: '创建用户',
  USER_DELETE: '删除用户',
};

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

  const columns = [
    {
      title: '时间', dataIndex: 'created_at', width: 150,
      render: (t: string) => <span style={{ fontSize: 12 }}>{new Date(t).toLocaleString('zh-CN')}</span>,
    },
    {
      title: '用户', dataIndex: 'username', width: 90,
      render: (u: string) => <strong>{u || '-'}</strong>,
    },
    {
      title: '操作', dataIndex: 'action', width: 100,
      render: (action: string) => <Tag color={actionColors[action] || 'default'}>{actionLabels[action] || action}</Tag>,
    },
    {
      title: '详情', dataIndex: 'detail',
      render: (d: string) => <span style={{ fontSize: 12, color: '#666' }}>{d}</span>,
    },
  ];

  return (
    <div style={{ maxWidth: 800 }}>
      <Card size="small" title="📋 审计日志" extra={<Button size="small" icon={<ReloadOutlined />} onClick={fetchLogs} loading={loading}>刷新</Button>}>
        <Table dataSource={logs} columns={columns} rowKey={(r, i) => `${r.created_at}-${i}`}
          size="small" loading={loading} pagination={{ pageSize: 20 }} scroll={{ x: 500 }} />
      </Card>
    </div>
  );
};

export default AuditLogPage;
